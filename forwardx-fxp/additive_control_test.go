package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestControlledFXPAddsRulesWithoutDisconnectingTCPOrUDPSessions(t *testing.T) {
	for _, mode := range []string{"", "http", "ws", "tls"} {
		name := mode
		if name == "" {
			name = "legacy"
		}
		t.Run(name, func(t *testing.T) { testControlledFXPAddsRules(t, mode) })
	}
}

func testControlledFXPAddsRules(t *testing.T, mode string) {
	version := ""
	if mode != "" {
		version = "v3"
	}
	dir, err := os.MkdirTemp("", "fxp-add-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	targetPort := freeTCPUDPPort(t)
	tcpEcho, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(targetPort)))
	if err != nil {
		t.Fatal(err)
	}
	defer tcpEcho.Close()
	udpEcho, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: targetPort})
	if err != nil {
		t.Fatal(err)
	}
	defer udpEcho.Close()
	go func() {
		for {
			conn, err := tcpEcho.Accept()
			if err != nil {
				return
			}
			go func() { defer conn.Close(); _, _ = io.Copy(conn, conn) }()
		}
	}()
	go func() {
		buf := make([]byte, 4096)
		for {
			n, addr, err := udpEcho.ReadFromUDP(buf)
			if err != nil {
				return
			}
			_, _ = udpEcho.WriteToUDP(buf[:n], addr)
		}
	}()

	exitPort, firstPort, secondPort := freeTCPUDPPort(t), freeTCPUDPPort(t), freeTCPUDPPort(t)
	for firstPort == exitPort {
		firstPort = freeTCPUDPPort(t)
	}
	for secondPort == firstPort || secondPort == exitPort {
		secondPort = freeTCPUDPPort(t)
	}
	exit := normalizeConfig(config{TransportVersion: version, V3Transport: mode, Role: "exit", TunnelID: 991, Protocol: "both", ListenHost: "127.0.0.1", ListenPort: exitPort, Key: "additive-test", ControlSocket: filepath.Join(dir, "exit.sock"), UDPTargets: []udpTarget{{RuleID: 1, TargetIP: "127.0.0.1", TargetPort: targetPort}}})
	entry := func(id, port int) config {
		return normalizeConfig(config{TransportVersion: version, V3Transport: mode, Role: "entry", TunnelID: 991, RuleID: id, ListenHost: "127.0.0.1", ListenPort: port, Protocol: "both", ExitHost: "127.0.0.1", ExitPort: exitPort, TargetIP: "127.0.0.1", TargetPort: targetPort, Key: "additive-test"})
	}
	group := normalizeConfig(config{TransportVersion: version, V3Transport: mode, Role: "entry-group", TunnelID: 991, ControlSocket: filepath.Join(dir, "entry.sock"), Entries: []config{entry(1, firstPort)}})
	start := func(cfg config, port int) {
		done, result := make(chan struct{}), make(chan error, 1)
		go func() { result <- runControlledFXP(done, cfg) }()
		t.Cleanup(func() {
			close(done)
			select {
			case err := <-result:
				if err != nil {
					t.Error(err)
				}
			case <-time.After(10 * time.Second):
				t.Error("runtime shutdown timeout")
			}
		})
		waitForTCP(t, port)
	}
	start(exit, exitPort)
	start(group, firstPort)
	if version == "v3" {
		t.Cleanup(func() { closeV3TestEndpoint(exitPort, entry(1, firstPort)) })
	}
	client, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(firstPort)), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	udpClient, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: firstPort})
	if err != nil {
		t.Fatal(err)
	}
	defer udpClient.Close()
	check := func() {
		t.Helper()
		_ = client.SetDeadline(time.Now().Add(3 * time.Second))
		if _, err := client.Write([]byte("unchanged")); err != nil {
			t.Fatal(err)
		}
		reply := make([]byte, 9)
		if _, err := io.ReadFull(client, reply); err != nil || string(reply) != "unchanged" {
			t.Fatalf("old TCP session: %q %v", reply, err)
		}
		if string(udpRoundTrip(t, udpClient, []byte("same-session"))) != "same-session" {
			t.Fatal("old UDP session failed")
		}
	}
	post := func(cfg config, want int) {
		t.Helper()
		transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", cfg.ControlSocket)
		}}
		defer transport.CloseIdleConnections()
		data, _ := json.Marshal(cfg)
		response, err := (&http.Client{Transport: transport, Timeout: 5 * time.Second}).Post("http://unix/additive", "application/json", bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != want {
			body, _ := io.ReadAll(response.Body)
			t.Fatalf("HTTP=%d want=%d: %s", response.StatusCode, want, body)
		}
	}
	check()
	exit.UDPTargets = append(exit.UDPTargets, udpTarget{RuleID: 2, TargetIP: "127.0.0.1", TargetPort: targetPort})
	post(exit, http.StatusNoContent)
	group.Entries = append(group.Entries, entry(2, secondPort))
	post(group, http.StatusNoContent)
	post(group, http.StatusNoContent) // lost-reply retry is idempotent
	check()
	newUDP, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: secondPort})
	if err != nil {
		t.Fatal(err)
	}
	if string(udpRoundTrip(t, newUDP, []byte("new-rule"))) != "new-rule" {
		t.Fatal("new UDP target not applied")
	}
	newUDP.Close()
	newTCP, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(secondPort)), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_ = newTCP.SetDeadline(time.Now().Add(3 * time.Second))
	_, _ = newTCP.Write([]byte("new"))
	reply := make([]byte, 3)
	if _, err := io.ReadFull(newTCP, reply); err != nil || string(reply) != "new" {
		t.Fatalf("new TCP rule: %q %v", reply, err)
	}
	newTCP.Close()

	// A later port conflict must release earlier staged listeners, not old ones.
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	stagedPort := freeTCPUDPPort(t)
	conflict := group
	conflict.Entries = append(append([]config(nil), group.Entries...), entry(3, stagedPort), entry(4, occupied.Addr().(*net.TCPAddr).Port))
	post(conflict, http.StatusConflict)
	check()
	staged, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(stagedPort)))
	if err != nil {
		t.Fatalf("staged listener leaked: %v", err)
	}
	staged.Close()
	edited := group
	edited.Entries = append([]config(nil), group.Entries...)
	edited.Entries[0].TargetPort++
	post(edited, http.StatusConflict)
	post(normalizeConfig(config{Role: "entry-group", TunnelID: group.TunnelID, ControlSocket: group.ControlSocket, Entries: group.Entries[:1]}), http.StatusConflict)
	check()
}

