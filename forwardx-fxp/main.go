package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

type config struct {
	Role           string `json:"role"`
	TunnelID       int    `json:"tunnelId"`
	RuleID         int    `json:"ruleId"`
	ListenPort     int    `json:"listenPort"`
	Protocol       string `json:"protocol"`
	ExitHost       string `json:"exitHost"`
	ExitPort       int    `json:"exitPort"`
	TargetIP       string `json:"targetIp"`
	TargetPort     int    `json:"targetPort"`
	Key            string `json:"key"`
	LimitIn        int64  `json:"limitIn"`
	LimitOut       int64  `json:"limitOut"`
	MaxConnections int    `json:"maxConnections"`
	MaxIPs         int    `json:"maxIPs"`
	AccessScope    string `json:"accessScope"`
	BlockHTTP      bool   `json:"blockHttp"`
	BlockSocks     bool   `json:"blockSocks"`
	BlockTLS       bool   `json:"blockTls"`
	PanelURL       string `json:"panelUrl"`
	Token          string `json:"token"`
}

type helloFrame struct {
	Network    string `json:"network"`
	TargetIP   string `json:"targetIp"`
	TargetPort int    `json:"targetPort"`
	TunnelID   int    `json:"tunnelId"`
	RuleID     int    `json:"ruleId"`
}

type protocolPolicy struct {
	BlockHTTP  bool
	BlockSocks bool
	BlockTLS   bool
}

type envelope struct {
	V   int    `json:"v"`
	IV  string `json:"iv"`
	CT  string `json:"ct"`
	MAC string `json:"mac"`
	TS  int64  `json:"ts"`
}

type secureConn struct {
	conn net.Conn
	aead cipher.AEAD
}

type connGate struct {
	maxConnections int64
	maxIPs         int
	active         atomic.Int64
	mu             sync.Mutex
	ips            map[string]int
}

func newConnGate(maxConnections, maxIPs int) *connGate {
	return &connGate{
		maxConnections: int64(maxConnections),
		maxIPs:         maxIPs,
		ips:            make(map[string]int),
	}
}

func (g *connGate) acquire(remoteAddr net.Addr) (func(), bool) {
	ip := remoteIP(remoteAddr)
	if g.maxConnections > 0 && g.active.Load() >= g.maxConnections {
		return func() {}, false
	}
	g.mu.Lock()
	if g.maxIPs > 0 && ip != "" {
		if _, ok := g.ips[ip]; !ok && len(g.ips) >= g.maxIPs {
			g.mu.Unlock()
			return func() {}, false
		}
		g.ips[ip]++
	}
	g.mu.Unlock()
	g.active.Add(1)
	var once sync.Once
	return func() {
		once.Do(func() {
			g.active.Add(-1)
			if ip == "" {
				return
			}
			g.mu.Lock()
			if g.ips[ip] <= 1 {
				delete(g.ips, ip)
			} else {
				g.ips[ip]--
			}
			g.mu.Unlock()
		})
	}, true
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	configPath := flag.String("config", "", "config file")
	flag.Parse()
	if *configPath == "" {
		log.Fatal("missing -config")
	}
	cfg, err := readConfig(*configPath)
	if err != nil {
		log.Fatalf("read config: %v", err)
	}
	if err := validateConfig(cfg); err != nil {
		log.Fatalf("invalid config: %v", err)
	}
	sec, err := newSecureConn(nil, cfg.Key)
	if err != nil {
		log.Fatalf("init crypto: %v", err)
	}
	keyed := sec.aead
	ctx := shutdownContext()
	switch strings.ToLower(cfg.Role) {
	case "entry":
		err = runEntry(ctx.done, cfg, keyed)
	case "exit":
		err = runExit(ctx.done, cfg, keyed)
	default:
		err = fmt.Errorf("unknown role %q", cfg.Role)
	}
	if err != nil && !errors.Is(err, net.ErrClosed) {
		log.Fatal(err)
	}
}

type signalContext struct {
	done <-chan struct{}
}

func shutdownContext() signalContext {
	done := make(chan struct{})
	ch := make(chan os.Signal, 2)
	signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-ch
		close(done)
	}()
	return signalContext{done: done}
}

