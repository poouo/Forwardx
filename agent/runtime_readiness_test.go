package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGostTunnelReadinessIgnoresUnhealthyDuplicateMainRuntime(t *testing.T) {
	const port = 61082
	snapshot := &runtimeListenSnapshot{
		tcpPorts: map[int][]string{
			port: {`tcp LISTEN 0 4096 *:61082 *:* users:(("forwardx-runtim",pid=42,fd=3))`},
		},
		udpPorts: map[int][]string{},
		usable:   true,
	}
	readiness := localRuntimeReadiness{
		gostRuntimePorts:           map[int]bool{port: true},
		tunnelRuntimePorts:         map[int]bool{port: true},
		gostRuntimePortProtocols:   map[int]map[string]bool{port: {"tcp": true}},
		tunnelRuntimePortProtocols: map[int]map[string]bool{port: {"tcp": true}},
		gostRuntimeReady:           false,
		tunnelRuntimeReady:         true,
		listenSnapshot:             snapshot,
	}

	if !readiness.gostReadyForPortInScope(port, "tcp", desiredGostTunnelRuntimeScope) {
		t.Fatal("healthy tunnel TLS listener was rejected because the duplicate main runtime was unhealthy")
	}
	if readiness.gostReadyForPortInScope(port, "tcp", desiredGostMainRuntimeScope) {
		t.Fatal("main runtime action unexpectedly adopted the tunnel runtime duplicate")
	}
}

func TestGostTunnelReadinessFallsBackToLegacyMainRuntimeLayout(t *testing.T) {
	const port = 64291
	snapshot := &runtimeListenSnapshot{
		tcpPorts: map[int][]string{
			port: {`tcp LISTEN 0 4096 *:64291 *:* users:(("gost",pid=43,fd=4))`},
		},
		udpPorts: map[int][]string{},
		usable:   true,
	}
	readiness := localRuntimeReadiness{
		gostRuntimePorts:         map[int]bool{port: true},
		tunnelRuntimePorts:       map[int]bool{},
		gostRuntimePortProtocols: map[int]map[string]bool{port: {"tcp": true}},
		gostRuntimeReady:         true,
		tunnelRuntimeReady:       false,
		listenSnapshot:           snapshot,
	}

	if !readiness.gostReadyForPortInScope(port, "tcp", desiredGostTunnelRuntimeScope) {
		t.Fatal("tunnel action did not accept the legacy main-runtime listener")
	}
}

func TestGostTLSListenerIsClassifiedAsTCP(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tunnel-gost.json")
	raw := []byte(`{"services":[{"name":"tls-exit","addr":":61082","listener":{"type":"tls"}}]}`)
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	listens, ok := readGostRuntimeServiceListens(path)
	if !ok || len(listens) != 1 {
		t.Fatalf("TLS listener parse ok=%v listens=%+v", ok, listens)
	}
	protocols := map[int]map[string]bool{}
	addRuntimePortProtocol(protocols, addrPort(listens[0].Addr), listens[0].Protocol)
	if !runtimePortProtocolConfigured(protocols, 61082, "tcp") {
		t.Fatalf("TLS listener was not mapped to TCP: %+v", protocols)
	}
}

func TestGostRuntimeReadinessCacheSeparatesMainAndTunnelScopes(t *testing.T) {
	mainKey := desiredRuntimeReadyCacheKey(61082, "tcp", desiredGostMainRuntimeScope)
	tunnelKey := desiredRuntimeReadyCacheKey(61082, "tcp", desiredGostTunnelRuntimeScope)
	if mainKey == tunnelKey {
		t.Fatalf("runtime scopes share cache key %q", mainKey)
	}
}
