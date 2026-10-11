package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestFXPAdditionPlanPreservesExistingV1AndV2Members(t *testing.T) {
	for _, version := range []string{"v1", forwardXWireGuardVersion} {
		first := testV1EntrySpec(17, 1, 24001)
		first.TransportVersion = version
		second := first
		second.RuleID, second.ListenPort = 2, 24002
		old, _ := buildSharedFXPEntryGroup([]fxpSpec{first}, 17, version)
		next, _ := buildSharedFXPEntryGroup([]fxpSpec{first, second}, 17, version)
		if !fxpIsAdditiveUpdate(old, next) {
			t.Fatal("addition rejected", version)
		}
		if fxpIsAdditiveUpdate(next, old) {
			t.Fatal("removal accepted", version)
		}
		next.Entries[0].ProxyProtocolSend = true
		if fxpIsAdditiveUpdate(old, next) {
			t.Fatal("edit accepted", version)
		}
	}
}

func TestFXPV2AdditiveSyncKeepsExistingProxiesAndBoundsReferences(t *testing.T) {
	usePersistentRuntimeTestDirs(t)
	const tunnelID = 98521
	runtime := &wireGuardRuntime{spec: wireGuardSpec{TunnelID: tunnelID}, peers: map[string]wireGuardPeerSpec{
		"exit-a": {ID: "exit-a", Address: "100.110.0.2"},
		"exit-b": {ID: "exit-b", Address: "100.110.0.3"},
	}, outbound: map[string]*wireGuardOutboundProxy{}, inbound: map[string]*wireGuardInboundProxy{}, refs: map[string]int{}}
	setTestWireGuardRuntime(t, tunnelID, runtime)
	t.Cleanup(runtime.close)
	first := testV2EntrySpec(tunnelID, 1, 25001, "exit-a")
	second := testV2EntrySpec(tunnelID, 2, 25002, "exit-b")
	third := testV2EntrySpec(tunnelID, 3, 25003, "exit-b")
	third.ExitPort, third.UDPExitPort = 24001, 24001
	initial, _ := buildSharedFXPEntryGroup([]fxpSpec{first}, tunnelID, forwardXWireGuardVersion)
	prepared, err := prepareFXPWireGuard(initial, "base-process")
	if err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp("", "fxp-v2-add-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "fxp.json")
	prepared.ControlSocket = path + ".sock"
	raw, _ := json.Marshal(prepared)
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", prepared.ControlSocket)
	if err != nil {
		t.Fatal(err)
	}
	requests := make(chan fxpSpec, 4)
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		var desired fxpSpec
		if err := json.NewDecoder(request.Body).Decode(&desired); err != nil {
			t.Error(err)
		}
		requests <- desired
		w.WriteHeader(http.StatusNoContent)
	})}
	defer server.Close()
	go server.Serve(listener)
	// A sentinel process handle is sufficient: the additive path must never
	// signal/restart it. No external service or real process is modified.
	process := &fxpProcess{cmd: &exec.Cmd{Process: &os.Process{Pid: -1}}, configPath: path, spec: initial, signature: fxpServerSignature(initial), wireGuardRefID: "base-process"}
	id := fxpServerID(initial)
	fxpMu.Lock()
	previous := fxpServers[id]
	fxpServers[id] = process
	fxpMu.Unlock()
	t.Cleanup(func() {
		fxpMu.Lock()
		if previous == nil {
			delete(fxpServers, id)
		} else {
			fxpServers[id] = previous
		}
		fxpMu.Unlock()
	})
	for _, entries := range [][]fxpSpec{{first, second}, {first, second, third}} {
		desired, _ := buildSharedFXPEntryGroup(entries, tunnelID, forwardXWireGuardVersion)
		if !syncFXPAdditive(Config{}, process, desired, true, newActionMessage()) {
			t.Fatal("V2 sync failed")
		}
		actual := <-requests
		if actual.Entries[0].ExitPort != prepared.Entries[0].ExitPort {
			t.Fatal("old proxy was replaced")
		}
		if desired.Entries[0].ExitPort != first.ExitPort || process.spec.Entries[0].ExitHost != first.ExitHost {
			t.Fatal("desired/persistent plan contains local proxy coordinates")
		}
		ref := wireGuardRefIDForFXPSpec(desired)
		if ref == "base-process" || !wireGuardFXPProxiesMatchConfig(desired, actual, ref) {
			t.Fatal("new group lacks full proxy ownership")
		}
		runtime.mu.RLock()
		refs := len(runtime.refs)
		runtime.mu.RUnlock()
		if refs != 2 {
			t.Fatalf("references grew with batch count: %d", refs)
		}
	}
}

func TestFXPAdditionPlanUDPAndOutOfOrderBatchSnapshots(t *testing.T) {
	old := fxpSpec{Role: "exit", TunnelID: 17, ListenPort: 24000, Key: "test", Protocol: "both", UDPTargets: []fxpUDPTarget{{RuleID: 1, TargetIP: "192.0.2.1", TargetPort: 53}}}
	next := old
	next.UDPTargets = append(append([]fxpUDPTarget(nil), old.UDPTargets...), fxpUDPTarget{RuleID: 2, TargetIP: "192.0.2.2", TargetPort: 53})
	if !fxpIsAdditiveUpdate(old, next) {
		t.Fatal("UDP addition rejected")
	}
	next.DNSGeneration++
	if fxpIsAdditiveUpdate(old, next) {
		t.Fatal("DNS edit accepted")
	}
	first, second := testV1EntrySpec(17, 1, 24001), testV1EntrySpec(17, 2, 24002)
	third := testV1EntrySpec(17, 3, 24003)
	running, _ := buildSharedFXPEntryGroup([]fxpSpec{first, second}, 17, "v1")
	queued, _ := buildSharedFXPEntryGroup([]fxpSpec{first, third}, 17, "v1")
	merged := mergeFXPApplyGroup(running, queued)
	requireFXPEntryGroupMembers(t, merged, first, second, third)
	if !fxpIsAdditiveUpdate(running, merged) {
		t.Fatal("out-of-order add would restart process")
	}
}

func TestFXPIncrementalAPIFailureNeverChangesCommittedPlan(t *testing.T) {
	dir, err := os.MkdirTemp("", "fxp-agent-add-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "fxp.json")
	first, second := testV1EntrySpec(17, 1, 24001), testV1EntrySpec(17, 2, 24002)
	old, _ := buildSharedFXPEntryGroup([]fxpSpec{first}, 17, "v1")
	next, _ := buildSharedFXPEntryGroup([]fxpSpec{first, second}, 17, "v1")
	old.ControlSocket = path + ".sock"
	raw, _ := json.Marshal(old)
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	process := &fxpProcess{configPath: path, spec: old, signature: fxpServerSignature(old)}
	message := newActionMessage()
	if syncFXPAdditive(Config{}, process, next, false, message) {
		t.Fatal("missing API accepted")
	}
	committed, _ := os.ReadFile(path)
	if string(committed) != string(raw) || process.signature != fxpServerSignature(old) {
		t.Fatal("failed addition modified committed plan")
	}
	listener, err := net.Listen("unix", old.ControlSocket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusConflict) })}
	defer server.Close()
	go server.Serve(listener)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if requestFXPAddition(ctx, old.ControlSocket, raw) == nil {
		t.Fatal("API conflict ignored")
	}
	if syncFXPAdditive(Config{}, process, next, false, message) {
		t.Fatal("API conflict accepted")
	}
	committed, _ = os.ReadFile(path)
	if string(committed) != string(raw) {
		t.Fatal("API conflict changed config")
	}
}
