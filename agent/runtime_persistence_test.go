package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func usePersistentRuntimeTestDirs(t *testing.T) {
	t.Helper()
	oldRuntimeDir := persistentRuntimeDir
	oldFXPDir := persistentFXPDir
	oldWireGuardDir := persistentWireGuardDir
	oldFailoverDir := persistentFailoverDir
	persistentRuntimeDir = t.TempDir()
	persistentFXPDir = filepath.Join(persistentRuntimeDir, "fxp")
	persistentWireGuardDir = filepath.Join(persistentRuntimeDir, "wireguard")
	persistentFailoverDir = filepath.Join(persistentRuntimeDir, "failover")
	t.Cleanup(func() {
		persistentRuntimeDir = oldRuntimeDir
		persistentFXPDir = oldFXPDir
		persistentWireGuardDir = oldWireGuardDir
		persistentFailoverDir = oldFailoverDir
	})
}

func TestPersistFXPSpecScrubsPanelCredentialsAndSupportsPartialRemoval(t *testing.T) {
	usePersistentRuntimeTestDirs(t)
	spec := fxpSpec{
		Role: "entry", TransportVersion: "v1", TunnelID: 12, RuleID: 34,
		ListenPort: 23001, Protocol: "both", ExitHost: "198.51.100.2",
		ExitPort: 23002, Key: "runtime-secret", PanelURL: "https://panel.example.test",
		Token: "agent-token",
	}
	if err := persistFXPSpec(spec); err != nil {
		t.Fatalf("persist FXP spec: %v", err)
	}
	raw, err := os.ReadFile(persistentFXPPath(spec))
	if err != nil {
		t.Fatalf("read FXP snapshot: %v", err)
	}
	if strings.Contains(string(raw), "panel.example.test") || strings.Contains(string(raw), "agent-token") {
		t.Fatalf("FXP snapshot retained panel credentials: %s", raw)
	}
	loaded := loadPersistedFXPSpecs()
	if len(loaded) != 1 || loaded[0].TunnelID != spec.TunnelID || loaded[0].RuleID != spec.RuleID {
		t.Fatalf("unexpected FXP snapshots: %#v", loaded)
	}
	removePersistedFXPSpec(fxpSpec{Role: "entry", RuleID: spec.RuleID, ListenPort: spec.ListenPort})
	if loaded = loadPersistedFXPSpecs(); len(loaded) != 0 {
		t.Fatalf("partial FXP identity did not remove snapshot: %#v", loaded)
	}
}

func TestPersistedFXPRemovalRespectsProtocolLanes(t *testing.T) {
	usePersistentRuntimeTestDirs(t)
	base := fxpSpec{
		Role: "entry", TransportVersion: "v1", TunnelID: 13,
		ListenPort: 23013, ExitHost: "198.51.100.13", ExitPort: 23014,
		Key: "runtime-secret",
	}
	tcp := base
	tcp.RuleID = 35
	tcp.Protocol = "tcp"
	udp := base
	udp.RuleID = 36
	udp.Protocol = "udp"
	if err := persistFXPSpec(tcp); err != nil {
		t.Fatalf("persist TCP FXP spec: %v", err)
	}
	if err := persistFXPSpec(udp); err != nil {
		t.Fatalf("persist UDP FXP spec: %v", err)
	}
	removePersistedFXPSpec(fxpSpec{ListenPort: base.ListenPort, Protocol: "tcp"})
	loaded := loadPersistedFXPSpecs()
	if len(loaded) != 1 || loaded[0].RuleID != udp.RuleID {
		t.Fatalf("protocol-specific removal touched the wrong lane: %#v", loaded)
	}
}

func TestPersistWireGuardAndFailoverSpecs(t *testing.T) {
	usePersistentRuntimeTestDirs(t)
	wireGuard := wireGuardSpec{
		TunnelID:   18,
		PrivateKey: strings.Repeat("01", 32),
		Address:    "10.77.0.1",
		ListenPort: 51820,
		MTU:        1380,
	}
	if err := persistWireGuardSpec(wireGuard); err != nil {
		t.Fatalf("persist WireGuard spec: %v", err)
	}
	loadedWireGuard := loadPersistedWireGuardSpecs()
	if len(loadedWireGuard) != 1 || loadedWireGuard[0].TunnelID != wireGuard.TunnelID {
		t.Fatalf("unexpected WireGuard snapshots: %#v", loadedWireGuard)
	}
	removePersistedWireGuardSpec(wireGuard.TunnelID)
	if loadedWireGuard = loadPersistedWireGuardSpecs(); len(loadedWireGuard) != 0 {
		t.Fatalf("WireGuard snapshot was not removed: %#v", loadedWireGuard)
	}

	failover := failoverSpec{
		Enabled: true, ListenPort: 24001, BindAddress: "127.0.0.1", Protocol: "tcp",
		Strategy: "fallback", Targets: []failoverTarget{
			{TargetIP: "198.51.100.10", TargetPort: 443},
			{TargetIP: "198.51.100.11", TargetPort: 443},
		},
	}
	if err := persistFailoverSpec(45, 25001, failover); err != nil {
		t.Fatalf("persist failover spec: %v", err)
	}
	loadedFailovers := loadPersistedFailovers()
	if len(loadedFailovers) != 1 || loadedFailovers[0].RuleID != 45 || loadedFailovers[0].SourcePort != 25001 {
		t.Fatalf("unexpected failover snapshots: %#v", loadedFailovers)
	}
	removePersistedFailoverSpec(45, 25001)
	if loadedFailovers = loadPersistedFailovers(); len(loadedFailovers) != 0 {
		t.Fatalf("failover snapshot was not removed: %#v", loadedFailovers)
	}
}

