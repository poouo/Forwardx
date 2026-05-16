package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestFXPTCPRelayRoundTrip(t *testing.T) {
	echoLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echoLn.Close()
	go func() {
		for {
			conn, err := echoLn.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				_, _ = io.Copy(c, c)
			}(conn)
		}
	}()

	exitPort := freeTCPPort(t)
	entryPort := freeTCPPort(t)
	_, targetPortText, _ := net.SplitHostPort(echoLn.Addr().String())
	targetPort, _ := strconv.Atoi(targetPortText)

	exitSpec := fxpSpec{
		Role:       "exit",
		TunnelID:   9001,
		RuleID:     0,
		ListenPort: exitPort,
		Protocol:   "tcp",
		Key:        "unit-test-key",
	}
	entrySpec := fxpSpec{
		Role:       "entry",
		TunnelID:   9001,
		RuleID:     9002,
		ListenPort: entryPort,
		Protocol:   "tcp",
		ExitHost:   "127.0.0.1",
		ExitPort:   exitPort,
		TargetIP:   "127.0.0.1",
		TargetPort: targetPort,
		Key:        "unit-test-key",
	}
	if !startFXP(exitSpec) {
		t.Fatal("exit fxp did not start")
	}
	defer stopFXP(exitSpec)
	if !startFXP(entrySpec) {
		t.Fatal("entry fxp did not start")
	}
	defer stopFXP(entrySpec)

	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort)), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))

	want := "hello-forwardx\n"
	if _, err := conn.Write([]byte(want)); err != nil {
		t.Fatal(err)
	}
	got, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestFXPTCPRelayLargePayload(t *testing.T) {
	echoLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echoLn.Close()
	go func() {
		for {
			conn, err := echoLn.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				_, _ = io.Copy(c, c)
			}(conn)
		}
	}()

	exitPort := freeTCPPort(t)
	entryPort := freeTCPPort(t)
	_, targetPortText, _ := net.SplitHostPort(echoLn.Addr().String())
	targetPort, _ := strconv.Atoi(targetPortText)

	exitSpec := fxpSpec{Role: "exit", TunnelID: 9011, ListenPort: exitPort, Protocol: "tcp", Key: "unit-test-key-large"}
	entrySpec := fxpSpec{
		Role:       "entry",
		TunnelID:   9011,
		RuleID:     9012,
		ListenPort: entryPort,
		Protocol:   "tcp",
		ExitHost:   "127.0.0.1",
		ExitPort:   exitPort,
		TargetIP:   "127.0.0.1",
		TargetPort: targetPort,
		Key:        "unit-test-key-large",
	}
	if !startFXP(exitSpec) {
		t.Fatal("exit fxp did not start")
	}
	defer stopFXP(exitSpec)
	if !startFXP(entrySpec) {
		t.Fatal("entry fxp did not start")
	}
	defer stopFXP(entrySpec)

	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort)), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))

	want := make([]byte, 1024*1024)
	if _, err := rand.Read(want); err != nil {
		t.Fatal(err)
	}
	errc := make(chan error, 1)
	go func() {
		_, err := conn.Write(want)
		errc <- err
	}()
	got := make([]byte, len(want))
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatal(err)
	}
	if err := <-errc; err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("large payload mismatch")
	}
}

func freeTCPPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	_, p, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(strings.TrimSpace(p))
	if err != nil {
		t.Fatal(fmt.Errorf("parse port %q: %w", p, err))
	}
	return port
}
