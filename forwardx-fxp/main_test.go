package main

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"strconv"
	"testing"
	"time"
)

func TestForwardXTCPRoundTrip(t *testing.T) {
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
		})
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
		})
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

func TestForwardXProxyProtocolRoundTrip(t *testing.T) {
	headerCh := make(chan string, 1)
	targetLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer targetLn.Close()
	go func() {
		conn, err := targetLn.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		deadline := time.Now().Add(3 * time.Second)
		_ = conn.SetReadDeadline(deadline)
		buf := make([]byte, 256)
		var got []byte
		for len(got) < len("PROXY TCP4 203.0.113.10 198.51.100.20 54321 443\r\npayload") {
			n, err := conn.Read(buf)
			if n > 0 {
				got = append(got, buf[:n]...)
			}
			if err != nil {
				break
			}
		}
		headerCh <- string(got)
	}()

	key := "proxy-protocol-key"
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
			TunnelID:   11,
			ListenPort: exitPort,
			Protocol:   "tcp",
			Key:        key,
		})
	}()
	waitForTCP(t, exitPort)

	go func() {
		_ = runEntry(entryDone, config{
			Role:                 "entry",
			TunnelID:             11,
			RuleID:               12,
			ListenPort:           entryPort,
			Protocol:             "tcp",
			ExitHost:             "127.0.0.1",
			ExitPort:             exitPort,
			TargetIP:             "127.0.0.1",
			TargetPort:           targetPort,
			Key:                  key,
			ProxyProtocolReceive: true,
			ProxyProtocolSend:    true,
		})
	}()
	waitForTCP(t, entryPort)

	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort)), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("PROXY TCP4 203.0.113.10 198.51.100.20 54321 443\r\npayload")); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-headerCh:
		want := "PROXY TCP4 203.0.113.10 198.51.100.20 54321 443\r\npayload"
		if got != want {
			t.Fatalf("unexpected target payload %q", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timeout waiting for target payload")
	}
}

func TestForwardXRelayTCPRoundTrip(t *testing.T) {
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
		})
	}()
	waitForTCP(t, exitPort)

	go func() {
		_ = runRelay(relayDone, config{
			Role:          "relay",
			TunnelID:      3,
			ListenPort:    relayPort,
			Protocol:      "tcp",
			Key:           upstreamKey,
			RelayExitHost: "127.0.0.1",
			RelayExitPort: exitPort,
			RelayKey:      downstreamKey,
		})
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
		})
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

func TestForwardXRelayChainTCPRoundTrip(t *testing.T) {
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

	keys := []string{
		"entry-to-relay-1-key",
		"relay-1-to-relay-2-key",
		"relay-2-to-exit-key",
	}
	targetPort := targetLn.Addr().(*net.TCPAddr).Port
	exitPort := freeTCPPort(t)
	relay2Port := freeTCPPort(t)
	relay1Port := freeTCPPort(t)
	entryPort := freeTCPPort(t)
	exitDone := make(chan struct{})
	relay2Done := make(chan struct{})
	relay1Done := make(chan struct{})
	entryDone := make(chan struct{})
	defer close(exitDone)
	defer close(relay2Done)
	defer close(relay1Done)
	defer close(entryDone)

	go func() {
		_ = runExit(exitDone, config{
			Role:       "exit",
			TunnelID:   5,
			ListenPort: exitPort,
			Protocol:   "tcp",
			Key:        keys[2],
		})
	}()
	waitForTCP(t, exitPort)

	go func() {
		_ = runRelay(relay2Done, config{
			Role:          "relay",
			TunnelID:      5,
			ListenPort:    relay2Port,
			Protocol:      "tcp",
			Key:           keys[1],
			RelayExitHost: "127.0.0.1",
			RelayExitPort: exitPort,
			RelayKey:      keys[2],
		})
	}()
	waitForTCP(t, relay2Port)

	go func() {
		_ = runRelay(relay1Done, config{
			Role:          "relay",
			TunnelID:      5,
			ListenPort:    relay1Port,
			Protocol:      "tcp",
			Key:           keys[0],
			RelayExitHost: "127.0.0.1",
			RelayExitPort: relay2Port,
			RelayKey:      keys[1],
		})
	}()
	waitForTCP(t, relay1Port)

	go func() {
		_ = runEntry(entryDone, config{
			Role:       "entry",
			TunnelID:   5,
			RuleID:     6,
			ListenPort: entryPort,
			Protocol:   "tcp",
			ExitHost:   "127.0.0.1",
			ExitPort:   relay1Port,
			TargetIP:   "127.0.0.1",
			TargetPort: targetPort,
			Key:        keys[0],
		})
	}()
	waitForTCP(t, entryPort)

	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort)), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("relay-chain-forwardx")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, len("relay-chain-forwardx"))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != "relay-chain-forwardx" {
		t.Fatalf("unexpected echo %q", string(buf))
	}
}

