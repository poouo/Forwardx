package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func isolateAgentInstallation(t *testing.T) {
	t.Helper()
	agentInstallationMu.Lock()
	previous, previousPath := agentInstallation, agentInstallationPath
	agentInstallationMu.Unlock()
	previousSuperseded, previousRegistered := agentSuperseded.Load(), agentInstallationRegistered.Load()
	t.Cleanup(func() {
		agentInstallationMu.Lock()
		agentInstallation, agentInstallationPath = previous, previousPath
		agentInstallationMu.Unlock()
		agentSuperseded.Store(previousSuperseded)
		agentInstallationRegistered.Store(previousRegistered)
	})
}

func TestAgentInstallationPersistsAcrossRestartAndTokenChange(t *testing.T) {
	isolateAgentInstallation(t)
	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := initializeAgentInstallation(configPath, "first-token"); err != nil {
		t.Fatal(err)
	}
	first := currentAgentInstallationID()
	if len(first) != 64 {
		t.Fatalf("invalid installation ID length: %d", len(first))
	}
	if err := initializeAgentInstallation(configPath, "first-token"); err != nil {
		t.Fatal(err)
	}
	if currentAgentInstallationID() != first {
		t.Fatal("normal restart changed the installation")
	}
	markAgentSuperseded()
	if err := initializeAgentInstallation(configPath, "first-token"); err != nil {
		t.Fatal(err)
	}
	if !agentSuperseded.Load() {
		t.Fatal("superseded process tried to reclaim after restart")
	}
	if err := initializeAgentInstallation(configPath, "second-token"); err != nil {
		t.Fatal(err)
	}
	if currentAgentInstallationID() == first || agentSuperseded.Load() {
		t.Fatal("new token did not create a fresh installation")
	}
}

func TestRetiringProcessDoesNotOverwriteReplacementInstallation(t *testing.T) {
	isolateAgentInstallation(t)
	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := initializeAgentInstallation(configPath, "same-token"); err != nil {
		t.Fatal(err)
	}
	agentInstallationMu.Lock()
	replacement := agentInstallation
	path := agentInstallationPath
	agentInstallationMu.Unlock()
	replacement.ID = strings.Repeat("f", 64)
	raw, _ := json.Marshal(replacement)
	if err := writeConfigFileAtomic(path, raw); err != nil {
		t.Fatal(err)
	}
	markAgentSuperseded()
	stored, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var disk agentInstallationState
	if err := json.Unmarshal(stored, &disk); err != nil {
		t.Fatal(err)
	}
	if disk.ID != replacement.ID || disk.Superseded {
		t.Fatalf("retiring process overwrote replacement: %+v", disk)
	}
}

func TestSupersededAgentStopsNetworkAndKeepsRuntimeUntouched(t *testing.T) {
	isolateAgentInstallation(t)
	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := initializeAgentInstallation(configPath, "token"); err != nil {
		t.Fatal(err)
	}
	agentInstallationRegistered.Store(true)
	requests := 0
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		var env envelope
		if err := json.NewDecoder(r.Body).Decode(&env); err != nil {
			t.Error(err)
			return
		}
		raw, err := decrypt(env, "token")
		if err != nil {
			t.Error(err)
			return
		}
		var request map[string]json.RawMessage
		if err := json.Unmarshal(raw, &request); err != nil {
			t.Error(err)
			return
		}
		var id string
		_ = json.Unmarshal(request["installationId"], &id)
		if id != currentAgentInstallationID() {
			t.Error("request omitted encrypted installation identity")
		}
		response, err := encrypt(map[string]any{"success": true, "agentSuperseded": true}, "token")
		if err != nil {
			t.Error(err)
			return
		}
		_ = json.NewEncoder(w).Encode(response)
	}))
	defer panel.Close()
	var response map[string]any
	cfg := Config{PanelURL: panel.URL, Token: "token"}
	if err := postWithClientToPanelURL(panel.Client(), cfg, panel.URL, "/api/agent/traffic", map[string]any{}, &response); err != nil {
		t.Fatal(err)
	}
	if !agentSuperseded.Load() {
		t.Fatal("authenticated takeover notice was ignored")
	}
	if err := postWithClientToPanelURL(panel.Client(), cfg, panel.URL, "/api/agent/heartbeat", map[string]any{}, &response); err != nil {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Fatalf("retired Agent kept issuing requests: %d", requests)
	}
	// A remove action must not reach any shell or local-state cleanup path.
	if handleActionJobWithRuntimeSnapshot(cfg, action{Op: "remove", SourcePort: 21000, ForwardType: "realm"}, nil, nil, nil) {
		t.Fatal("retired Agent executed a management action")
	}
}

func TestUnverifiedTakeoverNoticeCannotRetireAgent(t *testing.T) {
	isolateAgentInstallation(t)
	agentSuperseded.Store(false)
	observeAgentOwnershipResponse([]byte(`{"agentSuperseded":true}`), false)
	if agentSuperseded.Load() {
		t.Fatal("unverified response retired Agent")
	}
}

func TestInstallationIdentityParticipatesInFXPCredentialAdoption(t *testing.T) {
	old := agentInstallationBoundCredentialDigest("https://panel.test", "token", strings.Repeat("a", 64))
	next := agentInstallationBoundCredentialDigest("https://panel.test", "token", strings.Repeat("b", 64))
	if old == next {
		t.Fatal("different installations share an FXP credential digest")
	}
	if agentInstallationBoundCredentialDigest("https://panel.test", "token", "") != fxpPanelCredentialDigest("https://panel.test", "token") {
		t.Fatal("legacy credential comparison changed")
	}
}