func TestFXPControlRefusesToOverwriteRegularFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "control.sock")
	if err := os.WriteFile(path, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if listener, err := listenFXPControl(path); err == nil {
		listener.Close()
		t.Fatal("overwrote regular file")
	}
	data, _ := os.ReadFile(path)
	if string(data) != "keep" {
		t.Fatal("control path overwritten")
	}
}

func TestAdditiveControllerRecoversOnlyStoppedListener(t *testing.T) {
	ports := uniqueFreeTCPPorts(t, 2)
	entry := func(id, port int) config {
		return normalizeConfig(config{Role: "entry", TunnelID: 992, RuleID: id, ListenHost: "127.0.0.1", ListenPort: port, Protocol: "tcp", ExitHost: "127.0.0.1", ExitPort: 19092, TargetIP: "127.0.0.1", TargetPort: 443, Key: "recovery"})
	}
	cfg := normalizeConfig(config{Role: "entry-group", TunnelID: 992, Entries: []config{entry(1, ports[0]), entry(2, ports[1])}})
	done := make(chan struct{})
	runtime, err := newAdditiveFXPRuntime(done, cfg)
	if err != nil {
		t.Fatal(err)
	}
	runtime.start(runtime.runtimes)
	defer func() { close(done); runtime.wg.Wait() }()
	first, second := runtime.current[1], runtime.current[2]
	second.close()
	if err := runtime.apply(cfg); err != nil {
		t.Fatal(err)
	}
	if runtime.current[1] != first || first.closed.Load() || runtime.current[2] == second || len(runtime.runtimes) != 2 {
		t.Fatal("recovery changed healthy sibling or retained dead listener")
	}
	if err := runtime.apply(cfg); err != nil {
		t.Fatal(err)
	}
	if len(runtime.runtimes) != 2 {
		t.Fatal("idempotent recovery accumulated listeners")
	}
}
