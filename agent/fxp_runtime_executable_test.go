package main

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func withFXPRuntimeExecutableHooks(
	t *testing.T,
	resolve func() (string, error),
	list func(string) []int,
	matches func(int, string) bool,
) {
	t.Helper()
	previousResolve := resolveFXPRuntimeExecutable
	previousList := listFXPRuntimePIDs
	previousMatches := fxpPIDUsesExecutable
	resolveFXPRuntimeExecutable = resolve
	listFXPRuntimePIDs = list
	fxpPIDUsesExecutable = matches
	t.Cleanup(func() {
		resolveFXPRuntimeExecutable = previousResolve
		listFXPRuntimePIDs = previousList
		fxpPIDUsesExecutable = previousMatches
	})
}

func TestFXPRuntimeUsesCurrentExecutableRejectsStaleProcess(t *testing.T) {
	withFXPRuntimeExecutableHooks(
		t,
		func() (string, error) { return "/usr/local/bin/forwardx-fxp", nil },
		func(string) []int { return []int{101, 102} },
		func(pid int, runtimePath string) bool {
			return runtimePath == "/usr/local/bin/forwardx-fxp" && pid == 101
		},
	)
	if fxpRuntimeUsesCurrentExecutable("/run/forwardx-agent/fxp-entry.json") {
		t.Fatal("runtime adoption accepted a process still using the replaced FXP executable")
	}
}

func TestFXPRuntimeUsesCurrentExecutableAcceptsMatchingProcesses(t *testing.T) {
	withFXPRuntimeExecutableHooks(
		t,
		func() (string, error) { return "/usr/local/bin/forwardx-fxp", nil },
		func(string) []int { return []int{201, 202} },
		func(int, string) bool { return true },
	)
	if !fxpRuntimeUsesCurrentExecutable("/run/forwardx-agent/fxp-entry.json") {
		t.Fatal("runtime adoption rejected processes using the current FXP executable")
	}
}

func TestFXPRuntimeUsesCurrentExecutableRequiresRuntimeAndProcess(t *testing.T) {
	withFXPRuntimeExecutableHooks(
		t,
		func() (string, error) { return "", errors.New("runtime missing") },
		func(string) []int { return []int{301} },
		func(int, string) bool { return true },
	)
	if fxpRuntimeUsesCurrentExecutable("/run/forwardx-agent/fxp-entry.json") {
		t.Fatal("runtime adoption succeeded without an installed FXP executable")
	}

	resolveFXPRuntimeExecutable = func() (string, error) { return "/usr/local/bin/forwardx-fxp", nil }
	listFXPRuntimePIDs = func(string) []int { return nil }
	if fxpRuntimeUsesCurrentExecutable("/run/forwardx-agent/fxp-entry.json") {
		t.Fatal("runtime adoption succeeded without a running FXP process")
	}
}

func TestAdoptExistingFXPRejectsStaleExecutable(t *testing.T) {
	spec := normalizeFXPSpec(fxpSpec{
		Role:             "entry",
		TransportVersion: "v1",
		TunnelID:         41,
		RuleID:           42,
		ListenPort:       31442,
		Protocol:         "tcp",
		Key:              "upgrade-test-key",
	})
	raw, err := json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(t.TempDir(), "fxp-entry.json")
	if err := os.WriteFile(configPath, raw, 0600); err != nil {
		t.Fatal(err)
	}
	withFXPRuntimeExecutableHooks(
		t,
		func() (string, error) { return "/usr/local/bin/forwardx-fxp", nil },
		func(string) []int { return []int{401} },
		func(int, string) bool { return false },
	)

	id := fxpServerID(spec)
	fxpMu.Lock()
	previous := fxpServers[id]
	delete(fxpServers, id)
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

	if adoptExistingFXP(spec, fxpServerSignature(spec), configPath) {
		t.Fatal("stale FXP executable was adopted after an Agent/runtime upgrade")
	}
	fxpMu.Lock()
	adopted := fxpServers[id]
	fxpMu.Unlock()
	if adopted != nil {
		t.Fatal("stale FXP executable was added to the tracked runtime set")
	}
}