func TestRuntimeStopPreservesSnapshotsUntilExplicitRemoval(t *testing.T) {
	usePersistentRuntimeTestDirs(t)

	fxp := fxpSpec{
		Role: "entry", TransportVersion: "v2", TunnelID: 21, RuleID: 22,
		ListenPort: 23021, Protocol: "both", ExitHost: "edge.example.test",
		ExitPort: 23022, Key: "runtime-secret",
	}
	if err := persistFXPSpec(fxp); err != nil {
		t.Fatalf("persist FXP spec: %v", err)
	}
	stopFXPRuntime(fxp)
	if loaded := loadPersistedFXPSpecs(); len(loaded) != 1 {
		t.Fatalf("runtime-only FXP stop removed snapshot: %#v", loaded)
	}
	stopFXP(fxp)
	if loaded := loadPersistedFXPSpecs(); len(loaded) != 0 {
		t.Fatalf("explicit FXP removal retained snapshot: %#v", loaded)
	}

	failover := failoverSpec{
		Enabled: true, ListenPort: 24021, BindAddress: "127.0.0.1", Protocol: "tcp",
		Strategy: "fallback", Targets: []failoverTarget{
			{TargetIP: "198.51.100.20", TargetPort: 443},
			{TargetIP: "198.51.100.21", TargetPort: 443},
		},
	}
	if err := persistFailoverSpec(23, 25021, failover); err != nil {
		t.Fatalf("persist failover spec: %v", err)
	}
	stopFailoverProxyRuntime(23, 25021)
	if loaded := loadPersistedFailovers(); len(loaded) != 1 {
		t.Fatalf("runtime-only failover stop removed snapshot: %#v", loaded)
	}
	stopFailoverProxy(23, 25021)
	if loaded := loadPersistedFailovers(); len(loaded) != 0 {
		t.Fatalf("explicit failover removal retained snapshot: %#v", loaded)
	}

	wireGuard := wireGuardSpec{
		TunnelID: 24, PrivateKey: strings.Repeat("01", 32), Address: "10.77.0.24",
		ListenPort: 51824, MTU: 1380,
	}
	if err := persistWireGuardSpec(wireGuard); err != nil {
		t.Fatalf("persist WireGuard spec: %v", err)
	}
	stopWireGuardRuntimeOnly(wireGuard.TunnelID)
	if loaded := loadPersistedWireGuardSpecs(); len(loaded) != 1 {
		t.Fatalf("runtime-only WireGuard stop removed snapshot: %#v", loaded)
	}
	stopWireGuardRuntime(wireGuard.TunnelID)
	if loaded := loadPersistedWireGuardSpecs(); len(loaded) != 0 {
		t.Fatalf("explicit WireGuard removal retained snapshot: %#v", loaded)
	}
}

func TestPreparedWireGuardFXPConfigIsNotMigratedAsOriginalPlan(t *testing.T) {
	prepared := fxpSpec{Role: "entry", TransportVersion: "v2", ExitHost: "127.0.0.1"}
	if !fxpSpecLooksPreparedForWireGuard(prepared) {
		t.Fatal("expected loopback V2 endpoint to be recognized as a translated runtime config")
	}
	original := fxpSpec{Role: "entry", TransportVersion: "v2", ExitHost: "edge.example.test"}
	if fxpSpecLooksPreparedForWireGuard(original) {
		t.Fatal("original V2 endpoint was incorrectly treated as translated")
	}
	legacy := fxpSpec{Role: "entry", TransportVersion: "v1", ExitHost: "127.0.0.1"}
	if fxpSpecLooksPreparedForWireGuard(legacy) {
		t.Fatal("V1 config must remain migratable")
	}
}
