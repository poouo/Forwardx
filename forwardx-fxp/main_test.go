package main

import (
	"encoding/json"
	"io"
	"net"
	"os"
	"strconv"
	"testing"
	"time"
)

func TestForwardXTCPRoundTrip(t *testing.T) {
	testForwardXTCPRoundTrip(t, fxpVersionV2)
}

func TestForwardXTCPRoundTripV1(t *testing.T) {
	testForwardXTCPRoundTrip(t, fxpVersionV1)
}

func TestForwardXRelayTCPRoundTripV2(t *testing.T) {
	testForwardXRelayTCPRoundTrip(t, fxpVersionV2)
}

func TestForwardXRelayTCPRoundTripV1(t *testing.T) {
	testForwardXRelayTCPRoundTrip(t, fxpVersionV1)
}

func testForwardXTCPRoundTrip(t *testing.T, fxpVersion int) {
	t.Helper()
	targetLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer targetLn.Close()
	go func() {
		for {
			conn, err := targetLn.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()

	key := "test-key"
	sec, err := newSecureConn(nil, key)
	if err != nil {
		t.Fatal(err)
	}
	targetPort := targetLn.Addr().(*net.TCPAddr).Port
	exitPort := freeTCPPort(t)
	entryPort := freeTCPPort(t)
	exitDone := make(chan struct{})
	entryDone := make(chan struct{})
	defer close(exitDone)
	defer close(entryDone)

	go func() {
		_ = runExit(exitDone, config{
			Role:       "exit",
			TunnelID:   1,
			ListenPort: exitPort,
			Protocol:   "tcp",
			Key:        key,
			FXPVersion: fxpVersion,
		}, sec.aead)
	}()
	waitForTCP(t, exitPort)

	go func() {
		_ = runEntry(entryDone, config{
			Role:       "entry",
			TunnelID:   1,
			RuleID:     2,
			ListenPort: entryPort,
			Protocol:   "tcp",
			ExitHost:   "127.0.0.1",
			ExitPort:   exitPort,
			TargetIP:   "127.0.0.1",
			TargetPort: targetPort,
			Key:        key,
			FXPVersion: fxpVersion,
		}, sec.aead)
	}()
	waitForTCP(t, entryPort)

	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort)), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("forwardx")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, len("forwardx"))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != "forwardx" {
		t.Fatalf("unexpected echo %q", string(buf))
	}
}

func testForwardXRelayTCPRoundTrip(t *testing.T, fxpVersion int) {
	t.Helper()
	targetLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer targetLn.Close()
	go func() {
		for {
			conn, err := targetLn.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()

	upstreamKey := "entry-to-relay-key"
	downstreamKey := "relay-to-exit-key"
	upSec, err := newSecureConn(nil, upstreamKey)
	if err != nil {
		t.Fatal(err)
	}
	downSec, err := newSecureConn(nil, downstreamKey)
	if err != nil {
		t.Fatal(err)
	}
	targetPort := targetLn.Addr().(*net.TCPAddr).Port
	exitPort := freeTCPPort(t)
	relayPort := freeTCPPort(t)
	entryPort := freeTCPPort(t)
	exitDone := make(chan struct{})
	relayDone := make(chan struct{})
	entryDone := make(chan struct{})
	defer close(exitDone)
	defer close(relayDone)
	defer close(entryDone)

	go func() {
		_ = runExit(exitDone, config{
			Role:       "exit",
			TunnelID:   3,
			ListenPort: exitPort,
			Protocol:   "tcp",
			Key:        downstreamKey,
			FXPVersion: fxpVersion,
		}, downSec.aead)
	}()
	waitForTCP(t, exitPort)

	go func() {
		_ = runRelay(relayDone, config{
			Role:          "relay",
			TunnelID:      3,
			ListenPort:    relayPort,
			Protocol:      "tcp",
			Key:           upstreamKey,
			FXPVersion:    fxpVersion,
			RelayExitHost: "127.0.0.1",
			RelayExitPort: exitPort,
			RelayKey:      downstreamKey,
		}, upSec.aead)
	}()
	waitForTCP(t, relayPort)

	go func() {
		_ = runEntry(entryDone, config{
			Role:       "entry",
			TunnelID:   3,
			RuleID:     4,
			ListenPort: entryPort,
			Protocol:   "tcp",
			ExitHost:   "127.0.0.1",
			ExitPort:   relayPort,
			TargetIP:   "127.0.0.1",
			TargetPort: targetPort,
			Key:        upstreamKey,
			FXPVersion: fxpVersion,
		}, upSec.aead)
	}()
	waitForTCP(t, entryPort)

	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort)), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("relay-forwardx")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, len("relay-forwardx"))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != "relay-forwardx" {
		t.Fatalf("unexpected echo %q", string(buf))
	}
}

func TestFxpV2RejectsReplaySalt(t *testing.T) {
	c1, s1 := net.Pipe()
	defer c1.Close()
	defer s1.Close()
	c2, s2 := net.Pipe()
	defer c2.Close()
	defer s2.Close()

	cfg := config{Role: "exit", TunnelID: 77, RuleID: 0, ListenPort: 12345, Key: "replay-key", FXPVersion: fxpVersionV2}
	salt := make([]byte, fxpV2SaltSize)
	for i := range salt {
		salt[i] = byte(i + 1)
	}
	key := replayKey(cfg, salt)
	fxpReplaySeen.mu.Lock()
	delete(fxpReplaySeen.seen, key)
	fxpReplaySeen.mu.Unlock()

	errCh := make(chan error, 2)
	go func() {
		sec, err := newV2ServerSecureConn(s1, cfg)
		if err == nil {
			_ = sec.conn.Close()
		}
		errCh <- err
	}()
	if _, err := writeFull(c1, salt); err != nil {
		t.Fatal(err)
	}
	client, err := newV2SecureConn(c1, cfg.Key, salt, true)
	if err != nil {
		t.Fatal(err)
	}
	hello, _ := json.Marshal(v2Handshake{V: fxpVersionV2, TS: time.Now().Unix(), TunnelID: cfg.TunnelID})
	if err := client.writeFrame(hello); err != nil {
		t.Fatal(err)
	}
	if _, err := client.readFrame(); err != nil {
		t.Fatal(err)
	}
	if err := <-errCh; err != nil {
		t.Fatalf("first handshake failed: %v", err)
	}

	go func() {
		sec, err := newV2ServerSecureConn(s2, cfg)
		if err == nil {
			_ = sec.conn.Close()
		}
		errCh <- err
	}()
	if _, err := writeFull(c2, salt); err != nil {
		t.Fatal(err)
	}
	if err := <-errCh; err == nil {
		t.Fatal("expected replayed salt to be rejected")
	}
}

func TestReadConfigDefaultsMissingFxpVersionToV1(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "fxp-*.json")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(`{"role":"entry","listenPort":1000,"exitHost":"127.0.0.1","exitPort":1001,"targetIp":"127.0.0.1","targetPort":1002,"key":"k"}`); err != nil {
		t.Fatal(err)
	}
	cfg, err := readConfig(f.Name())
	if err != nil {
		t.Fatal(err)
	}
	if cfg.FXPVersion != fxpVersionV1 {
		t.Fatalf("missing fxpVersion should default to v1, got %d", cfg.FXPVersion)
	}
}

func freeTCPPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func waitForTCP(t *testing.T, port int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 100*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("port %d did not open", port)
}
