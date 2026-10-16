package v3

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

// httpTCPPair returns a real TCP pair. net.Pipe is synchronous and unbuffered,
// so a preface writer and the server reader cannot both block; TCP also matches
// how the transport is used in production.
func httpTCPPair(t *testing.T) (net.Conn, net.Conn) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	type accepted struct {
		conn net.Conn
		err  error
	}
	ch := make(chan accepted, 1)
	go func() {
		conn, err := listener.Accept()
		ch <- accepted{conn, err}
	}()
	client, err := net.DialTimeout("tcp", listener.Addr().String(), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	result := <-ch
	if result.err != nil {
		client.Close()
		t.Fatal(result.err)
	}
	t.Cleanup(func() { client.Close(); result.conn.Close() })
	return client, result.conn
}

func TestHTTPRequestGolden(t *testing.T) {
	// The request shape follows the recovered reference template
	// "%s %s HTTP/1.1\r\nUser-Agent: %s\r\n" (0x104f501). The reference sends no
	// Host header on this path.
	plain, err := HTTPRequest("example.test", "test", "", false, "")
	if err != nil {
		t.Fatal(err)
	}
	wantPlain := "GET /test HTTP/1.1\r\nUser-Agent: " + DefaultUserAgent + "\r\n\r\n"
	if string(plain) != wantPlain {
		t.Fatalf("http preface\n got %q\nwant %q", plain, wantPlain)
	}
	if bytes.Contains(plain, []byte("Host:")) {
		t.Fatal("reference sends no Host header on this path")
	}
	request, err := http.ReadRequest(bufio.NewReader(bytes.NewReader(plain)))
	if err != nil || request.URL.Path != "/test" {
		t.Fatalf("request=%+v err=%v", request, err)
	}
	if request.Header.Get("User-Agent") != DefaultUserAgent {
		t.Fatal("user agent missing")
	}

	// WS style adds the standard upgrade headers plus the key that the server
	// echoes in Sec-WebSocket-Accept.
	key, err := newWSKey()
	if err != nil {
		t.Fatal(err)
	}
	ws, err := HTTPRequest("example.test", "test", "custom-agent", true, key)
	if err != nil {
		t.Fatal(err)
	}
	wantWS := "GET /test HTTP/1.1\r\nUser-Agent: custom-agent\r\n" +
		"Connection: upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " + key + "\r\n\r\n"
	if string(ws) != wantWS {
		t.Fatalf("ws preface\n got %q\nwant %q", ws, wantWS)
	}
	wsRequest, err := http.ReadRequest(bufio.NewReader(bytes.NewReader(ws)))
	if err != nil || wsRequest.Header.Get("Sec-WebSocket-Key") != key {
		t.Fatalf("ws request=%+v err=%v", wsRequest, err)
	}

	if p, err := HTTPRequest("", "", "", false, ""); err != nil ||
		string(p) != "GET / HTTP/1.1\r\nUser-Agent: "+DefaultUserAgent+"\r\n\r\n" {
		t.Fatalf("empty defaults: %q %v", p, err)
	}
	for _, p := range [][3]string{
		{"host\r\nInjected: yes", "/", ""},
		{"host", "/\r\n", ""},
		{"host", "/has space", ""},
		{"host", "/", "agent\r\nInjected: yes"},
	} {
		if _, err := HTTPRequest(p[0], p[1], p[2], true, "key"); err == nil {
			t.Fatalf("accepted invalid host/path/agent: %q", p)
		}
	}
	if _, err := HTTPRequest("host", strings.Repeat("a", maxHTTPHeader), "", false, ""); !errors.Is(err, ErrHTTPHeaderTooLarge) {
		t.Fatal(err)
	}
}

func TestWSAcceptMatchesRFC6455(t *testing.T) {
	// RFC 6455 section 1.3 example.
	got := wsAccept("dGhlIHNhbXBsZSBub25jZQ==")
	if got != "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" {
		t.Fatalf("accept mismatch: %q", got)
	}
}