func readConfig(path string) (config, error) {
	var cfg config
	b, err := os.ReadFile(path)
	if err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		return cfg, err
	}
	cfg.Role = strings.ToLower(strings.TrimSpace(cfg.Role))
	cfg.Protocol = normalizeProtocol(cfg.Protocol)
	cfg.TargetIP = strings.TrimSpace(cfg.TargetIP)
	cfg.ExitHost = strings.TrimSpace(cfg.ExitHost)
	return cfg, nil
}

func validateConfig(cfg config) error {
	if cfg.Key == "" {
		return errors.New("empty key")
	}
	if cfg.ListenPort <= 0 || cfg.ListenPort > 65535 {
		return fmt.Errorf("bad listen port %d", cfg.ListenPort)
	}
	if cfg.Role == "entry" {
		if cfg.ExitHost == "" || cfg.ExitPort <= 0 || cfg.ExitPort > 65535 {
			return errors.New("entry requires exit host and port")
		}
		if cfg.TargetIP == "" || cfg.TargetPort <= 0 || cfg.TargetPort > 65535 {
			return errors.New("entry requires target host and port")
		}
	}
	return nil
}

func normalizeProtocol(protocol string) string {
	switch strings.ToLower(strings.TrimSpace(protocol)) {
	case "udp":
		return "udp"
	case "both", "tcp+udp":
		return "both"
	default:
		return "tcp"
	}
}

func protocolHas(cfg config, network string) bool {
	return cfg.Protocol == "both" || cfg.Protocol == network
}

func runEntry(done <-chan struct{}, cfg config, aead cipher.AEAD) error {
	var wg sync.WaitGroup
	errCh := make(chan error, 2)
	gate := newConnGate(cfg.MaxConnections, cfg.MaxIPs)
	if protocolHas(cfg, "tcp") {
		ln, err := net.Listen("tcp", ":"+strconv.Itoa(cfg.ListenPort))
		if err != nil {
			return fmt.Errorf("entry tcp listen :%d: %w", cfg.ListenPort, err)
		}
		log.Printf("entry tcp listening on :%d tunnel=%d rule=%d", cfg.ListenPort, cfg.TunnelID, cfg.RuleID)
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-done
			_ = ln.Close()
		}()
		wg.Add(1)
		go func() {
			defer wg.Done()
			errCh <- acceptEntryTCP(ln, cfg, aead, gate)
		}()
	}
	if protocolHas(cfg, "udp") {
		addr, err := net.ResolveUDPAddr("udp", ":"+strconv.Itoa(cfg.ListenPort))
		if err != nil {
			return err
		}
		udpConn, err := net.ListenUDP("udp", addr)
		if err != nil {
			return fmt.Errorf("entry udp listen :%d: %w", cfg.ListenPort, err)
		}
		log.Printf("entry udp listening on :%d tunnel=%d rule=%d", cfg.ListenPort, cfg.TunnelID, cfg.RuleID)
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-done
			_ = udpConn.Close()
		}()
		wg.Add(1)
		go func() {
			defer wg.Done()
			errCh <- serveEntryUDP(udpConn, cfg, aead)
		}()
	}
	wg.Wait()
	select {
	case err := <-errCh:
		if errors.Is(err, net.ErrClosed) {
			return nil
		}
		return err
	default:
		return nil
	}
}

func acceptEntryTCP(ln net.Listener, cfg config, aead cipher.AEAD, gate *connGate) error {
	for {
		client, err := ln.Accept()
		if err != nil {
			return err
		}
		release, ok := gate.acquire(client.RemoteAddr())
		if !ok {
			_ = client.Close()
			continue
		}
		go func() {
			defer release()
			if err := handleEntryTCP(client, cfg, aead); err != nil && !isClosedErr(err) {
				log.Printf("entry tcp session error: %v", err)
			}
		}()
	}
}

