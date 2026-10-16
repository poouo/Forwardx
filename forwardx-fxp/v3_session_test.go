package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/poouo/Forwardx/forwardx-fxp/internal/v3"
)

// Helpers use real loopback TCP and only ForwardX code, never inspected samples.
func v3TestListener(t *testing.T, handler func(net.Conn)) (int, *atomic.Int64) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var accepted atomic.Int64
	var mu sync.Mutex
	var connections []net.Conn
	var wg sync.WaitGroup
	acceptStopped := make(chan struct{})
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer close(acceptStopped)
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			connections = append(connections, conn)
			mu.Unlock()
			accepted.Add(1)
			wg.Add(1)
			go func() { defer wg.Done(); defer conn.Close(); handler(conn) }()
		}
	}()
	t.Cleanup(func() {
		ln.Close()
		<-acceptStopped
		mu.Lock()
		for _, conn := range connections {
			conn.Close()
		}
		mu.Unlock()
		finished := make(chan struct{})
		go func() { wg.Wait(); close(finished) }()
		select {
		case <-finished:
		case <-time.After(3 * time.Second):
			t.Error("V3 test listener leaked handlers")
		}
	})
	return ln.Addr().(*net.TCPAddr).Port, &accepted
}

func v3TestPool(t *testing.T) *v3SessionPool {
	t.Helper()
	p := &v3SessionPool{buckets: make(map[[32]byte]*v3PoolBucket)}
	t.Cleanup(func() {
		p.Close()
		waitV3TestState(t, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return p.count == 0 && len(p.buckets) == 0 })
	})
	return p
}

func waitV3TestState(t *testing.T, ready func() bool) {
	t.Helper()
	end := time.Now().Add(3 * time.Second)
	for !ready() {
		if time.Now().After(end) {
			t.Fatal("V3 runtime resources did not converge")
		}
		time.Sleep(time.Millisecond)
	}
}

func closeV3TestEndpoint(port int, cfg config) {
	key := v3PoolKey("127.0.0.1", port, cfg)
	v3Outbound.mu.Lock()
	var sessions []*v3.Session
	if bucket := v3Outbound.buckets[key]; bucket != nil {
		sessions = append(sessions, bucket.sessions...)
	}
	v3Outbound.mu.Unlock()
	for _, session := range sessions {
		session.Close()
	}
}

func v3TestBusiness(t *testing.T, pool *v3SessionPool, cfg config, port, target int) (net.Conn, *secureConn) {
	t.Helper()
	conn, sec, err := pool.open("127.0.0.1", port, cfg, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	hello, _ := json.Marshal(helloFrame{Network: "tcp", TunnelID: cfg.TunnelID, RuleID: cfg.RuleID, TargetIP: "127.0.0.1", TargetPort: target})
	if err = writeSecureHello(sec, hello); err != nil {
		conn.Close()
		t.Fatal(err)
	}
	sec.conn.SetDeadline(time.Now().Add(5 * time.Second))
	return conn, sec
}

func v3TestEcho(t *testing.T, sec *secureConn, payload []byte) {
	t.Helper()
	if err := sec.writeFrame(payload); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, 0, len(payload))
	for len(got) < len(payload) {
		part, err := sec.readFrame()
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, part...)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("V3 routed bytes mismatch length=%d", len(got))
	}
}

