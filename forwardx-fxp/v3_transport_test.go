package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/poouo/Forwardx/forwardx-fxp/internal/v3"
)

// TestV3UsesInnerRecordLayerOnEveryTransport checks that V3 always runs the
// ForwardX inner handshake and record layer, on all three outer transports. V3
// no longer wraps the legacy FXP secure handshake.
func TestV3UsesInnerRecordLayerOnEveryTransport(t *testing.T) {
	for _, mode := range []string{"http", "ws", "tls"} {
		t.Run(mode, func(t *testing.T) {
			// A real TCP pair is required: net.Pipe is synchronous, so the
			// deferred HTTP/WS response write would block against the peer's
			// inner handshake read.
			client, server := v3TestTCPPair(t)
			cfg := config{TransportVersion: "v3", V3Transport: mode, V3Host: "outer.example", V3Path: "/tunnel", V3ServerName: "outer.example", TunnelID: 301, Key: "test-v3-tunnel-secret"}
			serverErr := make(chan error, 1)
			go func() {
				wrapped, err := wrapV3Server(server, cfg)
				if err != nil {
					serverErr <- err
					return
				}
				inner, err := v3.InnerServer(wrapped, cfg.Key)
				if err != nil {
					serverErr <- err
					return
				}
				sec := &secureConn{conn: inner, logicalFrames: true}
				inner.SetDeadline(time.Now().Add(5 * time.Second))
				data, err := sec.readFrame()
				if err == nil {
					err = sec.writeFrame(data)
				}
				serverErr <- err
			}()
			conn, err := wrapV3Client(client, cfg)
			if err != nil {
				t.Fatal(err)
			}
			inner, err := v3.InnerClient(conn, cfg.Key)
			if err != nil {
				t.Fatal(err)
			}
			sec := &secureConn{conn: inner, logicalFrames: true}
			inner.SetDeadline(time.Now().Add(5 * time.Second))
			payload := bytes.Repeat([]byte{0, 255, 3, 17}, 17000)
			if err := sec.writeFrame(payload); err != nil {
				t.Fatal(err)
			}
			got, err := sec.readFrame()
			if err != nil || !bytes.Equal(got, payload) {
				t.Fatalf("payload mismatch length=%d err=%v", len(got), err)
			}
			if err := <-serverErr; err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestV3RejectsWrongTunnelKey(t *testing.T) {
	for _, mode := range []string{"http", "ws", "tls"} {
		t.Run(mode, func(t *testing.T) {
			client, server := v3TestTCPPair(t)
			defer client.Close()
			cfg := config{TransportVersion: "v3", V3Transport: mode, TunnelID: 302, Key: "correct-secret"}
			serverErr := make(chan error, 1)
			go func() {
				defer server.Close()
				_, err := newServerSecureConn(server, cfg)
				serverErr <- err
			}()
			wrong := cfg
			wrong.Key = "wrong-secret"
			if _, err := newClientSecureConn(client, wrong); err == nil {
				t.Fatal("wrong tunnel key was accepted")
			}
			client.Close()
			if err := <-serverErr; err == nil {
				t.Fatal("server accepted wrong tunnel key")
			}
		})
	}
}

func v3TestTCPPair(t *testing.T) (net.Conn, net.Conn) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	client, err := net.DialTimeout("tcp", listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	server, err := listener.Accept()
	if err != nil {
		client.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close(); server.Close() })
	return client, server
}

func TestV3TCPExitRoutesRealTarget(t *testing.T) {
	for _, mode := range []string{"http", "ws", "tls"} {
		t.Run(mode, func(t *testing.T) {
			target, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer target.Close()
			targetErr := make(chan error, 1)
			go func() {
				conn, err := target.Accept()
				if err != nil {
					targetErr <- err
					return
				}
				defer conn.Close()
				_, err = io.Copy(conn, conn)
				targetErr <- err
			}()
			exit, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer exit.Close()
			cfg := config{TransportVersion: "v3", V3Transport: mode, TunnelID: 303, Key: "routing-secret"}
			exitErr := make(chan error, 1)
			go func() {
				conn, err := exit.Accept()
				if err == nil {
					err = handleExitSession(conn, cfg)
				}
				exitErr <- err
			}()
			conn, sec, err := dialSecureTCP("127.0.0.1", exit.Addr().(*net.TCPAddr).Port, cfg, nil, "")
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			hello, _ := json.Marshal(helloFrame{Network: "tcp", TunnelID: 303, RuleID: 99, TargetIP: "127.0.0.1", TargetPort: target.Addr().(*net.TCPAddr).Port})
			if err := writeSecureHello(sec, hello); err != nil {
				t.Fatal(err)
			}
			sec.conn.SetDeadline(time.Now().Add(3 * time.Second))
			payload := bytes.Repeat([]byte("real-target-through-v3\x00"), 4000)
			if err := sec.writeFrame(payload); err != nil {
				t.Fatal(err)
			}
			var got []byte
			for len(got) < len(payload) {
				frame, err := sec.readFrame()
				if err != nil {
					t.Fatal(err)
				}
				got = append(got, frame...)
			}
			if !bytes.Equal(got, payload) {
				t.Fatal("real target payload mismatch")
			}
			if err := sec.writeFrame(nil); err != nil {
				t.Fatal(err)
			}
			frame, err := sec.readFrame()
			if err != nil || len(frame) != 0 {
				t.Fatalf("half-close response=%x err=%v", frame, err)
			}
			conn.Close()
			// The pool deliberately keeps the physical connection alive after a
			// logical stream closes. End this test's endpoint explicitly.
			key := v3PoolKey("127.0.0.1", exit.Addr().(*net.TCPAddr).Port, cfg)
			v3Outbound.mu.Lock()
			bucket := v3Outbound.buckets[key]
			if bucket != nil {
				for _, session := range bucket.sessions {
					session.Close()
				}
			}
			v3Outbound.mu.Unlock()
			if err := <-targetErr; err != nil && !isClosedErr(err) {
				t.Fatal(err)
			}
			if err := <-exitErr; err != nil && !isClosedErr(err) && !strings.Contains(err.Error(), "forcibly closed by the remote host") {
				t.Fatal(err)
			}
		})
	}
}

func TestV3ConfigDoesNotSilentlyDowngrade(t *testing.T) {
	for _, cfg := range []config{
		{TransportVersion: "v4"},
		{TransportVersion: "v3"},
		{TransportVersion: "v3", V3Transport: "wss"},
		{TransportVersion: "v1", V3Transport: "ws"},
		{TransportVersion: "v3", V3Transport: "http", V3Host: "host\r\n"},
		{TransportVersion: "v3", V3Transport: "tls", V3ServerName: "has space"},
	} {
		if err := validateTransportConfig(cfg); err == nil {
			t.Fatalf("invalid transport config accepted: %+v", cfg)
		}
	}
	for _, version := range []string{"", "v1", "v2"} {
		client, server := net.Pipe()
		defer client.Close()
		defer server.Close()
		cfg := config{TransportVersion: version}
		if err := validateTransportConfig(cfg); err != nil {
			t.Fatal(err)
		}
		if wrapped, err := wrapV3Client(client, cfg); err != nil || wrapped != client {
			t.Fatalf("legacy client changed version=%s err=%v", version, err)
		}
		if wrapped, err := wrapV3Server(server, cfg); err != nil || wrapped != server {
			t.Fatalf("legacy server changed version=%s err=%v", version, err)
		}
	}
}

func TestV3InvalidHTTPPathIsRejectedBeforeAuthentication(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	wrong := config{TransportVersion: "v3", V3Transport: "ws", V3Path: "/wrong", Key: "same-secret"}
	serverCfg := wrong
	serverCfg.V3Path = "/correct"
	done := make(chan error, 1)
	go func() {
		defer server.Close()
		_, err := newServerSecureConn(server, serverCfg)
		done <- err
	}()
	if _, err := newClientSecureConn(client, wrong); err == nil {
		t.Fatal("wrong HTTP path accepted")
	}
	if err := <-done; err == nil || errors.Is(err, io.EOF) {
		t.Fatalf("wrong path should be rejected by preface validation: %v", err)
	}
}