func handleEntryTCP(client net.Conn, cfg config, aead cipher.AEAD) error {
	defer client.Close()
	var first []byte
	if cfg.BlockHTTP || cfg.BlockSocks || cfg.BlockTLS {
		_ = client.SetReadDeadline(time.Now().Add(5 * time.Second))
		buf := make([]byte, 4096)
		n, err := client.Read(buf)
		_ = client.SetReadDeadline(time.Time{})
		if err != nil {
			return err
		}
		first = append(first, buf[:n]...)
		if proto := detectBlockedProtocol(first, protocolPolicy{BlockHTTP: cfg.BlockHTTP, BlockSocks: cfg.BlockSocks, BlockTLS: cfg.BlockTLS}); proto != "" {
			reportProtocolBlock(cfg, proto)
			return nil
		}
	}
	exit, err := net.DialTimeout("tcp", net.JoinHostPort(cfg.ExitHost, strconv.Itoa(cfg.ExitPort)), 10*time.Second)
	if err != nil {
		return fmt.Errorf("dial exit: %w", err)
	}
	defer exit.Close()
	sec := &secureConn{conn: exit, aead: aead}
	hello, _ := json.Marshal(helloFrame{
		Network:    "tcp",
		TargetIP:   cfg.TargetIP,
		TargetPort: cfg.TargetPort,
		TunnelID:   cfg.TunnelID,
		RuleID:     cfg.RuleID,
	})
	if err := sec.writeFrame(hello); err != nil {
		return err
	}
	if len(first) > 0 {
		if err := sec.writeFrame(first); err != nil {
			return err
		}
	}
	errCh := make(chan error, 2)
	go func() { errCh <- copyPlainToSecure(sec, client, cfg.LimitIn) }()
	go func() { errCh <- copySecureToPlain(client, sec, cfg.LimitOut) }()
	err = <-errCh
	return err
}

func serveEntryUDP(conn *net.UDPConn, cfg config, aead cipher.AEAD) error {
	buf := make([]byte, 65535)
	for {
		n, clientAddr, err := conn.ReadFromUDP(buf)
		if err != nil {
			return err
		}
		payload := append([]byte(nil), buf[:n]...)
		go func() {
			resp, err := udpRoundTripToExit(cfg, aead, payload)
			if err != nil || len(resp) == 0 {
				if err != nil && !isClosedErr(err) {
					log.Printf("entry udp session error: %v", err)
				}
				return
			}
			_, _ = conn.WriteToUDP(resp, clientAddr)
		}()
	}
}

func udpRoundTripToExit(cfg config, aead cipher.AEAD, payload []byte) ([]byte, error) {
	exit, err := net.DialTimeout("tcp", net.JoinHostPort(cfg.ExitHost, strconv.Itoa(cfg.ExitPort)), 10*time.Second)
	if err != nil {
		return nil, err
	}
	defer exit.Close()
	sec := &secureConn{conn: exit, aead: aead}
	hello, _ := json.Marshal(helloFrame{
		Network:    "udp",
		TargetIP:   cfg.TargetIP,
		TargetPort: cfg.TargetPort,
		TunnelID:   cfg.TunnelID,
		RuleID:     cfg.RuleID,
	})
	if err := sec.writeFrame(hello); err != nil {
		return nil, err
	}
	if err := sec.writeFrame(payload); err != nil {
		return nil, err
	}
	_ = exit.SetReadDeadline(time.Now().Add(8 * time.Second))
	return sec.readFrame()
}

func runExit(done <-chan struct{}, cfg config, aead cipher.AEAD) error {
	ln, err := net.Listen("tcp", ":"+strconv.Itoa(cfg.ListenPort))
	if err != nil {
		return fmt.Errorf("exit tcp listen :%d: %w", cfg.ListenPort, err)
	}
	log.Printf("exit listening on :%d tunnel=%d", cfg.ListenPort, cfg.TunnelID)
	go func() {
		<-done
		_ = ln.Close()
	}()
	for {
		conn, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		go func() {
			if err := handleExitSession(conn, cfg, aead); err != nil && !isClosedErr(err) {
				log.Printf("exit session error: %v", err)
			}
		}()
	}
}

func handleExitSession(conn net.Conn, cfg config, aead cipher.AEAD) error {
	defer conn.Close()
	sec := &secureConn{conn: conn, aead: aead}
	frame, err := sec.readFrame()
	if err != nil {
		return err
	}
	var hello helloFrame
	if err := json.Unmarshal(frame, &hello); err != nil {
		return err
	}
	if hello.TargetIP == "" {
		hello.TargetIP = cfg.TargetIP
	}
	if hello.TargetPort <= 0 {
		hello.TargetPort = cfg.TargetPort
	}
	switch strings.ToLower(hello.Network) {
	case "udp":
		return handleExitUDP(sec, hello)
	default:
		return handleExitTCP(sec, hello)
	}
}

