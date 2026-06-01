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

	"lukechampine.com/blake3"
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
	FXPVersion     int    `json:"fxpVersion"`
	RelayExitHost  string `json:"relayExitHost,omitempty"`
	RelayExitPort  int    `json:"relayExitPort,omitempty"`
	RelayKey       string `json:"relayKey,omitempty"`
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

type trafficCounter struct {
	in  atomic.Uint64
	out atomic.Uint64
}

type v2Handshake struct {
	V        int   `json:"v"`
	TS       int64 `json:"ts"`
	TunnelID int   `json:"tunnelId"`
}

type secureConn struct {
	conn          net.Conn
	aead          cipher.AEAD
	lenWriteAEAD  cipher.AEAD
	dataWriteAEAD cipher.AEAD
	lenReadAEAD   cipher.AEAD
	dataReadAEAD  cipher.AEAD
	version       int
	writeDir      uint32
	readDir       uint32
	writeCounter  uint64
	readCounter   uint64
}

type replayCache struct {
	ttl       time.Duration
	max       int
	mu        sync.Mutex
	seen      map[string]time.Time
	lastSweep time.Time
}

const (
	fxpVersionV1 = 1
	fxpVersionV2 = 2

	fxpV2SaltSize        = 32
	fxpV2MaxFrame        = 16 * 1024 * 1024
	fxpV2EntryToExit     = uint32(1)
	fxpV2ExitToEntry     = uint32(2)
	fxpV2HandshakeWindow = 5 * time.Minute
	fxpTCPKeepAlive      = 30 * time.Second
	fxpHalfCloseLinger   = 30 * time.Second
)