func TestV3PoolSharesAcrossRulesAndExpandsAtStreamLimit(t *testing.T) {
	for _, mode := range []string{"http", "ws", "tls"} {
		t.Run(mode, func(t *testing.T) {
			target, _ := v3TestListener(t, func(conn net.Conn) { _, _ = io.Copy(conn, conn) })
			cfg := config{TransportVersion: "v3", V3Transport: mode, TunnelID: 403, Key: "pool-rules-secret", V3Host: "outer.example", V3Path: "/stream"}
			port, accepted := v3TestListener(t, func(conn net.Conn) { _ = handleExitSession(conn, cfg) })
			pool := v3TestPool(t)
			var streams []net.Conn
			var records []*secureConn
			for i := 0; i < 140; i++ {
				rule := cfg
				rule.RuleID = i + 1
				conn, sec := v3TestBusiness(t, pool, rule, port, target)
				streams = append(streams, conn)
				records = append(records, sec)
				v3TestEcho(t, sec, []byte{byte(i), 0, 255})
			}
			if accepted.Load() != 2 {
				t.Fatalf("expected 2 physical sessions for 140 streams, got %d", accepted.Load())
			}
			// Closing one stream must not restart either physical session.
			streams[0].Close()
			v3TestEcho(t, records[139], bytes.Repeat([]byte("sibling-survives"), 6000))
			if accepted.Load() != 2 {
				t.Fatal("a logical close restarted its siblings")
			}
			for _, stream := range streams {
				stream.Close()
			}
			waitV3TestState(t, func() bool {
				pool.mu.Lock()
				defer pool.mu.Unlock()
				for _, b := range pool.buckets {
					for _, s := range b.sessions {
						if s.ActiveStreams() != 0 || s.BufferedBytes() != 0 {
							return false
						}
					}
				}
				return true
			})
			pool.Close()
			waitV3TestState(t, func() bool { n, _ := v3BusinessGate.stats(); return n == 0 })
		})
	}
}

func TestV3PoolDoesNotShareDifferentSecurityOrOuterOptions(t *testing.T) {
	cfg := config{TransportVersion: "v3", V3Transport: "ws", TunnelID: 1, Key: "key", V3Host: "outer", V3Path: "/a", V3ServerName: "a"}
	want := v3PoolKey("host", 1234, cfg)
	for _, change := range []func(*config){
		func(c *config) { c.TunnelID++ }, func(c *config) { c.Key = "other" }, func(c *config) { c.V3Transport = "http" },
		func(c *config) { c.V3Host = "other" }, func(c *config) { c.V3Path = "/b" }, func(c *config) { c.V3ServerName = "b" },
	} {
		other := cfg
		change(&other)
		if v3PoolKey("host", 1234, other) == want {
			t.Fatal("unsafe pool key collision")
		}
	}
	other := cfg
	other.RuleID = 999
	other.TargetIP = "other-target"
	other.MaxIPs = 3
	if v3PoolKey("host", 1234, other) != want {
		t.Fatal("rule-local settings disabled cross-rule multiplexing")
	}
}

func TestV3RelayPreservesMultiplexingAndPerHopKeys(t *testing.T) {
	for _, mode := range []string{"http", "ws", "tls"} {
		t.Run(mode, func(t *testing.T) {
			target, _ := v3TestListener(t, func(conn net.Conn) { _, _ = io.Copy(conn, conn) })
			exitCfg := config{TransportVersion: "v3", V3Transport: mode, TunnelID: 404, Key: "downstream-hop-secret"}
			exit, _ := v3TestListener(t, func(conn net.Conn) { _ = handleExitSession(conn, exitCfg) })
			relayCfg := exitCfg
			relayCfg.Role = "relay"
			relayCfg.Key = "upstream-hop-secret"
			relayCfg.RelayKey = exitCfg.Key
			relayCfg.RelayExitHost = "127.0.0.1"
			relayCfg.RelayExitPort = exit
			selector := newExitEndpointSelector(nil, exitEndpoint{Host: "127.0.0.1", Port: exit, Key: exitCfg.Key}, "fallback")
			relay, _ := v3TestListener(t, func(conn net.Conn) { _ = handleRelaySession(conn, relayCfg, selector) })
			pool := v3TestPool(t)
			upstream, sec := v3TestBusiness(t, pool, relayCfg, relay, target)
			v3TestEcho(t, sec, bytes.Repeat([]byte("multihop"), 12000))
			if err := sec.writeFrame(nil); err != nil {
				t.Fatal(err)
			}
			if data, err := sec.readFrame(); err != nil || len(data) != 0 {
				t.Fatal("relay broke business half-close", err)
			}
			upstream.Close()
			// Only drain this test's downstream endpoint from the process pool.
			down := relayCfg
			down.Key = exitCfg.Key
			key := v3PoolKey("127.0.0.1", exit, down)
			v3Outbound.mu.Lock()
			if bucket := v3Outbound.buckets[key]; bucket != nil {
				for _, s := range bucket.sessions {
					s.Close()
				}
			}
			v3Outbound.mu.Unlock()
		})
	}
}

