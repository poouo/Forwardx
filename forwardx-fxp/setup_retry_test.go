package main

import (
	"errors"
	"io"
	"net"
	"testing"
)

func TestSetupRetryBeforePayload(t *testing.T) {
	selector := newExitEndpointSelector([]exitEndpoint{{Host: "first", Port: 443}, {Host: "second", Port: 443}}, exitEndpoint{}, "fallback")
	var attempts []string
	received := make(chan []byte, 1)
	var peer net.Conn
	defer func() {
		if peer != nil {
			peer.Close()
		}
	}()
	dial := func(host string, port int, cfg config, ignored *exitEndpointSelector, key string) (net.Conn, *secureConn, error) {
		attempts = append(attempts, host)
		local, remote := net.Pipe()
		if host == "first" {
			local.Close()
			remote.Close()
		} else {
			peer = remote
			go func() {
				frame, _ := (&secureConn{conn: remote, logicalFrames: true}).readFrame()
				received <- frame
				remote.Close()
			}()
		}
		return local, &secureConn{conn: local, logicalFrames: true}, nil
	}
	conn, _, endpoint, err := dialSelectedSetup(selector, config{}, "client", func(sec *secureConn) error { return writeSecureHello(sec, []byte("hello-only")) }, dial)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if len(attempts) != 2 || endpoint.Host != "second" {
		t.Fatalf("attempts=%v endpoint=%v", attempts, endpoint)
	}
	// Both endpoints deliberately use the same port: reporting must not pick the first by port.
	if frame := <-received; string(frame) != "hello-only" {
		t.Fatalf("unexpected setup bytes: %q", frame)
	}
}

func TestSetupNeverRetriesPayloadOrUnboundedly(t *testing.T) {
	selector := newExitEndpointSelector([]exitEndpoint{{Host: "first", Port: 1}, {Host: "second", Port: 2}}, exitEndpoint{}, "fallback")
	attempts := 0
	dial := func(string, int, config, *exitEndpointSelector, string) (net.Conn, *secureConn, error) {
		attempts++
		return nil, nil, io.ErrUnexpectedEOF
	}
	_, _, _, err := dialSelectedSetup(selector, config{}, "client", nil, dial)
	if !errors.Is(err, io.ErrUnexpectedEOF) || attempts != 2 {
		t.Fatalf("err=%v attempts=%d", err, attempts)
	}
}
