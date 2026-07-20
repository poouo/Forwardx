package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writePanelMigrationTestConfig(t *testing.T, cfg Config) string {
	t.Helper()
	previousConfigPath := activeConfigPath
	previousRuntimeURL, _ := runtimePanelURL.Load().(string)
	panelMigrationRuntime.Lock()
	previousActive := panelMigrationRuntime.active
	previousID := panelMigrationRuntime.id
	previousFallback := panelMigrationRuntime.fallback
	previousStartedAt := panelMigrationRuntime.startedAt
	previousFailures := panelMigrationRuntime.failures
	previousTerminalID := panelMigrationRuntime.terminalID
	previousStreamConnected := panelMigrationRuntime.streamConnected
	panelMigrationRuntime.Unlock()
	t.Cleanup(func() {
		activeConfigPath = previousConfigPath
		runtimePanelURL.Store(previousRuntimeURL)
		panelMigrationRuntime.Lock()
		panelMigrationRuntime.active = previousActive
		panelMigrationRuntime.id = previousID
		panelMigrationRuntime.fallback = previousFallback
		panelMigrationRuntime.startedAt = previousStartedAt
		panelMigrationRuntime.failures = previousFailures
		panelMigrationRuntime.terminalID = previousTerminalID
		panelMigrationRuntime.streamConnected = previousStreamConnected
		panelMigrationRuntime.Unlock()
	})
	path := filepath.Join(t.TempDir(), "config.json")
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func readPanelMigrationTestConfig(t *testing.T, path string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		t.Fatal(err)
	}
	return data
}

func TestPanelMigrationPreparePersistsAndSwitchesToNewPanel(t *testing.T) {
	cfg := Config{
		PanelURL: "https://old.example.com",
		Token:    "token",
		Interval: 30,
	}
	activeConfigPath = writePanelMigrationTestConfig(t, cfg)
	setRuntimePanelURL(cfg.PanelURL)
	initializePanelMigration(cfg)
	startedAt := time.Now().Add(-time.Minute).Unix()

	changed := handlePanelMigrationDirective(cfg, &panelMigrationDirective{
		ID:               "migration-prepare",
		State:            "preparing",
		TargetPanelURL:   "https://new.example.com/",
		FallbackPanelURL: "https://old.example.com/",
		StartedAt:        startedAt,
	})
	if !changed {
		t.Fatal("expected panel URL to change")
	}
	if got := currentPanelURL(cfg); got != "https://new.example.com" {
		t.Fatalf("unexpected runtime panel URL: %s", got)
	}
	data := readPanelMigrationTestConfig(t, activeConfigPath)
	if data["panelUrl"] != "https://new.example.com" {
		t.Fatalf("unexpected persisted panel URL: %v", data["panelUrl"])
	}
	if data["migrationFallbackPanelUrl"] != "https://old.example.com" {
		t.Fatalf("unexpected migration fallback: %v", data["migrationFallbackPanelUrl"])
	}
	if data["panelMigrationId"] != "migration-prepare" {
		t.Fatalf("unexpected migration id: %v", data["panelMigrationId"])
	}
	if got := int64(data["panelMigrationStartedAt"].(float64)); got != startedAt {
		t.Fatalf("unexpected migration start: %d", got)
	}
}

func TestPanelMigrationCommittedRedirectSwitchesPreviouslyOfflineAgent(t *testing.T) {
	cfg := Config{
		PanelURL: "https://old.example.com",
		Token:    "token",
		Interval: 30,
	}
	activeConfigPath = writePanelMigrationTestConfig(t, cfg)
	setRuntimePanelURL(cfg.PanelURL)
	initializePanelMigration(cfg)

	changed := handlePanelMigrationDirective(cfg, &panelMigrationDirective{
		ID:             "migration-offline",
		State:          "committed",
		TargetPanelURL: "https://new.example.com",
	})
	if !changed {
		t.Fatal("expected committed redirect to switch an Agent that missed prepare")
	}
	if got := currentPanelURL(cfg); got != "https://new.example.com" {
		t.Fatalf("unexpected runtime panel URL: %s", got)
	}
	data := readPanelMigrationTestConfig(t, activeConfigPath)
	if data["panelUrl"] != "https://new.example.com" {
		t.Fatalf("unexpected persisted panel URL: %v", data["panelUrl"])
	}
	if _, ok := data["migrationFallbackPanelUrl"]; ok {
		t.Fatal("committed redirect must not retain fallback metadata")
	}
	if handlePanelMigrationDirective(cfg, &panelMigrationDirective{
		ID:               "migration-offline",
		State:            "preparing",
		TargetPanelURL:   "https://new.example.com",
		FallbackPanelURL: "https://old.example.com",
	}) {
		t.Fatal("stale prepare directive must be ignored after committed redirect")
	}
}

func TestPanelMigrationPrepareDoesNotSwitchWhenConfigCannotBePersisted(t *testing.T) {
	cfg := Config{
		PanelURL: "https://old.example.com",
		Token:    "token",
		Interval: 30,
	}
	activeConfigPath = writePanelMigrationTestConfig(t, cfg)
	setRuntimePanelURL(cfg.PanelURL)
	initializePanelMigration(cfg)
	if err := os.Remove(activeConfigPath); err != nil {
		t.Fatal(err)
	}

	changed := handlePanelMigrationDirective(cfg, &panelMigrationDirective{
		ID:               "migration-persist-failure",
		State:            "preparing",
		TargetPanelURL:   "https://new.example.com",
		FallbackPanelURL: "https://old.example.com",
	})
	if changed {
		t.Fatal("runtime panel changed even though config persistence failed")
	}
	if got := currentPanelURL(cfg); got != "https://old.example.com" {
		t.Fatalf("unexpected runtime panel URL after persist failure: %s", got)
	}
}