func TestV3FailedHandshakeReleasesPoolReservation(t *testing.T) {
	cfg := config{TransportVersion: "v3", V3Transport: "ws", TunnelID: 405, Key: "server-secret"}
	port, _ := v3TestListener(t, func(conn net.Conn) { _ = handleExitSession(conn, cfg) })
	pool := v3TestPool(t)
	wrong := cfg
	wrong.Key = "wrong-secret"
	if _, _, err := pool.open("127.0.0.1", port, wrong, nil, ""); err == nil {
		t.Fatal("wrong key accepted")
	}
	pool.mu.Lock()
	retained := pool.count != 0 || len(pool.buckets) != 0
	pool.mu.Unlock()
	if retained {
		t.Fatal("failed authentication retained pool reservation")
	}
}

func TestV3LogicalFramesRejectOversizeBeforeAllocation(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	sec := &secureConn{conn: a, logicalFrames: true}
	go func() {
		var header [4]byte
		binary.BigEndian.PutUint32(header[:], v3LogicalFrameLimit+1)
		b.Write(header[:])
	}()
	if _, err := sec.readFrame(); err == nil {
		t.Fatal("oversize logical frame accepted")
	}
	if err := sec.writeFrame(make([]byte, v3LogicalFrameLimit+1)); err == nil {
		t.Fatal("oversize logical write accepted")
	}
}

// TestV3MuxRejectsUnsupportedInnerMode checks that the multiplex session refuses
// a peer that does not speak the ForwardX inner record layer. The old
// "forwardx-v3-mux-1" version string no longer exists; the mode byte in the
// 17-byte inner initialisation carries that role now.
func TestV3MuxRejectsUnsupportedInnerMode(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	done := make(chan error, 1)
	go func() {
		_, err := newV3MuxSession(b, "mux-negotiation", false)
		done <- err
		b.Close()
	}()
	// Send a 17-byte initialisation whose mode byte is not the AEAD marker.
	msg := make([]byte, v3.InnerHandshakeSize)
	msg[0] = 1
	go func() { _, _ = a.Write(msg) }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("unsupported inner mode accepted")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server did not reject unsupported inner mode")
	}
}

