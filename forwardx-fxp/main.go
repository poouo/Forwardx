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

type fxpHandshake struct {
	V        int   `json:"v"`
	TS       int64 `json:"ts"`
	TunnelID int   `json:"tunnelId"`
}

type secureConn struct {
	conn          net.Conn
	lenWriteAEAD  cipher.AEAD
	dataWriteAEAD cipher.AEAD
	lenReadAEAD   cipher.AEAD
	dataReadAEAD  cipher.AEAD
	lengthAD      []byte
	payloadAD     []byte
	writeDir      uint32
	readDir       uint32
	writeCounter  uint64
	readCounter   uint64
}

type fxpWireContext struct {
	name          string
	sessionInfo   []byte
	lengthAD      []byte
	payloadAD     []byte
	masterContext string
	compat        bool
}

type replayCache struct {
	ttl       time.Duration
	max       int
	mu        sync.Mutex
	seen      map[string]time.Time
	lastSweep time.Time
}

const (
	fxpHandshakeVersion = 2
	fxpSaltSize         = 32
	fxpMaxFrame         = 16 * 1024 * 1024
	fxpEntryToExit      = uint32(1)
	fxpExitToEntry      = uint32(2)
	fxpHandshakeWindow  = 5 * time.Minute
	fxpTCPKeepAlive     = 30 * time.Second
	fxpHalfCloseLinger  = 30 * time.Second
	fxpMasterContext    = "forwardx-fxp-v2 master"
	fxpRuntimeVersion   = "2.2.80"
)

