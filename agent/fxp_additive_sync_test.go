package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestFXPAdditiveSyncPreservesInstallationIdentity(t *testing.T) {
	isolateAgentInstallation(t)
	usePersistentRuntimeTestDirs(t)
	previousPanelURL, _ := runtimePanelURL.Load().(string)
	runtimePanelURL.Store("")
	t.Cleanup(func() { runtimePanelURL.Store(previousPanelURL) })
	dir, err := os.MkdirTemp("", "fxp-id-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	cfg := Config{PanelURL: "https://panel.example.test", Token: "test-panel-token"}
	if err := initializeAgentInstallation(filepath.Join(dir, "agent.json"), cfg.Token); err != nil {
		t.Fatal(err)
	}
	for _, version := range []string{"v1", "v3"} {
		t.Run(version, func(t *testing.T) {
			first := testV1EntrySpec(17, 1, 24001)
			first.TransportVersion = version
			initial, _ := buildSharedFXPEntryGroup([]fxpSpec{first}, 17, version)
			path := filepath.Join(dir, version+".json")
			// Match the full-start path: Runtime already holds an installation-
			// bound entry, but the desired/persisted plan has no Agent credentials.
			committed := cloneFXPSpecForAdditive(initial)
			committed.ControlSocket = path + ".sock"
			committed.Entries[0].PanelURL = currentPanelURL(cfg)
			committed.Entries[0].Token = cfg.Token
			committed.Entries[0].InstallationID = currentAgentInstallationID()
			raw, _ := json.Marshal(committed)
			if err := os.WriteFile(path, raw, 0600); err != nil {
				t.Fatal(err)
			}
			listener, err := net.Listen("unix", committed.ControlSocket)
			if err != nil {
				t.Fatal(err)
			}
			server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				var next fxpSpec
				if err := json.NewDecoder(request.Body).Decode(&next); err != nil {
					http.Error(w, "invalid config", http.StatusBadRequest)
					return
				}
				next = normalizeFXPSpec(next)
				// Emulate Runtime's strict existing-entry comparison, rather than
				// accepting every request as the original additive API fixture did.
				for index, entry := range committed.Entries {
					if len(next.Entries) <= index || !reflect.DeepEqual(entry, next.Entries[index]) {
						http.Error(w, "existing entry changed or removed", http.StatusConflict)
						return
					}
				}
				for _, entry := range next.Entries {
					if entry.InstallationID != currentAgentInstallationID() || entry.PanelURL != currentPanelURL(cfg) || entry.Token != cfg.Token {
						http.Error(w, "new entry missing Agent identity", http.StatusConflict)
						return
					}
				}
				committed = next
				w.WriteHeader(http.StatusNoContent)
			})}
			defer server.Close()
			go server.Serve(listener)
			process := &fxpProcess{configPath: path, spec: initial, signature: fxpServerSignature(initial)}
			for count := 2; count <= 4; count++ {
				entries := []fxpSpec{first}
				for id := 2; id <= count; id++ {
					entry := first
					entry.RuleID, entry.ListenPort = id, 24000+id
					entries = append(entries, entry)
				}
				desired, _ := buildSharedFXPEntryGroup(entries, 17, version)
				message := newActionMessage()
				if !syncFXPAdditive(cfg, process, desired, true, message) {
					t.Fatalf("add entry %d failed: %s", count, message.get())
				}
				// Retrying a committed batch must also preserve its identity.
				if !syncFXPAdditive(cfg, process, desired, true, message) {
					t.Fatalf("retry failed: %s", message.get())
				}
				for _, plan := range []fxpSpec{desired, process.spec} {
					for _, entry := range plan.Entries {
						if entry.PanelURL != "" || entry.Token != "" || entry.InstallationID != "" {
							t.Fatal("runtime identity leaked into the desired plan")
						}
					}
				}
				data, err := os.ReadFile(path)
				var saved fxpSpec
				if err != nil || json.Unmarshal(data, &saved) != nil || len(saved.Entries) != count || saved.Entries[0].InstallationID != currentAgentInstallationID() {
					t.Fatal("runtime config did not retain installation identity")
				}
			}
		})
	}
}

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
	isolateAgentInstallation(t)
	cfg := Config{PanelURL: "https://panel.example.test", Token: "v2-add-test-token"}
	if err := initializeAgentInstallation(filepath.Join(t.TempDir(), "config.json"), cfg.Token); err != nil {
		t.Fatal(err)
	}
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
	prepared = withFXPAgentIdentity(prepared, cfg)
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
		if !syncFXPAdditive(cfg, process, desired, true, newActionMessage()) {
			t.Fatal("V2 sync failed")
		}
		actual := <-requests
		for _, entry := range actual.Entries {
			if entry.InstallationID != currentAgentInstallationID() || entry.PanelURL != currentPanelURL(cfg) || entry.Token != cfg.Token {
				t.Fatal("V2 additive entry lost its Agent identity")
			}
		}
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