func TestV3MultiplexCanBeDisabledWithoutChangingAuthentication(t *testing.T) {
	no := false
	cfg := config{TransportVersion: "v3", V3Transport: "ws", V3Multiplex: &no, TunnelID: 407, Key: "no-multiplex"}
	target, _ := v3TestListener(t, func(conn net.Conn) { _, _ = io.Copy(conn, conn) })
	port, _ := v3TestListener(t, func(conn net.Conn) { _ = handleExitSession(conn, cfg) })
	conn, sec, err := dialSecureTCP("127.0.0.1", port, cfg, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	hello, _ := json.Marshal(helloFrame{Network: "tcp", TunnelID: 407, TargetIP: "127.0.0.1", TargetPort: target})
	if err = writeSecureHello(sec, hello); err != nil {
		t.Fatal(err)
	}
	sec.conn.SetDeadline(time.Now().Add(time.Second))
	v3TestEcho(t, sec, []byte("direct V3"))
	if !sec.logicalFrames {
		t.Fatal("non-mux V3 must use the logical frame path")
	}
	if sec.lenWriteAEAD != nil || sec.dataWriteAEAD != nil {
		t.Fatal("non-mux V3 must not use the legacy FXP record layer")
	}
	if err = sec.writeFrame(nil); err != nil {
		t.Fatal(err)
	}
	if data, err := sec.readFrame(); err != nil || len(data) != 0 {
		t.Fatal("non-mux half-close failed", err)
	}
}

func TestV3PoolClosedCannotDial(t *testing.T) {
	pool := v3TestPool(t)
	pool.Close()
	cfg := config{TransportVersion: "v3", V3Transport: "http"}
	if _, _, err := pool.open("127.0.0.1", 1, cfg, nil, ""); !errors.Is(err, net.ErrClosed) {
		t.Fatal(err)
	}
}

func TestV3PoolReconnectAfterPhysicalFailure(t *testing.T) {
	cfg := config{TransportVersion: "v3", V3Transport: "ws", TunnelID: 408, Key: "reconnect-secret"}
	target, _ := v3TestListener(t, func(conn net.Conn) { _, _ = io.Copy(conn, conn) })
	port, accepted := v3TestListener(t, func(conn net.Conn) { _ = handleExitSession(conn, cfg) })
	pool := v3TestPool(t)
	conn, sec := v3TestBusiness(t, pool, cfg, port, target)
	v3TestEcho(t, sec, []byte("before-reset"))
	key := v3PoolKey("127.0.0.1", port, cfg)
	pool.mu.Lock()
	session := pool.buckets[key].sessions[0]
	pool.mu.Unlock()
	session.Close()
	if _, err := sec.readFrame(); err == nil {
		t.Fatal("failed physical session left logical stream live")
	}
	conn.Close()
	conn, sec = v3TestBusiness(t, pool, cfg, port, target)
	defer conn.Close()
	v3TestEcho(t, sec, []byte("after-reconnect"))
	if accepted.Load() != 2 {
		t.Fatalf("reconnect used %d physical sessions", accepted.Load())
	}
}

func TestV3FallbackToHealthyExitStillWorks(t *testing.T) {
	cfg := config{TransportVersion: "v3", V3Transport: "tls", TunnelID: 409, Key: "fallback-secret", ExitStrategy: "fallback"}
	target, _ := v3TestListener(t, func(conn net.Conn) { _, _ = io.Copy(conn, conn) })
	port, accepted := v3TestListener(t, func(conn net.Conn) { _ = handleExitSession(conn, cfg) })
	// Reserve, then release a known unused loopback port for a refused endpoint.
	unavailable, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	badPort := unavailable.Addr().(*net.TCPAddr).Port
	unavailable.Close()
	cfg.ExitHost = "127.0.0.1"
	cfg.ExitPort = badPort
	cfg.Exits = []exitEndpoint{{Host: "127.0.0.1", Port: badPort, Key: cfg.Key}, {Host: "127.0.0.1", Port: port, Key: cfg.Key}}
	selector := newExitEndpointSelector(cfg.Exits, exitEndpoint{}, "fallback")
	t.Cleanup(func() { closeV3TestEndpoint(port, cfg) })
	conn, sec, endpoint, err := dialSelectedSecureTCP(selector, cfg, "client")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if endpoint.Port != port {
		t.Fatal("selected unavailable exit")
	}
	hello, _ := json.Marshal(helloFrame{Network: "tcp", TunnelID: 409, TargetIP: "127.0.0.1", TargetPort: target})
	if err = writeSecureHello(sec, hello); err != nil {
		t.Fatal(err)
	}
	sec.conn.SetDeadline(time.Now().Add(3 * time.Second))
	v3TestEcho(t, sec, []byte("healthy fallback"))
	if accepted.Load() != 1 {
		t.Fatal("unnecessary healthy exit reconnect")
	}
}

// TestV3PoolSkipsStaleSessions proves the pool stops handing new business
// streams to a physical session that has not completed a write recently. Without
// this the pool kept selecting a silently dead session and the resulting write
// timeout failed the whole session, breaking every sibling stream on it.
func TestV3PoolSkipsStaleSessions(t *testing.T) {
	cfg := config{TransportVersion: "v3", V3Transport: "ws", TunnelID: 411, Key: "stale-secret"}
	target, _ := v3TestListener(t, func(conn net.Conn) { _, _ = io.Copy(conn, conn) })
	port, _ := v3TestListener(t, func(conn net.Conn) { _ = handleExitSession(conn, cfg) })
	pool := v3TestPool(t)
	conn, sec := v3TestBusiness(t, pool, cfg, port, target)
	v3TestEcho(t, sec, []byte("before-age"))
	conn.Close()

	key := v3PoolKey("127.0.0.1", port, cfg)
	pool.mu.Lock()
	stale := pool.buckets[key].sessions[0]
	pool.mu.Unlock()

	// Age the recorded write beyond the stale threshold. The session still
	// advertises slots, which is exactly the half-open case the pool must catch.
	stale.AgeLastWrite(time.Hour)
	if stale.Alive(v3SessionStaleAge) {
		t.Fatal("aged session still reported alive")
	}
	if stale.OpenSlots() == 0 {
		t.Fatal("test needs a session that still advertises slots")
	}

	// The next business connection must be served by a replacement session, and
	// the stale session must have been pruned and closed.
	conn2, sec2 := v3TestBusiness(t, pool, cfg, port, target)
	v3TestEcho(t, sec2, []byte("after-age"))
	if !errors.Is(stale.Err(), net.ErrClosed) {
		t.Fatalf("stale session was not closed: %v", stale.Err())
	}
	pool.mu.Lock()
	for _, session := range pool.buckets[key].sessions {
		if session == stale {
			pool.mu.Unlock()
			t.Fatal("stale session is still in the pool")
		}
	}
	pool.mu.Unlock()
	conn2.Close()
}

// TestV3PoolReportsEndpointFailureToSelector proves the pooled dial path feeds
// endpoint health back to the selector, so ExitStrategy fallback keeps working
// once a pool exists.
func TestV3PoolReportsEndpointFailureToSelector(t *testing.T) {
	cfg := config{TransportVersion: "v3", V3Transport: "ws", TunnelID: 412, Key: "health-secret", ExitStrategy: "fallback"}
	target, _ := v3TestListener(t, func(conn net.Conn) { _, _ = io.Copy(conn, conn) })
	port, accepted := v3TestListener(t, func(conn net.Conn) { _ = handleExitSession(conn, cfg) })
	unavailable, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	badPort := unavailable.Addr().(*net.TCPAddr).Port
	unavailable.Close()

	pool := v3TestPool(t)
	cfg.ExitHost = "127.0.0.1"
	cfg.ExitPort = port
	cfg.Exits = []exitEndpoint{
		{Host: "127.0.0.1", Port: badPort, Key: cfg.Key},
		{Host: "127.0.0.1", Port: port, Key: cfg.Key},
	}
	selector := newExitEndpointSelector(cfg.Exits, exitEndpoint{}, "fallback")
	t.Cleanup(func() { closeV3TestEndpoint(port, cfg) })

	conn, sec, err := pool.open("", 0, cfg, selector, "client")
	if err != nil {
		t.Fatalf("pool could not fail over to the healthy endpoint: %v", err)
	}
	defer conn.Close()
	hello, _ := json.Marshal(helloFrame{Network: "tcp", TunnelID: 412, TargetIP: "127.0.0.1", TargetPort: target})
	if err := writeSecureHello(sec, hello); err != nil {
		t.Fatal(err)
	}
	sec.conn.SetDeadline(time.Now().Add(3 * time.Second))
	v3TestEcho(t, sec, []byte("pooled fallback"))
	if accepted.Load() != 1 {
		t.Fatalf("expected one healthy physical session, got %d", accepted.Load())
	}
	// The refused endpoint must have been marked unhealthy with a retry delay,
	// and the healthy one left healthy, so later dials skip the dead endpoint.
	selector.mu.Lock()
	badHealthy := selector.healthy[0]
	badRetry := selector.retryAfter[0]
	goodHealthy := selector.healthy[1]
	selector.mu.Unlock()
	if badHealthy {
		t.Fatal("refused endpoint was not recorded as failed")
	}
	if !badRetry.After(time.Now()) {
		t.Fatal("refused endpoint has no retry delay")
	}
	if !goodHealthy {
		t.Fatal("healthy endpoint was recorded as failed")
	}
}