var (
	fxpSessionInfo       = []byte("forwardx-fxp-v2 session")
	fxpLengthAD          = []byte("forwardx-fxp-v2 length")
	fxpPayloadAD         = []byte("forwardx-fxp-v2 payload")
	fxpCompatSessionInfo = []byte("forwardx-fxp session")
	fxpCompatLengthAD    = []byte("forwardx-fxp length")
	fxpCompatPayloadAD   = []byte("forwardx-fxp payload")
	fxpWireCurrent       = fxpWireContext{name: "current", sessionInfo: fxpSessionInfo, lengthAD: fxpLengthAD, payloadAD: fxpPayloadAD, masterContext: fxpMasterContext}
	fxpWireCompat2390    = fxpWireContext{name: "2.3.90-compat", sessionInfo: fxpCompatSessionInfo, lengthAD: fxpCompatLengthAD, payloadAD: fxpCompatPayloadAD, masterContext: "forwardx-fxp master", compat: true}
	fxpWireContexts      = []fxpWireContext{fxpWireCurrent, fxpWireCompat2390}
	fxpReplaySeen        = newReplayCache(fxpHandshakeWindow, 100000)
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

func (g *connGate) acquire(remoteAddr net.Addr) (func(), bool, string) {
	ip := remoteIP(remoteAddr)
	if g.maxConnections > 0 && g.active.Load() >= g.maxConnections {
		return func() {}, false, "maxConnections"
	}
	g.mu.Lock()
	if g.maxIPs > 0 && ip != "" {
		if _, ok := g.ips[ip]; !ok && len(g.ips) >= g.maxIPs {
			g.mu.Unlock()
			return func() {}, false, "maxIPs"
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
	}, true, ""
}

func (g *connGate) stats() (int64, int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.active.Load(), len(g.ips)
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
	log.Printf(
		"forwardx-fxp runtime version=%s role=%s tunnel=%d rule=%d listen=:%d protocol=%s exit=%s:%d relayNext=%s:%d target=%s:%d limits=maxConnections:%d,maxIPs:%d",
		fxpRuntimeVersion,
		cfg.Role,
		cfg.TunnelID,
		cfg.RuleID,
		cfg.ListenPort,
		cfg.Protocol,
		cfg.ExitHost,
		cfg.ExitPort,
		cfg.RelayExitHost,
		cfg.RelayExitPort,
		cfg.TargetIP,
		cfg.TargetPort,
		cfg.MaxConnections,
		cfg.MaxIPs,
	)
	ctx := shutdownContext()
	switch strings.ToLower(cfg.Role) {
	case "entry":
		err = runEntry(ctx.done, cfg)
	case "exit":
		err = runExit(ctx.done, cfg)
	case "relay":
		err = runRelay(ctx.done, cfg)
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

func dialTCP(host string, port int, timeout time.Duration) (net.Conn, error) {
	d := net.Dialer{Timeout: timeout, KeepAlive: fxpTCPKeepAlive}
	conn, err := d.Dial("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	enableTCPKeepAlive(conn)
	return conn, nil
}

func dialSecureTCP(host string, port int, cfg config) (net.Conn, *secureConn, error) {
	var lastErr error
	for _, wire := range fxpWireContexts {
		conn, err := dialTCP(host, port, 10*time.Second)
		if err != nil {
			return nil, nil, err
		}
		sec, err := newClientSecureConnWithWire(conn, cfg, wire)
		if err == nil {
			if wire.compat {
				log.Printf("fxp using compatibility wire context=%s tunnel=%d peer=%s:%d", wire.name, cfg.TunnelID, host, port)
			}
			return conn, sec, nil
		}
		lastErr = err
		_ = conn.Close()
	}
	if lastErr == nil {
		lastErr = errors.New("fxp secure connect failed")
	}
	return nil, nil, lastErr
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

func runEntry(done <-chan struct{}, cfg config) error {
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
			errCh <- acceptEntryTCP(ln, cfg, gate)
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
			errCh <- serveEntryUDP(udpConn, cfg)
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

func acceptEntryTCP(ln net.Listener, cfg config, gate *connGate) error {
	for {
		client, err := ln.Accept()
		if err != nil {
			return err
		}
		enableTCPKeepAlive(client)
		release, ok, reason := gate.acquire(client.RemoteAddr())
		if !ok {
			active, ips := gate.stats()
			log.Printf("entry tcp rejected by connection gate tunnel=%d rule=%d client=%s reason=%s active=%d maxConnections=%d distinctIPs=%d maxIPs=%d", cfg.TunnelID, cfg.RuleID, client.RemoteAddr(), reason, active, cfg.MaxConnections, ips, cfg.MaxIPs)
			_ = client.Close()
			continue
		}
		go func() {
			defer release()
			if err := handleEntryTCP(client, cfg); err != nil && !isClosedErr(err) {
				log.Printf("entry tcp session error: %v", err)
			}
		}()
	}
}

func handleEntryTCP(client net.Conn, cfg config) error {
	defer client.Close()
	var first []byte
	initialTimeout := 150 * time.Millisecond
	if cfg.BlockHTTP || cfg.BlockSocks || cfg.BlockTLS {
		initialTimeout = 5 * time.Second
	}
	initial, err := readInitialTCPPayload(client, initialTimeout)
	if err != nil {
		if errors.Is(err, io.EOF) {
			return nil
		}
		return err
	}
	first = initial
	if cfg.BlockHTTP || cfg.BlockSocks || cfg.BlockTLS {
		if len(first) == 0 {
			// Keep server-first protocols working when no client payload arrives before the policy sniff timeout.
		} else if proto := detectBlockedProtocol(first, protocolPolicy{BlockHTTP: cfg.BlockHTTP, BlockSocks: cfg.BlockSocks, BlockTLS: cfg.BlockTLS}); proto != "" {
			reportProtocolBlock(cfg, proto)
			return nil
		}
	}
	exit, sec, err := dialSecureTCP(cfg.ExitHost, cfg.ExitPort, cfg)
	if err != nil {
		return fmt.Errorf("dial exit: %w", err)
	}
	defer exit.Close()
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
	log.Printf("entry tcp routed tunnel=%d rule=%d client=%s exit=%s:%d target=%s:%d", cfg.TunnelID, cfg.RuleID, client.RemoteAddr(), cfg.ExitHost, cfg.ExitPort, cfg.TargetIP, cfg.TargetPort)
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

func readInitialTCPPayload(conn net.Conn, timeout time.Duration) ([]byte, error) {
	if timeout > 0 {
		_ = conn.SetReadDeadline(time.Now().Add(timeout))
	}
	buf := make([]byte, 4096)
	n, err := conn.Read(buf)
	_ = conn.SetReadDeadline(time.Time{})
	if n > 0 {
		return append([]byte(nil), buf[:n]...), nil
	}
	if err != nil {
		if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
			return nil, nil
		}
		return nil, err
	}
	return nil, nil
}

func serveEntryUDP(conn *net.UDPConn, cfg config) error {
	buf := make([]byte, 65535)
	for {
		n, clientAddr, err := conn.ReadFromUDP(buf)
		if err != nil {
			return err
		}
		payload := append([]byte(nil), buf[:n]...)
		go func() {
			resp, err := udpRoundTripToExit(cfg, payload)
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

func udpRoundTripToExit(cfg config, payload []byte) ([]byte, error) {
	exit, sec, err := dialSecureTCP(cfg.ExitHost, cfg.ExitPort, cfg)
	if err != nil {
		return nil, err
	}
	defer exit.Close()
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

func runExit(done <-chan struct{}, cfg config) error {
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
			if err := handleExitSession(conn, cfg); err != nil && !isClosedErr(err) {
				log.Printf("exit session error: %v", err)
			}
		}()
	}
}

func handleExitSession(conn net.Conn, cfg config) error {
	defer conn.Close()
	sec, err := newExitSecureConn(conn, cfg)
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
	log.Printf("exit tcp routed tunnel=%d rule=%d peer=%s target=%s:%d", hello.TunnelID, hello.RuleID, sec.conn.RemoteAddr(), hello.TargetIP, hello.TargetPort)
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
func runRelay(done <-chan struct{}, cfg config) error {
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
			if err := handleRelaySession(upConn, cfg); err != nil && !isClosedErr(err) {
				log.Printf("relay session error: %v", err)
			}
		}()
	}
}

func handleRelaySession(upConn net.Conn, cfg config) error {
	defer upConn.Close()
	// Accept upstream encrypted connection (like exit)
	upSec, err := newExitSecureConn(upConn, cfg)
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
	downCfg := cfg
	downCfg.Key = cfg.RelayKey
	downConn, downSec, err := dialSecureTCP(cfg.RelayExitHost, cfg.RelayExitPort, downCfg)
	if err != nil {
		log.Printf("relay dial downstream %s:%d: %v", cfg.RelayExitHost, cfg.RelayExitPort, err)
		return err
	}
	defer downConn.Close()
	// Re-send helloFrame to downstream
	helloBytes, _ := json.Marshal(hello)
	if err := downSec.writeFrame(helloBytes); err != nil {
		return err
	}
	log.Printf("relay tcp routed tunnel=%d upstream=%s downstream=%s:%d target=%s:%d", cfg.TunnelID, upConn.RemoteAddr(), cfg.RelayExitHost, cfg.RelayExitPort, hello.TargetIP, hello.TargetPort)
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

func newAEAD(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func newEntrySecureConn(conn net.Conn, cfg config) (*secureConn, error) {
	sec, err := newClientSecureConn(conn, cfg)
	if err == nil {
		return sec, nil
	}
	_ = conn.Close()
	return nil, err
}

func newExitSecureConn(conn net.Conn, cfg config) (*secureConn, error) {
	return newServerSecureConn(conn, cfg)
}

func newClientSecureConn(conn net.Conn, cfg config) (*secureConn, error) {
	return newClientSecureConnWithWire(conn, cfg, fxpWireCurrent)
}

func newClientSecureConnWithWire(conn net.Conn, cfg config, wire fxpWireContext) (*secureConn, error) {
	salt := make([]byte, fxpSaltSize)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	if _, err := writeFull(conn, salt); err != nil {
		return nil, err
	}
	sec, err := newSessionSecureConnWithWire(conn, cfg.Key, salt, true, wire)
	if err != nil {
		return nil, err
	}
	hs, _ := json.Marshal(fxpHandshake{V: fxpHandshakeVersion, TS: time.Now().Unix(), TunnelID: cfg.TunnelID})
	if err := sec.writeFrame(hs); err != nil {
		return nil, err
	}
	ack, err := sec.readFrame()
	if err != nil {
		return nil, err
	}
	var reply fxpHandshake
	if err := json.Unmarshal(ack, &reply); err != nil || reply.V != fxpHandshakeVersion || reply.TunnelID != cfg.TunnelID {
		return nil, errors.New("fxp handshake rejected")
	}
	return sec, nil
}

func newServerSecureConn(conn net.Conn, cfg config) (*secureConn, error) {
	return newServerSecureConnWithWires(conn, cfg, fxpWireContexts)
}

func newServerSecureConnWithWires(conn net.Conn, cfg config, wires []fxpWireContext) (*secureConn, error) {
	salt := make([]byte, fxpSaltSize)
	if _, err := io.ReadFull(conn, salt); err != nil {
		return nil, err
	}
	if !fxpReplaySeen.Add(replayKey(cfg, salt)) {
		return nil, errors.New("fxp replay detected")
	}
	lenCipher := make([]byte, 4+16)
	if _, err := io.ReadFull(conn, lenCipher); err != nil {
		return nil, err
	}
	var lastErr error
	for _, wire := range wires {
		sec, err := newSessionSecureConnWithWire(conn, cfg.Key, salt, false, wire)
		if err != nil {
			lastErr = err
			continue
		}
		n, err := sec.decryptFrameLength(0, lenCipher)
		if err != nil {
			lastErr = err
			continue
		}
		dataCipher := make([]byte, int(n)+sec.dataReadAEAD.Overhead())
		if _, err := io.ReadFull(conn, dataCipher); err != nil {
			return nil, err
		}
		ack, err := sec.decryptFrameData(0, dataCipher)
		if err != nil {
			return nil, err
		}
		sec.readCounter = 1
		return finishServerHandshake(sec, cfg, ack, wire)
	}
	if lastErr == nil {
		lastErr = errors.New("fxp handshake rejected")
	}
	return nil, lastErr
}

func finishServerHandshake(sec *secureConn, cfg config, ack []byte, wire fxpWireContext) (*secureConn, error) {
	var hs fxpHandshake
	if err := json.Unmarshal(ack, &hs); err != nil || hs.V != fxpHandshakeVersion || hs.TunnelID != cfg.TunnelID {
		return nil, errors.New("fxp handshake rejected")
	}
	if hs.TS <= 0 {
		return nil, errors.New("fxp handshake rejected")
	}
	if ts := time.Unix(hs.TS, 0); time.Since(ts) > fxpHandshakeWindow || time.Until(ts) > fxpHandshakeWindow {
		log.Printf("fxp handshake clock skew tunnel=%d skew=%s; accepting because salt replay protection is independent of wall-clock sync", cfg.TunnelID, time.Since(ts))
	}
	if wire.compat {
		log.Printf("fxp accepted compatibility wire context=%s tunnel=%d", wire.name, cfg.TunnelID)
	}
	reply, _ := json.Marshal(fxpHandshake{V: fxpHandshakeVersion, TS: time.Now().Unix(), TunnelID: cfg.TunnelID})
	if err := sec.writeFrame(reply); err != nil {
		return nil, err
	}
	return sec, nil
}

func newSessionSecureConn(conn net.Conn, key string, salt []byte, client bool) (*secureConn, error) {
	return newSessionSecureConnWithWire(conn, key, salt, client, fxpWireCurrent)
}

func newSessionSecureConnWithWire(conn net.Conn, key string, salt []byte, client bool, wire fxpWireContext) (*secureConn, error) {
	master := sha256.Sum256([]byte(key))
	material := blake3Derive(master[:], salt, wire.sessionInfo, wire.masterContext, 128)
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
	sec := &secureConn{conn: conn, lengthAD: wire.lengthAD, payloadAD: wire.payloadAD}
	if client {
		sec.lenWriteAEAD, sec.dataWriteAEAD = c2sLen, c2sData
		sec.lenReadAEAD, sec.dataReadAEAD = s2cLen, s2cData
		sec.writeDir, sec.readDir = fxpEntryToExit, fxpExitToEntry
	} else {
		sec.lenWriteAEAD, sec.dataWriteAEAD = s2cLen, s2cData
		sec.lenReadAEAD, sec.dataReadAEAD = c2sLen, c2sData
		sec.writeDir, sec.readDir = fxpExitToEntry, fxpEntryToExit
	}
	return sec, nil
}

func blake3Derive(secret, salt, context []byte, masterContext string, length int) []byte {
	material := make([]byte, 0, len(secret)+len(salt))
	material = append(material, secret...)
	material = append(material, salt...)
	keyMaterial := make([]byte, 32)
	blake3.DeriveKey(keyMaterial, masterContext, context)
	deriver := blake3.New(length, keyMaterial)
	_, _ = deriver.Write(material)
	out := make([]byte, length)
	reader := deriver.XOF()
	_, _ = io.ReadFull(reader, out)
	return out
}

func (c *secureConn) writeFrame(plain []byte) error {
	return c.writeEncryptedFrame(plain)
}

func (c *secureConn) readFrame() ([]byte, error) {
	return c.readEncryptedFrame()
}

func (c *secureConn) writeEncryptedFrame(plain []byte) error {
	if len(plain) > fxpMaxFrame {
		return errors.New("frame too large")
	}
	counter := c.writeCounter
	c.writeCounter++
	var lenPlain [4]byte
	binary.BigEndian.PutUint32(lenPlain[:], uint32(len(plain)))
	lenNonce := fxpNonce(c.writeDir, counter, 0)
	dataNonce := fxpNonce(c.writeDir, counter, 1)
	lenCipher := c.lenWriteAEAD.Seal(nil, lenNonce, lenPlain[:], c.lengthAD)
	dataCipher := c.dataWriteAEAD.Seal(nil, dataNonce, plain, c.payloadAD)
	if _, err := writeFull(c.conn, lenCipher); err != nil {
		return err
	}
	_, err := writeFull(c.conn, dataCipher)
	return err
}

func (c *secureConn) readEncryptedFrame() ([]byte, error) {
	counter := c.readCounter
	c.readCounter++
	lenCipher := make([]byte, 4+c.lenReadAEAD.Overhead())
	if _, err := io.ReadFull(c.conn, lenCipher); err != nil {
		return nil, err
	}
	n, err := c.decryptFrameLength(counter, lenCipher)
	if err != nil {
		return nil, err
	}
	dataCipher := make([]byte, int(n)+c.dataReadAEAD.Overhead())
	if _, err := io.ReadFull(c.conn, dataCipher); err != nil {
		return nil, err
	}
	return c.decryptFrameData(counter, dataCipher)
}

func (c *secureConn) decryptFrameLength(counter uint64, lenCipher []byte) (uint32, error) {
	lenNonce := fxpNonce(c.readDir, counter, 0)
	lenPlain, err := c.lenReadAEAD.Open(nil, lenNonce, lenCipher, c.lengthAD)
	if err != nil {
		return 0, err
	}
	if len(lenPlain) != 4 {
		return 0, errors.New("invalid frame length")
	}
	n := binary.BigEndian.Uint32(lenPlain)
	if n > fxpMaxFrame {
		return 0, fmt.Errorf("invalid frame size %d", n)
	}
	return n, nil
}

func (c *secureConn) decryptFrameData(counter uint64, dataCipher []byte) ([]byte, error) {
	dataNonce := fxpNonce(c.readDir, counter, 1)
	return c.dataReadAEAD.Open(nil, dataNonce, dataCipher, c.payloadAD)
}

func fxpNonce(direction uint32, counter uint64, kind byte) []byte {
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