func TestHTTPClientLazyResponseAndRawPayload(t *testing.T) {
	for _, response := range []string{
		"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
		"HTTP/1.1 200 OK\r\n\r\n",
	} {
		t.Run(response[:12], func(t *testing.T) {
			client, server := net.Pipe()
			defer client.Close()
			defer server.Close()
			client.SetDeadline(time.Now().Add(3 * time.Second))
			server.SetDeadline(time.Now().Add(3 * time.Second))
			serverErr := make(chan error, 1)
			// Contains bytes invalid as RFC 6455 frames. They must remain unchanged.
			payload := []byte{0, 255, 1, 2, 3, 0, 0, 7}
			go func() {
				r := bufio.NewReader(server)
				if _, err := http.ReadRequest(r); err != nil {
					serverErr <- err
					return
				}
				// Server waits for the inner initialisation before responding.
				got := make([]byte, len(payload))
				if _, err := io.ReadFull(r, got); err != nil {
					serverErr <- err
					return
				}
				if !bytes.Equal(got, payload) {
					serverErr <- errors.New("client write was not raw")
					return
				}
				// Coalesce response and first payload to check buffered bytes survive.
				serverErr <- writeFull(server, append([]byte(response), payload...))
			}()
			wrapped, err := HTTPClient(client, "example.test", "/", "", true)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := wrapped.Write(payload); err != nil {
				t.Fatal(err)
			}
			got := make([]byte, len(payload))
			if _, err := io.ReadFull(wrapped, got); err != nil || !bytes.Equal(got, payload) {
				t.Fatalf("got=%x err=%v", got, err)
			}
			if err := <-serverErr; err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestHTTPClientRejectsBrokenOrUnboundedResponse(t *testing.T) {
	for _, wire := range []string{
		"not HTTP\r\n\r\n",
		"HTTP/1.1 101 OK\r\nX: " + strings.Repeat("x", maxHTTPHeader),
		"HTTP/1.1 101 OK\r\nX: incomplete",
	} {
		client, server := net.Pipe()
		client.SetDeadline(time.Now().Add(3 * time.Second))
		server.SetDeadline(time.Now().Add(3 * time.Second))
		done := make(chan struct{})
		go func() {
			defer close(done)
			defer server.Close()
			if _, err := http.ReadRequest(bufio.NewReader(server)); err == nil {
				writeFull(server, []byte(wire))
			}
		}()
		wrapped, err := HTTPClient(client, "example.test", "/", "", false)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := wrapped.Read(make([]byte, 1)); err == nil {
			t.Fatal("invalid response accepted")
		}
		client.Close()
		<-done
	}
}

// TestHTTPClientRejectsWrongWSAccept checks that a server which answers the
// WS-style handshake with the wrong Sec-WebSocket-Accept is rejected.
func TestHTTPClientRejectsWrongWSAccept(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	client.SetDeadline(time.Now().Add(3 * time.Second))
	server.SetDeadline(time.Now().Add(3 * time.Second))
	done := make(chan struct{})
	go func() {
		defer close(done)
		if _, err := http.ReadRequest(bufio.NewReader(server)); err != nil {
			return
		}
		writeFull(server, []byte("HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: wrong\r\n\r\n"))
	}()
	wrapped, err := HTTPClient(client, "example.test", "/", "", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := wrapped.Read(make([]byte, 1)); err == nil {
		t.Fatal("wrong Sec-WebSocket-Accept accepted")
	}
	client.Close()
	<-done
}

func TestHTTPServerWSHandshakeEmitsAccept(t *testing.T) {
	client, server := httpTCPPair(t)
	server.SetDeadline(time.Now().Add(3 * time.Second))
	client.SetDeadline(time.Now().Add(3 * time.Second))
	key := "dGhlIHNhbXBsZSBub25jZQ=="
	preface := "GET /entry HTTP/1.1\r\nUser-Agent: agent\r\nConnection: upgrade\r\nUpgrade: websocket\r\n" +
		"Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " + key + "\r\n\r\n"
	go func() { _ = writeFull(client, []byte(preface+"inner")) }()
	wrapped, err := HTTPServer(server, "", "/entry", true)
	if err != nil {
		t.Fatal(err)
	}
	// Reading on the server side triggers the handshake response towards the
	// client and returns the payload that was already buffered.
	buf := make([]byte, 64)
	n, err := wrapped.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != "inner" {
		t.Fatalf("server-side payload corrupted: %q", buf[:n])
	}
	// The client must have received the full reference response literal.
	response := make([]byte, 4096)
	rn, err := client.Read(response)
	if err != nil {
		t.Fatalf("client did not receive the handshake response: %v", err)
	}
	got := string(response[:rn])
	want := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + wsAccept(key) + "\r\n\r\n"
	if got != want {
		t.Fatalf("handshake response mismatch\n got %q\nwant %q", got, want)
	}
}

// TestHTTPServerWithholdsResponseUntilPeerSends proves the response is not sent
// before the peer produces its inner initialisation.
func TestHTTPServerWithholdsResponseUntilPeerSends(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	server.SetReadDeadline(time.Now().Add(3 * time.Second))
	key := "dGhlIHNhbXBsZSBub25jZQ=="
	preface := "GET / HTTP/1.1\r\nConnection: upgrade\r\nUpgrade: websocket\r\n" +
		"Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " + key + "\r\n\r\n"
	// A background reader drains anything the server writes, so the synchronous
	// pipe can never deadlock the server's response write.
	received := make(chan string, 8)
	go func() {
		buf := make([]byte, 4096)
		for {
			client.SetReadDeadline(time.Now().Add(2 * time.Second))
			n, err := client.Read(buf)
			if n > 0 {
				received <- string(buf[:n])
			}
			if err != nil {
				return
			}
		}
	}()
	go func() { _ = writeFull(client, []byte(preface)) }()
	wrapped, err := HTTPServer(server, "", "/", true)
	if err != nil {
		t.Fatal(err)
	}
	// Nothing may arrive before the peer sends its initialisation.
	select {
	case data := <-received:
		t.Fatalf("server answered before the peer sent its initialisation: %q", data)
	case <-time.After(150 * time.Millisecond):
	}
	// Once the peer sends bytes the response appears on first read.
	readErr := make(chan error, 1)
	go func() {
		buf := make([]byte, 1)
		_, err := wrapped.Read(buf)
		readErr <- err
	}()
	go func() { _ = writeFull(client, []byte("x")) }()
	select {
	case data := <-received:
		if !strings.HasPrefix(data, "HTTP/1.1 101 Switching Protocols") {
			t.Fatalf("unexpected response: %q", data)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("response never arrived after the peer sent data")
	}
	if err := <-readErr; err != nil {
		t.Fatalf("read after peer data failed: %v", err)
	}
}

func TestHTTPServerPreservesCoalescedPrefaceAndPayload(t *testing.T) {
	client, server := httpTCPPair(t)
	server.SetDeadline(time.Now().Add(3 * time.Second))
	preface, _ := HTTPRequest("example.test", "/entry", "", false, "")
	payload := bytes.Repeat([]byte{255, 0, 7, 9}, 2000)
	done := make(chan error, 1)
	go func() { done <- writeFull(client, append(preface, payload...)) }()
	wrapped, err := HTTPServer(server, "", "/entry", false)
	if err != nil {
		t.Fatal(err)
	}
	got := make([]byte, len(payload))
	if _, err := io.ReadFull(wrapped, got); err != nil || !bytes.Equal(payload, got) {
		t.Fatalf("coalesced data corrupted: length=%d err=%v", len(got), err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestHTTPServerIncompletePrefaceRespectsDeadline(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	server.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
	done := make(chan error, 1)
	go func() { done <- writeFull(client, []byte("GET / HTTP/1.1\r\nUser-Agent: incomplete")) }()
	if _, err := HTTPServer(server, "", "/", false); err == nil {
		t.Fatal("incomplete preface accepted")
	} else if e, ok := err.(net.Error); !ok || !e.Timeout() {
		t.Fatalf("expected bounded read timeout, got %v", err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
