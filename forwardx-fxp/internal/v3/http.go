package v3

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
)

const maxHTTPHeader = 32 << 10

// wsGUID is the RFC 6455 handshake constant.
const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// DefaultUserAgent matches the reference request template, which was recovered
// as "%s %s HTTP/1.1\r\nUser-Agent: %s\r\n" at 0x104f501. The reference sends no
// Host header on this path.
const DefaultUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

var ErrHTTPHeaderTooLarge = errors.New("v3: HTTP handshake header too large")

// wsAccept computes the RFC 6455 Sec-WebSocket-Accept value. The reference sends
// this header from the server side (literal at 0x108480d, followed by the
// crypto/hmac package name), so the handshake is a real WebSocket handshake even
// though the data frames afterwards are not RFC 6455 frames.
func wsAccept(key string) string {
	sum := sha1.Sum([]byte(key + wsGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

// newWSKey returns a fresh base64 16-byte client key.
func newWSKey() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(raw), nil
}

// validHeaderValue rejects values that could inject or break headers. Spaces and
// tabs are rejected too: they are legal inside a header value but not inside a
// request target or a Host, and the same helper guards all three.
func validHeaderValue(value string) bool {
	return !strings.ContainsAny(value, "\r\n\x00\t ")
}

// HTTPRequest constructs the verified HTTP/WS-style preface. The shape follows
// the recovered reference template: request line, User-Agent, optional WS
// upgrade headers, terminating CRLF. WS-style is NOT RFC 6455 for data frames:
// after the handshake the tunnel carries its own byte stream.
//
// wsKey is the base64 Sec-WebSocket-Key; it is only emitted for wsStyle.
func HTTPRequest(host, path, userAgent string, wsStyle bool, wsKey string) ([]byte, error) {
	if !validHeaderValue(host) || !validHeaderValue(path) || !validHeaderValue(userAgent) {
		return nil, errors.New("v3: invalid HTTP handshake host, path or user agent")
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	if userAgent == "" {
		userAgent = DefaultUserAgent
	}
	var b strings.Builder
	fmt.Fprintf(&b, "GET %s HTTP/1.1\r\n", path)
	fmt.Fprintf(&b, "User-Agent: %s\r\n", userAgent)
	if wsStyle {
		fmt.Fprintf(&b, "Connection: upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: %s\r\n", wsKey)
	}
	b.WriteString("\r\n")
	if b.Len() > maxHTTPHeader {
		return nil, ErrHTTPHeaderTooLarge
	}
	return []byte(b.String()), nil
}

// HTTPClient sends the preface and returns a raw connection. The response is
// consumed only on first Read; waiting here would deadlock a server that waits
// for the inner handshake before responding. The caller owns conn and must set a
// handshake deadline covering the subsequent authentication.
func HTTPClient(conn net.Conn, host, path, userAgent string, wsStyle bool) (net.Conn, error) {
	wsKey := ""
	if wsStyle {
		var err error
		if wsKey, err = newWSKey(); err != nil {
			return nil, err
		}
	}
	preface, err := HTTPRequest(host, path, userAgent, wsStyle, wsKey)
	if err != nil {
		return nil, err
	}
	if err = writeFull(conn, preface); err != nil {
		return nil, err
	}
	return &httpClientConn{Conn: conn, reader: bufio.NewReader(conn), wsKey: wsKey, wsStyle: wsStyle}, nil
}

type httpClientConn struct {
	net.Conn
	reader  *bufio.Reader
	wsKey   string
	wsStyle bool
	once    sync.Once
	err     error
}

func (c *httpClientConn) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	c.once.Do(func() {
		header, err := readHTTPHeader(c.reader)
		if err != nil {
			c.err = err
			return
		}
		// The reference checks ReadResponse's error, not the status code. Inner
		// authenticated framing is what actually validates the peer.
		response, err := http.ReadResponse(bufio.NewReader(bytes.NewReader(header)), nil)
		if err != nil {
			c.err = err
			return
		}
		// For the WS-style handshake the reference server sends
		// Sec-WebSocket-Accept, so verify it when present. A missing header is
		// tolerated because the inner handshake is the security boundary.
		if c.wsStyle {
			if accept := response.Header.Get("Sec-WebSocket-Accept"); accept != "" && accept != wsAccept(c.wsKey) {
				c.err = errors.New("v3: WS-style handshake accept mismatch")
			}
		}
	})
	if c.err != nil {
		return 0, c.err
	}
	return c.reader.Read(p)
}

func readHTTPHeader(r *bufio.Reader) ([]byte, error) {
	var header []byte
	for {
		line, err := r.ReadSlice('\n')
		if len(header)+len(line) > maxHTTPHeader {
			return nil, ErrHTTPHeaderTooLarge
		}
		header = append(header, line...)
		if err == bufio.ErrBufferFull {
			continue
		}
		if err != nil {
			return nil, err
		}
		if bytes.HasSuffix(header, []byte("\r\n\r\n")) || bytes.HasSuffix(header, []byte("\n\n")) {
			return header, nil
		}
	}
}

// HTTPServer consumes only the request header and preserves coalesced inner
// bytes. For the WS-style handshake it answers with a real RFC 6455 upgrade
// response carrying Sec-WebSocket-Accept, matching the recovered reference
// literal at 0x108480d.
//
// The response is withheld until the first Read, so a peer that sends a preface
// and then goes silent never receives a success response and the handshake
// deadline stays effective. This ordering is a ForwardX policy; the reference's
// own timing has not been recovered.
func HTTPServer(conn net.Conn, host, path string, wsStyle bool) (net.Conn, error) {
	if _, err := HTTPRequest(host, path, "", wsStyle, ""); err != nil {
		return nil, err
	}
	r := bufio.NewReader(conn)
	header, err := readHTTPHeader(r)
	if err != nil {
		return nil, err
	}
	request, err := http.ReadRequest(bufio.NewReader(bytes.NewReader(header)))
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	if request.Method != "GET" || request.URL.RequestURI() != path {
		return nil, errors.New("v3: HTTP preface does not match tunnel configuration")
	}
	var response string
	if wsStyle {
		key := request.Header.Get("Sec-WebSocket-Key")
		if !strings.EqualFold(request.Header.Get("Connection"), "upgrade") ||
			!strings.EqualFold(request.Header.Get("Upgrade"), "websocket") ||
			key == "" {
			return nil, errors.New("v3: missing WS-style upgrade headers")
		}
		// Header order and spelling follow the recovered reference literal.
		response = "HTTP/1.1 101 Switching Protocols\r\n" +
			"Upgrade: websocket\r\n" +
			"Connection: Upgrade\r\n" +
			"Sec-WebSocket-Accept: " + wsAccept(key) + "\r\n\r\n"
	} else {
		response = "HTTP/1.1 200 OK\r\n\r\n"
	}
	return &httpServerConn{Conn: conn, reader: r, response: []byte(response)}, nil
}

type httpServerConn struct {
	net.Conn
	reader   *bufio.Reader
	response []byte
	writeMu  sync.Mutex
	err      error
}

func (c *httpServerConn) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	// Send the handshake response on first read: by then the peer has produced
	// its inner initialisation, so an idle or unauthenticated probe is never
	// answered with a success status.
	c.writeMu.Lock()
	if c.response != nil && c.err == nil {
		c.err = writeFull(c.Conn, c.response)
		c.response = nil
	}
	err := c.err
	c.writeMu.Unlock()
	if err != nil {
		return 0, err
	}
	return c.reader.Read(p)
}

func (c *httpServerConn) Write(p []byte) (int, error) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.err != nil {
		return 0, c.err
	}
	if c.response != nil {
		c.err = writeFull(c.Conn, c.response)
		c.response = nil
		if c.err != nil {
			return 0, c.err
		}
	}
	return c.Conn.Write(p)
}

var _ io.ReadWriteCloser = (*httpClientConn)(nil)