var (
	fxpV2Info     = []byte("forwardx-fxp-v2 session")
	fxpV2LenAD    = []byte("forwardx-fxp-v2 length")
	fxpV2DataAD   = []byte("forwardx-fxp-v2 payload")
	fxpReplaySeen = newReplayCache(fxpV2HandshakeWindow, 100000)
)

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
	baseAEAD := sec.aead
	ctx := shutdownContext()
	switch strings.ToLower(cfg.Role) {
	case "entry":
		err = runEntry(ctx.done, cfg, baseAEAD)
	case "exit":
		err = runExit(ctx.done, cfg, baseAEAD)
	case "relay":
		err = runRelay(ctx.done, cfg, baseAEAD)
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
	if cfg.FXPVersion != fxpVersionV2 {
		cfg.FXPVersion = fxpVersionV1
	}
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

func dialTCP(host string, port int, timeout time.Duration) (net.Conn, error) {
	d := net.Dialer{Timeout: timeout, KeepAlive: fxpTCPKeepAlive}
	conn, err := d.Dial("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	enableTCPKeepAlive(conn)
	return conn, nil
}

func enableTCPKeepAlive(conn net.Conn) {
	tcp, ok := conn.(*net.TCPConn)
	if !ok {
		return
	}
	_ = tcp.SetNoDelay(true)
	_ = tcp.SetKeepAlive(true)
	_ = tcp.SetKeepAlivePeriod(fxpTCPKeepAlive)
}

func closeWriteConn(conn net.Conn) {
	if tcp, ok := conn.(*net.TCPConn); ok {
		_ = tcp.CloseWrite()
	}
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
		enableTCPKeepAlive(client)
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
	exit, err := dialTCP(cfg.ExitHost, cfg.ExitPort, 10*time.Second)
	if err != nil {
		return fmt.Errorf("dial exit: %w", err)
	}
	defer exit.Close()
	sec, err := newEntrySecureConn(exit, cfg, aead)
	if err != nil {
		return err
	}
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
	counter := &trafficCounter{}
	counter.in.Add(uint64(len(first)))
	stopReporting := startTrafficReporter(cfg, counter)
	defer stopReporting()
	return proxyPlainSecure(client, sec, cfg.LimitIn, cfg.LimitOut, counter)
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
	exit, err := dialTCP(cfg.ExitHost, cfg.ExitPort, 10*time.Second)
	if err != nil {
		return nil, err
	}
	defer exit.Close()
	sec, err := newEntrySecureConn(exit, cfg, aead)
	if err != nil {
		return nil, err
	}
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
	resp, err := sec.readFrame()
	if err == nil {
		reportTraffic(cfg, uint64(len(payload)), uint64(len(resp)))
	}
	return resp, err
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
		enableTCPKeepAlive(conn)
		go func() {
			if err := handleExitSession(conn, cfg, aead); err != nil && !isClosedErr(err) {
				log.Printf("exit session error: %v", err)
			}
		}()
	}
}

func handleExitSession(conn net.Conn, cfg config, aead cipher.AEAD) error {
	defer conn.Close()
	sec, err := newExitSecureConn(conn, cfg, aead)
	if err != nil {
		probeDelay()
		return err
	}
	frame, err := sec.readFrame()
	if err != nil {
		probeDelay()
		return err
	}
	var hello helloFrame
	if err := json.Unmarshal(frame, &hello); err != nil {
		probeDelay()
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
	target, err := dialTCP(hello.TargetIP, hello.TargetPort, 10*time.Second)
	if err != nil {
		return fmt.Errorf("dial target: %w", err)
	}
	defer target.Close()
	return proxyPlainSecure(target, sec, 0, 0, nil)
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

// runRelay acts as an intermediate hop in a multi-hop FXP chain.
// It listens for encrypted connections from the upstream, reads the helloFrame,
// connects to the next downstream hop with a new key, re-sends the helloFrame,
// and bidirectionally relays decrypted frames between the two secure connections.
func runRelay(done <-chan struct{}, cfg config, upstreamAEAD cipher.AEAD) error {
	if cfg.RelayExitHost == "" || cfg.RelayExitPort <= 0 || cfg.RelayKey == "" {
		return fmt.Errorf("relay requires relayExitHost, relayExitPort, and relayKey")
	}
	ln, err := net.Listen("tcp", ":"+strconv.Itoa(cfg.ListenPort))
	if err != nil {
		return fmt.Errorf("relay tcp listen :%d: %w", cfg.ListenPort, err)
	}
	log.Printf("relay listening on :%d tunnel=%d next=%s:%d", cfg.ListenPort, cfg.TunnelID, cfg.RelayExitHost, cfg.RelayExitPort)
	go func() {
		<-done
		_ = ln.Close()
	}()
	downSec, err := newSecureConn(nil, cfg.RelayKey)
	if err != nil {
		return fmt.Errorf("relay downstream crypto: %w", err)
	}
	downstreamAEAD := downSec.aead
	for {
		upConn, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		enableTCPKeepAlive(upConn)
		go func() {
			if err := handleRelaySession(upConn, cfg, upstreamAEAD, downstreamAEAD); err != nil && !isClosedErr(err) {
				log.Printf("relay session error: %v", err)
			}
		}()
	}
}

func handleRelaySession(upConn net.Conn, cfg config, upstreamAEAD, downstreamAEAD cipher.AEAD) error {
	defer upConn.Close()
	// Accept upstream encrypted connection (like exit)
	upSec, err := newExitSecureConn(upConn, cfg, upstreamAEAD)
	if err != nil {
		probeDelay()
		return err
	}
	frame, err := upSec.readFrame()
	if err != nil {
		probeDelay()
		return err
	}
	var hello helloFrame
	if err := json.Unmarshal(frame, &hello); err != nil {
		probeDelay()
		return err
	}
	// Connect to downstream (like entry)
	downConn, err := dialTCP(cfg.RelayExitHost, cfg.RelayExitPort, 10*time.Second)
	if err != nil {
		log.Printf("relay dial downstream %s:%d: %v", cfg.RelayExitHost, cfg.RelayExitPort, err)
		return err
	}
	defer downConn.Close()
	downCfg := cfg
	downCfg.Key = cfg.RelayKey
	downSec, err := newEntrySecureConn(downConn, downCfg, downstreamAEAD)
	if err != nil {
		return err
	}
	// Re-send helloFrame to downstream
	helloBytes, _ := json.Marshal(hello)
	if err := downSec.writeFrame(helloBytes); err != nil {
		return err
	}
	// Bidirectional relay: upstream ↔ downstream
	return relayBidir(upSec, downSec)
}

func relayBidir(up *secureConn, down *secureConn) error {
	errCh := make(chan error, 2)
	go func() { errCh <- relayCopy(up, down) }()
	go func() { errCh <- relayCopy(down, up) }()
	return waitBidirectional(errCh, func() {
		_ = up.conn.Close()
		_ = down.conn.Close()
	})
}

func relayCopy(src, dst *secureConn) error {
	for {
		frame, err := src.readFrame()
		if err != nil {
			return err
		}
		if len(frame) == 0 {
			return dst.writeFrame(nil)
		}
		if err := dst.writeFrame(frame); err != nil {
			return err
		}
	}
}

func proxyPlainSecure(plain net.Conn, sec *secureConn, inLimit, outLimit int64, counter *trafficCounter) error {
	errCh := make(chan error, 2)
	var inCounter, outCounter *atomic.Uint64
	if counter != nil {
		inCounter = &counter.in
		outCounter = &counter.out
	}
	go func() { errCh <- copyPlainToSecure(sec, plain, inLimit, inCounter) }()
	go func() { errCh <- copySecureToPlain(plain, sec, outLimit, outCounter) }()
	return waitBidirectional(errCh, func() {
		_ = plain.Close()
		_ = sec.conn.Close()
	})
}

func waitBidirectional(errCh <-chan error, closeAll func()) error {
	first := <-errCh
	if first != nil && !isClosedErr(first) {
		closeAll()
		return first
	}
	timer := time.NewTimer(fxpHalfCloseLinger)
	defer timer.Stop()
	select {
	case second := <-errCh:
		if second != nil && !isClosedErr(second) {
			closeAll()
			return second
		}
		return nil
	case <-timer.C:
		closeAll()
		if first != nil && !isClosedErr(first) {
			return first
		}
		return nil
	}
}

func copyPlainToSecure(dst *secureConn, src net.Conn, bytesPerSecond int64, counter *atomic.Uint64) error {
	buf := make([]byte, 32*1024)
	limiter := newLimiter(bytesPerSecond)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			limiter.wait(n)
			if wErr := dst.writeFrame(buf[:n]); wErr != nil {
				return wErr
			}
			if counter != nil {
				counter.Add(uint64(n))
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return dst.writeFrame(nil)
			}
			return err
		}
	}
}

func copySecureToPlain(dst net.Conn, src *secureConn, bytesPerSecond int64, counter *atomic.Uint64) error {
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
			closeWriteConn(dst)
			return nil
		}
		limiter.wait(len(frame))
		if _, err := dst.Write(frame); err != nil {
			return err
		}
		if counter != nil {
			counter.Add(uint64(len(frame)))
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
	return &secureConn{conn: conn, aead: aead, version: fxpVersionV1}, nil
}

func newAEAD(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func newEntrySecureConn(conn net.Conn, cfg config, base cipher.AEAD) (*secureConn, error) {
	if cfg.FXPVersion == fxpVersionV1 {
		return &secureConn{conn: conn, aead: base, version: fxpVersionV1}, nil
	}
	sec, err := newV2ClientSecureConn(conn, cfg)
	if err == nil {
		return sec, nil
	}
	_ = conn.Close()
	return nil, err
}

func newExitSecureConn(conn net.Conn, cfg config, base cipher.AEAD) (*secureConn, error) {
	if cfg.FXPVersion == fxpVersionV1 {
		return &secureConn{conn: conn, aead: base, version: fxpVersionV1}, nil
	}
	return newV2ServerSecureConn(conn, cfg)
}

func newV2ClientSecureConn(conn net.Conn, cfg config) (*secureConn, error) {
	salt := make([]byte, fxpV2SaltSize)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	if _, err := writeFull(conn, salt); err != nil {
		return nil, err
	}
	sec, err := newV2SecureConn(conn, cfg.Key, salt, true)
	if err != nil {
		return nil, err
	}
	hs, _ := json.Marshal(v2Handshake{V: fxpVersionV2, TS: time.Now().Unix(), TunnelID: cfg.TunnelID})
	if err := sec.writeFrame(hs); err != nil {
		return nil, err
	}
	ack, err := sec.readFrame()
	if err != nil {
		return nil, err
	}
	var reply v2Handshake
	if err := json.Unmarshal(ack, &reply); err != nil || reply.V != fxpVersionV2 || reply.TunnelID != cfg.TunnelID {
		return nil, errors.New("fxp v2 handshake rejected")
	}
	return sec, nil
}

func newV2ServerSecureConn(conn net.Conn, cfg config) (*secureConn, error) {
	salt := make([]byte, fxpV2SaltSize)
	if _, err := io.ReadFull(conn, salt); err != nil {
		return nil, err
	}
	if !fxpReplaySeen.Add(replayKey(cfg, salt)) {
		return nil, errors.New("fxp v2 replay detected")
	}
	sec, err := newV2SecureConn(conn, cfg.Key, salt, false)
	if err != nil {
		return nil, err
	}
	ack, err := sec.readFrame()
	if err != nil {
		return nil, err
	}
	var hs v2Handshake
	if err := json.Unmarshal(ack, &hs); err != nil || hs.V != fxpVersionV2 || hs.TunnelID != cfg.TunnelID {
		return nil, errors.New("fxp v2 handshake rejected")
	}
	if hs.TS <= 0 {
		return nil, errors.New("fxp v2 handshake rejected")
	}
	if ts := time.Unix(hs.TS, 0); time.Since(ts) > fxpV2HandshakeWindow || time.Until(ts) > fxpV2HandshakeWindow {
		log.Printf("fxp v2 handshake clock skew tunnel=%d skew=%s; accepting because salt replay protection is independent of wall-clock sync", cfg.TunnelID, time.Since(ts))
	}
	reply, _ := json.Marshal(v2Handshake{V: fxpVersionV2, TS: time.Now().Unix(), TunnelID: cfg.TunnelID})
	if err := sec.writeFrame(reply); err != nil {
		return nil, err
	}
	return sec, nil
}

func newV2SecureConn(conn net.Conn, key string, salt []byte, client bool) (*secureConn, error) {
	master := sha256.Sum256([]byte(key))
	material := blake3Derive(master[:], salt, fxpV2Info, 128)
	c2sLen, err := newAEAD(material[0:32])
	if err != nil {
		return nil, err
	}
	c2sData, err := newAEAD(material[32:64])
	if err != nil {
		return nil, err
	}
	s2cLen, err := newAEAD(material[64:96])
	if err != nil {
		return nil, err
	}
	s2cData, err := newAEAD(material[96:128])
	if err != nil {
		return nil, err
	}
	sec := &secureConn{
		conn:    conn,
		version: fxpVersionV2,
	}
	if client {
		sec.lenWriteAEAD, sec.dataWriteAEAD = c2sLen, c2sData
		sec.lenReadAEAD, sec.dataReadAEAD = s2cLen, s2cData
		sec.writeDir, sec.readDir = fxpV2EntryToExit, fxpV2ExitToEntry
	} else {
		sec.lenWriteAEAD, sec.dataWriteAEAD = s2cLen, s2cData
		sec.lenReadAEAD, sec.dataReadAEAD = c2sLen, c2sData
		sec.writeDir, sec.readDir = fxpV2ExitToEntry, fxpV2EntryToExit
	}
	return sec, nil
}

func blake3Derive(secret, salt, context []byte, length int) []byte {
	material := make([]byte, 0, len(secret)+len(salt))
	material = append(material, secret...)
	material = append(material, salt...)
	keyMaterial := make([]byte, 32)
	blake3.DeriveKey(keyMaterial, "forwardx-fxp-v2 master", context)
	deriver := blake3.New(length, keyMaterial)
	_, _ = deriver.Write(material)
	out := make([]byte, length)
	reader := deriver.XOF()
	_, _ = io.ReadFull(reader, out)
	return out
}

func (c *secureConn) writeFrame(plain []byte) error {
	if c.version == fxpVersionV2 {
		return c.writeFrameV2(plain)
	}
	return c.writeFrameV1(plain)
}

func (c *secureConn) writeFrameV1(plain []byte) error {
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
	if c.version == fxpVersionV2 {
		return c.readFrameV2()
	}
	return c.readFrameV1()
}

func (c *secureConn) readFrameV1() ([]byte, error) {
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

func (c *secureConn) writeFrameV2(plain []byte) error {
	if len(plain) > fxpV2MaxFrame {
		return errors.New("frame too large")
	}
	counter := c.writeCounter
	c.writeCounter++
	var lenPlain [4]byte
	binary.BigEndian.PutUint32(lenPlain[:], uint32(len(plain)))
	lenNonce := fxpV2Nonce(c.writeDir, counter, 0)
	dataNonce := fxpV2Nonce(c.writeDir, counter, 1)
	lenCipher := c.lenWriteAEAD.Seal(nil, lenNonce, lenPlain[:], fxpV2LenAD)
	dataCipher := c.dataWriteAEAD.Seal(nil, dataNonce, plain, fxpV2DataAD)
	if _, err := writeFull(c.conn, lenCipher); err != nil {
		return err
	}
	_, err := writeFull(c.conn, dataCipher)
	return err
}

func (c *secureConn) readFrameV2() ([]byte, error) {
	counter := c.readCounter
	c.readCounter++
	lenCipher := make([]byte, 4+c.lenReadAEAD.Overhead())
	if _, err := io.ReadFull(c.conn, lenCipher); err != nil {
		return nil, err
	}
	lenNonce := fxpV2Nonce(c.readDir, counter, 0)
	lenPlain, err := c.lenReadAEAD.Open(nil, lenNonce, lenCipher, fxpV2LenAD)
	if err != nil {
		return nil, err
	}
	if len(lenPlain) != 4 {
		return nil, errors.New("invalid frame length")
	}
	n := binary.BigEndian.Uint32(lenPlain)
	if n > fxpV2MaxFrame {
		return nil, fmt.Errorf("invalid frame size %d", n)
	}
	dataCipher := make([]byte, int(n)+c.dataReadAEAD.Overhead())
	if _, err := io.ReadFull(c.conn, dataCipher); err != nil {
		return nil, err
	}
	dataNonce := fxpV2Nonce(c.readDir, counter, 1)
	return c.dataReadAEAD.Open(nil, dataNonce, dataCipher, fxpV2DataAD)
}

func fxpV2Nonce(direction uint32, counter uint64, kind byte) []byte {
	nonce := make([]byte, 12)
	binary.BigEndian.PutUint32(nonce[0:4], direction)
	binary.BigEndian.PutUint64(nonce[4:12], counter)
	nonce[3] ^= kind
	return nonce
}

func replayKey(cfg config, salt []byte) string {
	scope := fmt.Sprintf("%d:%d:%d:", cfg.TunnelID, cfg.RuleID, cfg.ListenPort)
	return scope + hex.EncodeToString(salt)
}

func newReplayCache(ttl time.Duration, max int) *replayCache {
	return &replayCache{ttl: ttl, max: max, seen: make(map[string]time.Time)}
}

func (c *replayCache) Add(key string) bool {
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lastSweep.IsZero() || now.Sub(c.lastSweep) > time.Minute || len(c.seen) > c.max {
		c.sweepLocked(now)
	}
	if expiresAt, ok := c.seen[key]; ok && expiresAt.After(now) {
		return false
	}
	c.seen[key] = now.Add(c.ttl)
	if len(c.seen) > c.max {
		c.sweepLocked(now)
	}
	return true
}

func (c *replayCache) sweepLocked(now time.Time) {
	c.lastSweep = now
	for key, expiresAt := range c.seen {
		if !expiresAt.After(now) || len(c.seen) > c.max {
			delete(c.seen, key)
		}
	}
}

func probeDelay() {
	var b [1]byte
	_, _ = rand.Read(b[:])
	time.Sleep(time.Duration(150+int(b[0])%350) * time.Millisecond)
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

func reportTraffic(cfg config, bytesIn, bytesOut uint64) {
	if cfg.PanelURL == "" || cfg.Token == "" || cfg.RuleID <= 0 || (bytesIn == 0 && bytesOut == 0) {
		return
	}
	payload := map[string]any{
		"stats": []map[string]any{{
			"ruleId":      cfg.RuleID,
			"bytesIn":     bytesIn,
			"bytesOut":    bytesOut,
			"connections": 0,
		}},
	}
	env, err := encryptEnvelope(payload, cfg.Token)
	if err != nil {
		log.Printf("traffic encrypt failed rule=%d: %v", cfg.RuleID, err)
		return
	}
	body, _ := json.Marshal(env)
	req, err := http.NewRequest("POST", strings.TrimRight(cfg.PanelURL, "/")+"/api/agent/traffic", bytes.NewReader(body))
	if err != nil {
		log.Printf("traffic request failed rule=%d: %v", cfg.RuleID, err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Agent-Encrypted", "1")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("traffic report failed rule=%d in=%d out=%d: %v", cfg.RuleID, bytesIn, bytesOut, err)
		return
	}
	_ = resp.Body.Close()
	if resp.StatusCode >= 300 {
		log.Printf("traffic report status rule=%d in=%d out=%d status=%s", cfg.RuleID, bytesIn, bytesOut, resp.Status)
	}
}

func startTrafficReporter(cfg config, counter *trafficCounter) func() {
	done := make(chan struct{})
	var lastIn, lastOut uint64
	reportDelta := func() {
		curIn := counter.in.Load()
		curOut := counter.out.Load()
		deltaIn := curIn - lastIn
		deltaOut := curOut - lastOut
		if deltaIn > 0 || deltaOut > 0 {
			reportTraffic(cfg, deltaIn, deltaOut)
			lastIn = curIn
			lastOut = curOut
		}
	}
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				reportDelta()
			case <-done:
				return
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			close(done)
			reportDelta()
		})
	}
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
