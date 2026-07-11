package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRuntimePortProtocolConfiguredRequiresRequestedProtocols(t *testing.T) {
	ports := map[int]map[string]bool{}
	addRuntimePortProtocol(ports, 19750, "tcp")
	if !runtimePortProtocolConfigured(ports, 19750, "tcp") {
		t.Fatalf("tcp port should be configured")
	}
	if runtimePortProtocolConfigured(ports, 19750, "udp") {
		t.Fatalf("udp port should not be configured from tcp-only config")
	}
	if runtimePortProtocolConfigured(ports, 19750, "both") {
		t.Fatalf("both should require tcp and udp")
	}

	addRuntimePortProtocol(ports, 19750, "udp")
	if !runtimePortProtocolConfigured(ports, 19750, "both") {
		t.Fatalf("both should be configured after tcp and udp are present")
	}
}

func TestRuntimeListenSnapshotChecksProtocolAndOwner(t *testing.T) {
	snapshot := &runtimeListenSnapshot{
		tcpPorts: map[int][]string{},
		udpPorts: map[int][]string{},
	}
	snapshot.parseSSListenOutput(`
tcp LISTEN 0 4096 *:19750 *:* users:(("gost",pid=100,fd=7))
udp UNCONN 0 0 *:19750 *:* users:(("gost",pid=100,fd=8))
tcp LISTEN 0 4096 *:19751 *:* users:(("xray",pid=200,fd=7))
tcp LISTEN 0 4096 *:19752 *:*
tcp LISTEN 0 4096 *:19753 *:* users:(("forwardx-runtim",pid=300,fd=7))
udp UNCONN 0 0 *:19753 *:* users:(("forwardx-runtim",pid=300,fd=8))
`)

	if !runtimeListenPortReady(snapshot, 19750, "both", []string{"gost"}) {
		t.Fatalf("gost tcp+udp listener should satisfy both")
	}
	if runtimeListenPortReady(snapshot, 19751, "tcp", []string{"gost"}) {
		t.Fatalf("xray listener must not satisfy gost readiness when owner is visible")
	}
	if !runtimeListenPortReady(snapshot, 19751, "tcp", nil) {
		t.Fatalf("ownerless check should accept any tcp listener")
	}
	if !runtimeListenPortReady(snapshot, 19752, "tcp", []string{"gost"}) {
		t.Fatalf("listener without owner details should be accepted when socket is visible")
	}
	if runtimeListenPortReady(snapshot, 19752, "both", []string{"gost"}) {
		t.Fatalf("both should fail when udp listener is missing")
	}
	if !runtimeListenPortReady(snapshot, 19753, "both", []string{"gost", "forwardx-runt"}) {
		t.Fatalf("truncated forwardx-runtime process name should satisfy gost readiness")
	}
}

func TestProcNetLocalPort(t *testing.T) {
	if got := procNetLocalPort("00000000:4D26"); got != 19750 {
		t.Fatalf("procNetLocalPort() = %d, want 19750", got)
	}
	if got := procNetLocalPort("00000000:ZZZZ"); got != 0 {
		t.Fatalf("invalid proc port = %d, want 0", got)
	}
}

func TestSharedManagedRuntimeOwnedPortIsPreserved(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "gost.json")
	config := `{"services":[{"addr":":10007","listener":{"type":"tcp"}},{"addr":":10007","listener":{"type":"udp"}}]}`
	if err := os.WriteFile(configPath, []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	if !sharedManagedRuntimeOwnsPort(configPath, 10007) {
		t.Fatalf("shared runtime config owner should be preserved for busy port")
	}
	if sharedManagedRuntimeOwnsPort(configPath, 10008) {
		t.Fatalf("unconfigured port must not be treated as shared runtime owned")
	}
}