func TestFXPProcessUsesCurrentExecutableDetectsBinaryReplacement(t *testing.T) {
	directory := t.TempDir()
	previousPath := filepath.Join(directory, "forwardx-fxp.previous")
	currentPath := filepath.Join(directory, "forwardx-fxp.current")
	if err := os.WriteFile(previousPath, []byte("previous"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(currentPath, []byte("current"), 0700); err != nil {
		t.Fatal(err)
	}
	previousInfo, err := os.Stat(previousPath)
	if err != nil {
		t.Fatal(err)
	}
	currentInfo, err := os.Stat(currentPath)
	if err != nil {
		t.Fatal(err)
	}
	withFXPRuntimeExecutableHooks(
		t,
		func() (string, error) { return currentPath, nil },
		func(string) []int { return nil },
		func(int, string) bool { return false },
	)
	process := &fxpProcess{
		cmd:               &exec.Cmd{Process: &os.Process{Pid: os.Getpid()}},
		runtimeExecutable: previousInfo,
	}
	if fxpProcessUsesCurrentExecutable(process) {
		t.Fatal("tracked FXP process was reused after the installed binary changed")
	}
	process.runtimeExecutable = currentInfo
	if !fxpProcessUsesCurrentExecutable(process) {
		t.Fatal("tracked FXP process using the installed binary was rejected")
	}
}

func TestFXPRuntimePanelCredentialsMustMatchCurrentAgent(t *testing.T) {
	spec := normalizeFXPSpec(fxpSpec{
		Role:             "entry",
		TransportVersion: "v1",
		TunnelID:         51,
		RuleID:           52,
		ListenPort:       31552,
		Protocol:         "tcp",
		Key:              "credential-test-key",
		PanelURL:         "https://old-panel.example/",
		Token:            "old-token",
	})
	raw, err := json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(t.TempDir(), "fxp-entry.json")
	if err := os.WriteFile(configPath, raw, 0600); err != nil {
		t.Fatal(err)
	}

	oldDigest := fxpPanelCredentialDigest("https://old-panel.example", "old-token")
	newDigest := fxpPanelCredentialDigest("https://new-panel.example", "new-token")
	if !fxpRuntimeUsesPanelCredentialDigest(configPath, oldDigest) {
		t.Fatal("matching FXP panel credentials were rejected")
	}
	if fxpRuntimeUsesPanelCredentialDigest(configPath, newDigest) {
		t.Fatal("FXP runtime with stale panel URL/token was treated as current")
	}
	process := &fxpProcess{spec: spec, panelCredentialDigest: oldDigest}
	if fxpProcessUsesPanelCredentialDigest(process, newDigest) {
		t.Fatal("tracked FXP runtime kept stale panel credentials")
	}
}

func TestFXPMatchesRunningRejectsStalePanelCredentialsForV1AndV2(t *testing.T) {
	testExecutable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	testExecutableInfo, err := os.Stat(testExecutable)
	if err != nil {
		t.Fatal(err)
	}
	withFXPRuntimeExecutableHooks(
		t,
		func() (string, error) { return testExecutable, nil },
		func(string) []int { return []int{os.Getpid()} },
		func(pid int, runtimePath string) bool { return pid == os.Getpid() && runtimePath == testExecutable },
	)

	previousPanelURL, _ := runtimePanelURL.Load().(string)
	previousToken, _ := runtimeAgentToken.Load().(string)
	setRuntimePanelURL("https://current-panel.example")
	runtimeAgentToken.Store("current-token")
	t.Cleanup(func() {
		runtimePanelURL.Store(previousPanelURL)
		runtimeAgentToken.Store(previousToken)
	})

	for index, transportVersion := range []string{"v1", forwardXWireGuardVersion} {
		t.Run(transportVersion, func(t *testing.T) {
			entry := normalizeFXPSpec(fxpSpec{
				Role:             "entry",
				TransportVersion: transportVersion,
				TunnelID:         81 + index,
				RuleID:           91 + index,
				ListenPort:       31891 + index,
				Protocol:         "tcp",
				Key:              "credential-drift-key",
			})
			group, ok := buildSharedFXPEntryGroup([]fxpSpec{entry}, entry.TunnelID, transportVersion)
			if !ok {
				t.Fatal("failed to build FXP entry group")
			}
			withTestFXPServers(t, map[string]*fxpProcess{
				fxpServerID(group): {
					signature:             fxpServerSignature(group),
					cmd:                   &exec.Cmd{Process: &os.Process{Pid: os.Getpid()}},
					spec:                  group,
					runtimeExecutable:     testExecutableInfo,
					panelCredentialDigest: fxpPanelCredentialDigest("https://old-panel.example", "old-token"),
				},
			})

			if fxpMatchesRunning(&entry, &group) {
				t.Fatalf("%s FXP entry group with stale panel credentials was treated as running", transportVersion)
			}
		})
	}
}

func TestAdoptExistingFXPRejectsStalePanelCredentials(t *testing.T) {
	spec := normalizeFXPSpec(fxpSpec{
		Role:             "entry",
		TransportVersion: "v1",
		TunnelID:         61,
		RuleID:           62,
		ListenPort:       31662,
		Protocol:         "tcp",
		Key:              "credential-adoption-key",
	})
	runtimeSpec := spec
	runtimeSpec.PanelURL = "https://old-panel.example"
	runtimeSpec.Token = "old-token"
	raw, err := json.Marshal(runtimeSpec)
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(t.TempDir(), "fxp-entry.json")
	if err := os.WriteFile(configPath, raw, 0600); err != nil {
		t.Fatal(err)
	}
	withFXPRuntimeExecutableHooks(
		t,
		func() (string, error) { return "/usr/local/bin/forwardx-fxp", nil },
		func(string) []int { return []int{601} },
		func(int, string) bool { return true },
	)
	currentDigest := fxpPanelCredentialDigest("https://new-panel.example", "new-token")
	if adoptExistingFXP(spec, fxpServerSignature(spec), configPath, currentDigest) {
		t.Fatal("FXP process reporting to stale panel credentials was adopted")
	}
}

func TestFXPRuntimeReadinessRejectsTrackedOldExecutable(t *testing.T) {
	entry := normalizeFXPSpec(fxpSpec{
		Role:             "entry",
		TransportVersion: "v1",
		TunnelID:         71,
		RuleID:           72,
		ListenPort:       31772,
		Protocol:         "tcp",
		Key:              "readiness-upgrade-key",
	})
	group, ok := buildSharedFXPEntryGroup([]fxpSpec{entry}, entry.TunnelID, entry.TransportVersion)
	if !ok {
		t.Fatal("failed to build FXP entry group")
	}
	directory := t.TempDir()
	previousPath := filepath.Join(directory, "forwardx-fxp.previous")
	currentPath := filepath.Join(directory, "forwardx-fxp.current")
	if err := os.WriteFile(previousPath, []byte("previous"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(currentPath, []byte("current"), 0700); err != nil {
		t.Fatal(err)
	}
	previousInfo, err := os.Stat(previousPath)
	if err != nil {
		t.Fatal(err)
	}
	withFXPRuntimeExecutableHooks(
		t,
		func() (string, error) { return currentPath, nil },
		func(string) []int { return nil },
		func(int, string) bool { return false },
	)
	withTestFXPServers(t, map[string]*fxpProcess{
		fxpServerID(group): {
			cmd:               &exec.Cmd{Process: &os.Process{Pid: os.Getpid()}},
			spec:              group,
			runtimeExecutable: previousInfo,
		},
	})
	snapshot := &runtimeListenSnapshot{
		tcpPorts: map[int][]string{
			entry.ListenPort: {`tcp LISTEN 0 4096 *:31772 *:* users:(("forwardx-fxp",pid=72,fd=3))`},
		},
		udpPorts: map[int][]string{},
		usable:   true,
	}
	if fxpRuntimeReadyForRulePort(entry.RuleID, entry.ListenPort, entry.Protocol, snapshot) {
		t.Fatal("old tracked FXP executable made local runtime readiness report healthy")
	}
}
