package main

import (
	"net"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func failoverTestPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve test port: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatalf("release test port: %v", err)
	}
	return port
}

func failoverTestSpec(port int) failoverSpec {
	return failoverSpec{
		Enabled:         true,
		ListenPort:      port,
		BindAddress:     "127.0.0.1",
		Protocol:        "tcp",
		Strategy:        "fallback",
		FailoverSeconds: 60,
		RecoverSeconds:  120,
		AutoFailback:    true,
		Targets: []failoverTarget{
			{TargetIP: "127.0.0.1", TargetPort: 9},
			{TargetIP: "127.0.0.1", TargetPort: 10},
		},
	}
}

func currentFailoverProxy(ruleID int, sourcePort int) *failoverProxy {
	failoverMu.Lock()
	defer failoverMu.Unlock()
	return failoverProxies[failoverID(ruleID, sourcePort)]
}

func TestFailoverProxyReplacementKeepsWorkingListenerUntilNewBindSucceeds(t *testing.T) {
	oldPersistentDir := persistentFailoverDir
	persistentFailoverDir = filepath.Join(t.TempDir(), "failover")
	t.Cleanup(func() { persistentFailoverDir = oldPersistentDir })

	const ruleID = 910001
	const sourcePort = 61001
	t.Cleanup(func() { stopFailoverProxy(ruleID, sourcePort) })

	firstPort := failoverTestPort(t)
	firstSpec := failoverTestSpec(firstPort)
	if !startFailoverProxy(ruleID, sourcePort, firstSpec, nil) {
		t.Fatal("initial failover proxy did not start")
	}
	first := currentFailoverProxy(ruleID, sourcePort)
	if first == nil {
		t.Fatal("initial failover proxy was not registered")
	}

	hotUpdate := firstSpec
	hotUpdate.Targets = append([]failoverTarget(nil), firstSpec.Targets...)
	hotUpdate.Targets[1].TargetPort = 11
	if !startFailoverProxy(ruleID, sourcePort, hotUpdate, nil) {
		t.Fatal("same-listener failover update failed")
	}
	if current := currentFailoverProxy(ruleID, sourcePort); current != first {
		t.Fatal("same-listener update restarted the proxy")
	}

	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("open occupied test listener: %v", err)
	}
	occupiedPort := occupied.Addr().(*net.TCPAddr).Port
	blockedSpec := hotUpdate
	blockedSpec.ListenPort = occupiedPort
	if startFailoverProxy(ruleID, sourcePort, blockedSpec, nil) {
		_ = occupied.Close()
		t.Fatal("replacement unexpectedly bound an occupied port")
	}
	_ = occupied.Close()
	if current := currentFailoverProxy(ruleID, sourcePort); current != first {
		t.Fatal("failed replacement discarded the working proxy")
	}
	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(firstPort)), time.Second)
	if err != nil {
		t.Fatalf("working listener was lost after failed replacement: %v", err)
	}
	_ = conn.Close()

	replacementPort := failoverTestPort(t)
	replacementSpec := hotUpdate
	replacementSpec.ListenPort = replacementPort
	if !startFailoverProxy(ruleID, sourcePort, replacementSpec, nil) {
		t.Fatal("replacement failover proxy did not start")
	}
	if current := currentFailoverProxy(ruleID, sourcePort); current == nil || current == first {
		t.Fatal("replacement proxy was not installed")
	}
	conn, err = net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(replacementPort)), time.Second)
	if err != nil {
		t.Fatalf("replacement listener is unavailable: %v", err)
	}
	_ = conn.Close()
}