func TestPanelMigrationRestartKeepsFallbackRecovery(t *testing.T) {
	originalReporter := sendPanelMigrationRollback
	sendPanelMigrationRollback = func(Config, string) {}
	t.Cleanup(func() { sendPanelMigrationRollback = originalReporter })
	cfg := Config{
		PanelURL:                  "https://new.example.com",
		Token:                     "token",
		Interval:                  30,
		MigrationFallbackPanelURL: "https://old.example.com",
		PanelMigrationID:          "migration-restart",
		PanelMigrationStartedAt:   time.Now().Add(-time.Minute).Unix(),
	}
	activeConfigPath = writePanelMigrationTestConfig(t, cfg)
	setRuntimePanelURL(cfg.PanelURL)
	initializePanelMigration(cfg)

	recordPanelMigrationHeartbeatFailure(cfg, errors.New("new panel unavailable"))
	recordPanelMigrationHeartbeatFailure(cfg, errors.New("new panel still unavailable"))
	if got := currentPanelURL(cfg); got != "https://old.example.com" {
		t.Fatalf("expected restart recovery to restore old panel, got %s", got)
	}
}

func TestPanelMigrationAbortRestoresOldPanel(t *testing.T) {
	originalReporter := sendPanelMigrationRollback
	sendPanelMigrationRollback = func(Config, string) {}
	t.Cleanup(func() { sendPanelMigrationRollback = originalReporter })
	cfg := Config{
		PanelURL:                  "https://new.example.com",
		Token:                     "token",
		Interval:                  30,
		MigrationFallbackPanelURL: "https://old.example.com",
		PanelMigrationID:          "migration-1",
		PanelMigrationStartedAt:   time.Now().Unix(),
	}
	activeConfigPath = writePanelMigrationTestConfig(t, cfg)
	setRuntimePanelURL(cfg.PanelURL)
	initializePanelMigration(cfg)

	changed := handlePanelMigrationDirective(cfg, &panelMigrationDirective{ID: "migration-1", State: "aborted"})
	if !changed {
		t.Fatal("expected panel URL to change")
	}
	if got := currentPanelURL(cfg); got != "https://old.example.com" {
		t.Fatalf("unexpected runtime panel URL: %s", got)
	}
	data := readPanelMigrationTestConfig(t, activeConfigPath)
	if data["panelUrl"] != "https://old.example.com" {
		t.Fatalf("unexpected persisted panel URL: %v", data["panelUrl"])
	}
	if _, ok := data["migrationFallbackPanelUrl"]; ok {
		t.Fatal("fallback metadata should be removed after rollback")
	}
}

func TestPanelMigrationCommitKeepsNewPanelAndClearsFallback(t *testing.T) {
	cfg := Config{
		PanelURL:                  "https://new.example.com",
		Token:                     "token",
		Interval:                  30,
		MigrationFallbackPanelURL: "https://old.example.com",
		PanelMigrationID:          "migration-2",
		PanelMigrationStartedAt:   time.Now().Unix(),
	}
	activeConfigPath = writePanelMigrationTestConfig(t, cfg)
	setRuntimePanelURL(cfg.PanelURL)
	initializePanelMigration(cfg)

	if handlePanelMigrationDirective(cfg, &panelMigrationDirective{ID: "migration-2", State: "committed"}) {
		t.Fatal("commit must not switch the active panel")
	}
	data := readPanelMigrationTestConfig(t, activeConfigPath)
	if data["panelUrl"] != "https://new.example.com" {
		t.Fatalf("unexpected persisted panel URL: %v", data["panelUrl"])
	}
	if _, ok := data["panelMigrationId"]; ok {
		t.Fatal("migration metadata should be removed after commit")
	}
	if handlePanelMigrationDirective(cfg, &panelMigrationDirective{
		ID:               "migration-2",
		State:            "preparing",
		FallbackPanelURL: "https://old.example.com",
	}) {
		t.Fatal("stale prepare directive must be ignored after commit")
	}
	data = readPanelMigrationTestConfig(t, activeConfigPath)
	if _, ok := data["migrationFallbackPanelUrl"]; ok {
		t.Fatal("stale prepare directive restored fallback metadata")
	}
}

func TestPanelMigrationCommunicationFailureFallsBack(t *testing.T) {
	originalReporter := sendPanelMigrationRollback
	sendPanelMigrationRollback = func(Config, string) {}
	t.Cleanup(func() { sendPanelMigrationRollback = originalReporter })
	cfg := Config{
		PanelURL:                  "https://new.example.com",
		Token:                     "token",
		Interval:                  30,
		MigrationFallbackPanelURL: "https://old.example.com",
		PanelMigrationID:          "migration-3",
		PanelMigrationStartedAt:   time.Now().Unix(),
	}
	activeConfigPath = writePanelMigrationTestConfig(t, cfg)
	setRuntimePanelURL(cfg.PanelURL)
	initializePanelMigration(cfg)

	recordPanelMigrationHeartbeatFailure(cfg, errors.New("temporary failure"))
	if got := currentPanelURL(cfg); got != "https://new.example.com" {
		t.Fatalf("first failure switched panel too early: %s", got)
	}
	recordPanelMigrationHeartbeatFailure(cfg, errors.New("panel unreachable"))
	if got := currentPanelURL(cfg); got != "https://old.example.com" {
		t.Fatalf("expected automatic fallback, got %s", got)
	}
}