func handleExitTCP(sec *secureConn, hello helloFrame) error {
	target, err := net.DialTimeout("tcp", net.JoinHostPort(hello.TargetIP, strconv.Itoa(hello.TargetPort)), 10*time.Second)
	if err != nil {
		return fmt.Errorf("dial target: %w", err)
	}
	defer target.Close()
	errCh := make(chan error, 2)
	go func() { errCh <- copySecureToPlain(target, sec, 0) }()
	go func() { errCh <- copyPlainToSecure(sec, target, 0) }()
	err = <-errCh
	return err
}

func handleExitUDP(sec *secureConn, hello helloFrame) error {
	payload, err := sec.readFrame()
	if err != nil {
		return err
	}
	targetAddr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(hello.TargetIP, strconv.Itoa(hello.TargetPort)))
	if err != nil {
		return err
	}
	target, err := net.DialUDP("udp", nil, targetAddr)
	if err != nil {
		return err
	}
	defer target.Close()
	if _, err := target.Write(payload); err != nil {
		return err
	}
	_ = target.SetReadDeadline(time.Now().Add(8 * time.Second))
	buf := make([]byte, 65535)
	n, err := target.Read(buf)
	if err != nil {
		return err
	}
	return sec.writeFrame(buf[:n])
}

func copyPlainToSecure(dst *secureConn, src net.Conn, bytesPerSecond int64) error {
	buf := make([]byte, 32*1024)
	limiter := newLimiter(bytesPerSecond)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			limiter.wait(n)
			if wErr := dst.writeFrame(buf[:n]); wErr != nil {
				return wErr
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

func copySecureToPlain(dst net.Conn, src *secureConn, bytesPerSecond int64) error {
	limiter := newLimiter(bytesPerSecond)
	for {
		frame, err := src.readFrame()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		if len(frame) == 0 {
			continue
		}
		limiter.wait(len(frame))
		if _, err := dst.Write(frame); err != nil {
			return err
		}
	}
}

type limiter struct {
	rate int64
	next time.Time
}

func newLimiter(rate int64) *limiter {
	return &limiter{rate: rate}
}

func (l *limiter) wait(n int) {
	if l == nil || l.rate <= 0 || n <= 0 {
		return
	}
	delay := time.Duration(int64(time.Second) * int64(n) / l.rate)
	if delay <= 0 {
		return
	}
	now := time.Now()
	if l.next.IsZero() || l.next.Before(now) {
		l.next = now
	}
	l.next = l.next.Add(delay)
	sleepFor := time.Until(l.next)
	if sleepFor > 0 {
		time.Sleep(sleepFor)
	}
}

func newSecureConn(conn net.Conn, key string) (*secureConn, error) {
	sum := sha256.Sum256([]byte(key))
	block, err := aes.NewCipher(sum[:])
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &secureConn{conn: conn, aead: aead}, nil
}

func (c *secureConn) writeFrame(plain []byte) error {
	if len(plain) > 16*1024*1024 {
		return errors.New("frame too large")
	}
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	ciphertext := c.aead.Seal(nil, nonce, plain, nil)
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(ciphertext)))
	if _, err := writeFull(c.conn, hdr[:]); err != nil {
		return err
	}
	if _, err := writeFull(c.conn, nonce); err != nil {
		return err
	}
	_, err := writeFull(c.conn, ciphertext)
	return err
}

