package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
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

func TestLocalRuleManagedServiceGroupsUseProtocolQualifiedNames(t *testing.T) {
	tests := []struct {
		name        string
		forwardType string
		protocol    string
		want        [][]string
	}{
		{
			name:        "realm tcp with legacy fallback",
			forwardType: "realm",
			protocol:    "tcp",
			want:        [][]string{{"forwardx-realm-tcp-12001", "forwardx-realm-12001"}},
		},
		{
			name:        "socat udp protocol service",
			forwardType: "socat",
			protocol:    "udp",
			want:        [][]string{{"forwardx-socat-udp-12001"}},
		},
		{
			name:        "socat both requires both services",
			forwardType: "socat",
			protocol:    "both",
			want: [][]string{
				{"forwardx-socat-tcp-12001"},
				{"forwardx-socat-udp-12001"},
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := localRuleManagedServiceGroups(tt.forwardType, 12001, tt.protocol)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("service groups = %#v, want %#v", got, tt.want)
			}
		})
	}
}

func TestManagedPortCleanupCoversAllRealmServiceVariants(t *testing.T) {
	commands := strings.Join(managedPortCleanupCmds("12002"), "\n")
	for _, name := range []string{
		"forwardx-realm-12002",
		"forwardx-realm-tcp-12002",
		"forwardx-realm-udp-12002",
		"forwardx-realm-both-12002",
	} {
		if !strings.Contains(commands, name) {
			t.Fatalf("managed cleanup does not include %s", name)
		}
	}
}

func TestDesiredRuleSnapshotKeepsDisjointProtocolsOnSamePort(t *testing.T) {
	rememberDesiredRunningRules([]runningRule{
		{RuleID: 101, SourcePort: 12003, Protocol: "tcp", ForwardType: "socat", TargetIP: "192.0.2.10", TargetPort: 80},
		{RuleID: 102, SourcePort: 12003, Protocol: "udp", ForwardType: "socat", TargetIP: "192.0.2.11", TargetPort: 53},
	})
	t.Cleanup(func() { rememberDesiredRunningRules(nil) })
	states := desiredRunningRuleStatesSnapshot()
	if len(states) != 2 {
		t.Fatalf("desired state count = %d, want 2", len(states))
	}
	seen := map[string]bool{}
	for _, state := range states {
		seen[state.Protocol] = true
	}
	if !seen["tcp"] || !seen["udp"] {
		t.Fatalf("desired protocol states = %#v", seen)
	}
}

func TestMergeDesiredRuleStatesOnlyFillsDisjointProtocolLane(t *testing.T) {
	reported := []localRuleState{{Port: "12003", RuleID: 101, Protocol: "tcp"}}
	desired := []localRuleState{
		{Port: "12003", RuleID: 102, Protocol: "udp"},
		{Port: "12003", RuleID: 103, Protocol: "tcp"},
		{Port: "12004", RuleID: 104, Protocol: "udp"},
	}
	merged := mergeDesiredDisjointRuleStates(reported, desired)
	if len(merged) != 2 {
		t.Fatalf("merged state count = %d, want 2: %#v", len(merged), merged)
	}
	if merged[1].RuleID != 102 || merged[1].Protocol != "udp" {
		t.Fatalf("unexpected merged state: %#v", merged[1])
	}
}

func TestRuntimeProtocolOverlap(t *testing.T) {
	if runtimeProtocolsOverlap("tcp", "udp") {
		t.Fatal("disjoint TCP and UDP lanes were treated as overlapping")
	}
	if !runtimeProtocolsOverlap("both", "udp") || !runtimeProtocolsOverlap("tcp", "tcp") {
		t.Fatal("overlapping protocol lanes were treated as disjoint")
	}
}

func TestIptablesTargetCleanupUsesStoredProtocol(t *testing.T) {
	commands := strings.Join(iptablesAgentTargetCleanupCmds("12004", "192.0.2.20", 8080, "tcp"), "\n")
	if !strings.Contains(commands, "-p tcp") {
		t.Fatal("TCP cleanup commands are missing")
	}
	if strings.Contains(commands, "-p udp") {
		t.Fatal("TCP-only target cleanup unexpectedly removes the UDP lane")
	}
}

func TestFXPListenerConflictsAreProtocolAware(t *testing.T) {
	tcp := fxpSpec{ListenPort: 12005, Protocol: "tcp"}
	udp := fxpSpec{ListenPort: 12005, UDPListenPort: 12005, Protocol: "udp"}
	if fxpSpecsListenConflict(tcp, udp) {
		t.Fatal("disjoint FXP TCP and UDP listeners on the same numeric port conflict")
	}
	if !fxpSpecsListenConflict(fxpSpec{ListenPort: 12005, Protocol: "both"}, tcp) {
		t.Fatal("combined FXP listener did not conflict with its TCP lane")
	}
	if !fxpSpecsListenConflict(
		fxpSpec{ListenPort: 12006, UDPListenPort: 12007, Protocol: "udp"},
		fxpSpec{ListenPort: 12008, UDPListenPort: 12007, Protocol: "udp"},
	) {
		t.Fatal("FXP listeners sharing a dedicated mimic UDP port were not considered conflicting")
	}
}