func TestFxpRejectsReplaySalt(t *testing.T) {
	c1, s1 := net.Pipe()
	defer c1.Close()
	defer s1.Close()
	c2, s2 := net.Pipe()
	defer c2.Close()
	defer s2.Close()

	cfg := config{Role: "exit", TunnelID: 77, RuleID: 0, ListenPort: 12345, Key: "replay-key"}
	salt := make([]byte, fxpSaltSize)
	for i := range salt {
		salt[i] = byte(i + 1)
	}
	key := replayKey(cfg, salt)
	fxpReplaySeen.mu.Lock()
	delete(fxpReplaySeen.seen, key)
	fxpReplaySeen.mu.Unlock()

	errCh := make(chan error, 2)
	go func() {
		sec, err := newServerSecureConn(s1, cfg)
		if err == nil {
			_ = sec.conn.Close()
		}
		errCh <- err
	}()
	if _, err := writeFull(c1, salt); err != nil {
		t.Fatal(err)
	}
	client, err := newSessionSecureConn(c1, cfg.Key, salt, true)
	if err != nil {
		t.Fatal(err)
	}
	hello, _ := json.Marshal(fxpHandshake{V: fxpHandshakeVersion, TS: time.Now().Unix(), TunnelID: cfg.TunnelID})
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
		sec, err := newServerSecureConn(s2, cfg)
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

func TestFxpServerAcceptsCompatibilityWireContext(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer clientConn.Close()
	defer serverConn.Close()

	cfg := config{Role: "exit", TunnelID: 88, RuleID: 0, ListenPort: 12345, Key: "compat-key"}
	errCh := make(chan error, 1)
	go func() {
		sec, err := newServerSecureConn(serverConn, cfg)
		if err == nil {
			_ = sec.conn.Close()
		}
		errCh <- err
	}()
	client, err := newClientSecureConnWithWire(clientConn, cfg, fxpWireCompat2390)
	if err != nil {
		t.Fatal(err)
	}
	_ = client.conn.Close()
	if err := <-errCh; err != nil {
		t.Fatalf("compat handshake failed: %v", err)
	}
}

func TestFxpClientRetriesCompatibilityWireContext(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	cfg := config{Role: "entry", TunnelID: 89, RuleID: 0, ListenPort: 12345, Key: "compat-retry-key"}
	done := make(chan error, 1)
	go func() {
		for i := 0; i < 2; i++ {
			conn, err := ln.Accept()
			if err != nil {
				done <- err
				return
			}
			sec, err := newServerSecureConnWithWires(conn, cfg, []fxpWireContext{fxpWireCompat2390})
			if err != nil {
				_ = conn.Close()
				continue
			}
			_ = sec.conn.Close()
			done <- nil
			return
		}
		done <- errors.New("compat retry did not reach server")
	}()

	port := ln.Addr().(*net.TCPAddr).Port
	conn, sec, err := dialSecureTCP("127.0.0.1", port, cfg)
	if err != nil {
		t.Fatal(err)
	}
	_ = sec.conn.Close()
	_ = conn.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestFxpWireContextRemainsStable(t *testing.T) {
	if string(fxpWireCurrent.sessionInfo) != "forwardx-fxp-v2 session" {
		t.Fatalf("unexpected session context %q", string(fxpWireCurrent.sessionInfo))
	}
	if string(fxpWireCurrent.lengthAD) != "forwardx-fxp-v2 length" {
		t.Fatalf("unexpected length AD %q", string(fxpWireCurrent.lengthAD))
	}
	if string(fxpWireCurrent.payloadAD) != "forwardx-fxp-v2 payload" {
		t.Fatalf("unexpected payload AD %q", string(fxpWireCurrent.payloadAD))
	}
	if fxpWireCurrent.masterContext != "forwardx-fxp-v2 master" {
		t.Fatalf("unexpected master context %q", fxpWireCurrent.masterContext)
	}
	if string(fxpWireCompat2390.sessionInfo) != "forwardx-fxp session" {
		t.Fatalf("unexpected compat session context %q", string(fxpWireCompat2390.sessionInfo))
	}
	if fxpWireCompat2390.masterContext != "forwardx-fxp master" {
		t.Fatalf("unexpected compat master context %q", fxpWireCompat2390.masterContext)
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