func (c *secureConn) readFrame() ([]byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(c.conn, hdr[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(hdr[:])
	if n == 0 || n > 16*1024*1024 {
		return nil, fmt.Errorf("invalid frame size %d", n)
	}
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := io.ReadFull(c.conn, nonce); err != nil {
		return nil, err
	}
	ciphertext := make([]byte, n)
	if _, err := io.ReadFull(c.conn, ciphertext); err != nil {
		return nil, err
	}
	return c.aead.Open(nil, nonce, ciphertext, nil)
}

func remoteIP(addr net.Addr) string {
	if addr == nil {
		return ""
	}
	host, _, err := net.SplitHostPort(addr.String())
	if err != nil {
		return addr.String()
	}
	return host
}

func detectBlockedProtocol(data []byte, policy protocolPolicy) string {
	if policy.BlockHTTP && detectHTTPProtocol(data) {
		return "http"
	}
	if policy.BlockTLS && detectTLSProtocol(data) {
		return "tls"
	}
	if policy.BlockSocks && detectSocksProtocol(data) {
		return "socks"
	}
	return ""
}

func detectHTTPProtocol(data []byte) bool {
	if len(data) >= 24 && string(data[:24]) == "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n" {
		return true
	}
	methods := []string{"GET ", "POST ", "PUT ", "DELETE ", "HEAD ", "OPTIONS ", "PATCH ", "CONNECT ", "TRACE "}
	upper := strings.ToUpper(string(data[:minInt(len(data), 16)]))
	for _, method := range methods {
		if strings.HasPrefix(upper, method) {
			return true
		}
	}
	return false
}

func detectTLSProtocol(data []byte) bool {
	return len(data) >= 5 && data[0] == 0x16 && data[1] == 0x03 && data[2] >= 0x01 && data[2] <= 0x04
}

func detectSocksProtocol(data []byte) bool {
	if len(data) < 2 {
		return false
	}
	if data[0] == 0x04 {
		return len(data) >= 7 && (data[1] == 0x01 || data[1] == 0x02)
	}
	if data[0] != 0x05 {
		return false
	}
	nMethods := int(data[1])
	if nMethods <= 0 || len(data) < 2+nMethods {
		return false
	}
	for _, method := range data[2 : 2+nMethods] {
		if method == 0x00 || method == 0x02 {
			return true
		}
	}
	return false
}

func reportProtocolBlock(cfg config, proto string) {
	if cfg.PanelURL == "" || cfg.Token == "" || cfg.RuleID <= 0 {
		log.Printf("protocol blocked rule=%d tunnel=%d protocol=%s", cfg.RuleID, cfg.TunnelID, proto)
		return
	}
	payload := map[string]any{
		"ruleId":     cfg.RuleID,
		"tunnelId":   cfg.TunnelID,
		"sourcePort": cfg.ListenPort,
		"protocol":   proto,
	}
	env, err := encryptEnvelope(payload, cfg.Token)
	if err != nil {
		log.Printf("protocol block encrypt failed: %v", err)
		return
	}
	body, _ := json.Marshal(env)
	req, err := http.NewRequest("POST", strings.TrimRight(cfg.PanelURL, "/")+"/api/agent/protocol-block", bytes.NewReader(body))
	if err != nil {
		log.Printf("protocol block request failed: %v", err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Agent-Encrypted", "1")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("protocol block report failed: %v", err)
		return
	}
	_ = resp.Body.Close()
	log.Printf("protocol block reported rule=%d tunnel=%d protocol=%s status=%s", cfg.RuleID, cfg.TunnelID, proto, resp.Status)
}

func encryptEnvelope(payload any, token string) (envelope, error) {
	plain, _ := json.Marshal(payload)
	keyEnc := sha256.Sum256([]byte(token + "|forwardx-agent-v1"))
	keyMac := sha256.Sum256([]byte(token + "|forwardx-agent-mac"))
	iv := make([]byte, aes.BlockSize)
	if _, err := rand.Read(iv); err != nil {
		return envelope{}, err
	}
	block, err := aes.NewCipher(keyEnc[:])
	if err != nil {
		return envelope{}, err
	}
	ct := make([]byte, len(plain))
	cipher.NewCTR(block, iv).XORKeyStream(ct, plain)
	ts := time.Now().UnixMilli()
	mac := calcMAC(keyMac[:], iv, ct, ts)
	return envelope{V: 1, IV: hex.EncodeToString(iv), CT: hex.EncodeToString(ct), MAC: hex.EncodeToString(mac), TS: ts}, nil
}

func calcMAC(key, iv, ct []byte, ts int64) []byte {
	buf := bytes.NewBufferString("v1")
	buf.Write(iv)
	buf.Write(ct)
	tsb := make([]byte, 8)
	binary.BigEndian.PutUint64(tsb, uint64(ts))
	buf.Write(tsb)
	m := hmac.New(sha256.New, key)
	m.Write(buf.Bytes())
	return m.Sum(nil)
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func writeFull(w io.Writer, b []byte) (int, error) {
	written := 0
	for written < len(b) {
		n, err := w.Write(b[written:])
		written += n
		if err != nil {
			return written, err
		}
		if n == 0 {
			return written, io.ErrShortWrite
		}
	}
	return written, nil
}

func isClosedErr(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "use of closed network connection") ||
		strings.Contains(msg, "connection reset by peer") ||
		strings.Contains(msg, "broken pipe")
}
