package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

const panelMigrationFallbackFailures = 2
const panelMigrationFallbackDeadline = 3 * time.Minute

var panelMigrationRuntime = struct {
	sync.Mutex
	active          bool
	id              string
	fallback        string
	startedAt       time.Time
	failures        int
	terminalID      string
	streamConnected bool
}{}

var sendPanelMigrationRollback = reportPanelMigrationRollback

func initializePanelMigration(cfg Config) {
	id := strings.TrimSpace(cfg.PanelMigrationID)
	fallback := normalizePanelURL(cfg.MigrationFallbackPanelURL)
	panelMigrationRuntime.Lock()
	defer panelMigrationRuntime.Unlock()
	panelMigrationRuntime.active = id != "" && fallback != ""
	panelMigrationRuntime.id = id
	panelMigrationRuntime.fallback = fallback
	panelMigrationRuntime.failures = 0
	panelMigrationRuntime.terminalID = ""
	panelMigrationRuntime.streamConnected = false
	panelMigrationRuntime.startedAt = time.Unix(cfg.PanelMigrationStartedAt, 0)
	if panelMigrationRuntime.startedAt.IsZero() || panelMigrationRuntime.startedAt.After(time.Now()) {
		panelMigrationRuntime.startedAt = time.Now()
	}
}

func recordPanelMigrationHeartbeatSuccess() {
	panelMigrationRuntime.Lock()
	panelMigrationRuntime.failures = 0
	panelMigrationRuntime.Unlock()
}

func recordPanelMigrationStreamConnection(connected bool) {
	panelMigrationRuntime.Lock()
	panelMigrationRuntime.streamConnected = connected
	if connected {
		panelMigrationRuntime.failures = 0
	}
	panelMigrationRuntime.Unlock()
}

func recordPanelMigrationHeartbeatFailure(cfg Config, err error) {
	panelMigrationRuntime.Lock()
	if !panelMigrationRuntime.active {
		panelMigrationRuntime.Unlock()
		return
	}
	panelMigrationRuntime.failures++
	failures := panelMigrationRuntime.failures
	elapsed := time.Since(panelMigrationRuntime.startedAt)
	streamConnected := panelMigrationRuntime.streamConnected
	panelMigrationRuntime.Unlock()
	if streamConnected {
		return
	}
	if failures < panelMigrationFallbackFailures && elapsed < panelMigrationFallbackDeadline {
		return
	}
	reason := fmt.Sprintf("new panel unavailable failures=%d elapsed=%s", failures, elapsed.Round(time.Second))
	if err != nil {
		reason += ": " + err.Error()
	}
	switchToPanelMigrationFallback(cfg, reason)
}

// handlePanelMigrationDirective returns true when the active panel URL changed.
func handlePanelMigrationDirective(cfg Config, directive *panelMigrationDirective) bool {
	if directive == nil {
		return false
	}
	id := strings.TrimSpace(directive.ID)
	state := strings.ToLower(strings.TrimSpace(directive.State))
	if id == "" || state == "" {
		return false
	}

	if state == "preparing" || state == "committing" {
		fallback := normalizePanelURL(directive.FallbackPanelURL)
		panelMigrationRuntime.Lock()
		if panelMigrationRuntime.terminalID == id {
			panelMigrationRuntime.Unlock()
			return false
		}
		if fallback == "" {
			fallback = panelMigrationRuntime.fallback
		}
		alreadyActive := panelMigrationRuntime.active &&
			panelMigrationRuntime.id == id &&
			panelMigrationRuntime.fallback == fallback
		if fallback != "" {
			panelMigrationRuntime.active = true
			panelMigrationRuntime.id = id
			panelMigrationRuntime.fallback = fallback
			panelMigrationRuntime.failures = 0
			if panelMigrationRuntime.startedAt.IsZero() {
				panelMigrationRuntime.startedAt = time.Now()
			}
		}
		startedAt := panelMigrationRuntime.startedAt
		panelMigrationRuntime.Unlock()
		if fallback != "" && !alreadyActive {
			_ = persistPanelMigrationConfig(currentPanelURL(cfg), fallback, id, startedAt, false)
		}
		return false
	}

	panelMigrationRuntime.Lock()
	matches := panelMigrationRuntime.active && panelMigrationRuntime.id == id
	panelMigrationRuntime.Unlock()
	if !matches {
		return false
	}
	if state == "aborted" {
		return switchToPanelMigrationFallback(cfg, "migration aborted by panel")
	}
	if state == "committed" {
		clearPanelMigrationFallback(cfg)
	}
	return false
}

func switchToPanelMigrationFallback(cfg Config, reason string) bool {
	panelMigrationRuntime.Lock()
	if !panelMigrationRuntime.active {
		panelMigrationRuntime.Unlock()
		return false
	}
	fallback := panelMigrationRuntime.fallback
	migrationID := panelMigrationRuntime.id
	panelMigrationRuntime.terminalID = migrationID
	panelMigrationRuntime.active = false
	panelMigrationRuntime.failures = 0
	panelMigrationRuntime.streamConnected = false
	panelMigrationRuntime.Unlock()
	if fallback == "" || fallback == currentPanelURL(cfg) {
		return false
	}
	setRuntimePanelURL(fallback)
	if err := persistPanelMigrationConfig(fallback, "", "", time.Time{}, true); err != nil {
		logf("panel migration fallback switched runtime to %s, persist failed: %v", fallback, err)
	} else {
		logf("panel migration fallback restored %s reason=%s", fallback, reason)
	}
	sendPanelMigrationRollback(cfg, migrationID)
	wakeHeartbeat()
	return true
}

func reportPanelMigrationRollback(cfg Config, migrationID string) {
	var response struct {
		Success bool `json:"success"`
	}
	err := post(cfg, "/api/agent/migration-rollback", map[string]any{
		"migrationId": strings.TrimSpace(migrationID),
	}, &response)
	if err == nil {
		logf("panel migration rollback acknowledged by old panel")
		return
	}
	var migrated migratedPanelError
	if errors.As(err, &migrated) && normalizePanelURL(migrated.PanelURL) != "" {
		target := normalizePanelURL(migrated.PanelURL)
		setRuntimePanelURL(target)
		if persistErr := persistPanelMigrationConfig(target, "", "", time.Time{}, true); persistErr != nil {
			logf("old panel already committed migration; restore new panel persist failed: %v", persistErr)
		} else {
			logf("old panel already committed migration; staying on %s", target)
		}
		return
	}
	logf("panel migration rollback report failed: %v", err)
}

func clearPanelMigrationFallback(cfg Config) {
	panelMigrationRuntime.Lock()
	if !panelMigrationRuntime.active {
		panelMigrationRuntime.Unlock()
		return
	}
	panelMigrationRuntime.terminalID = panelMigrationRuntime.id
	panelMigrationRuntime.active = false
	panelMigrationRuntime.failures = 0
	panelMigrationRuntime.streamConnected = false
	panelMigrationRuntime.Unlock()
	if err := persistPanelMigrationConfig(currentPanelURL(cfg), "", "", time.Time{}, true); err != nil {
		logf("clear panel migration fallback failed: %v", err)
		return
	}
	logf("panel migration committed; fallback cleared")
}

func persistPanelMigrationConfig(panelURL string, fallback string, migrationID string, startedAt time.Time, clear bool) error {
	path := strings.TrimSpace(activeConfigPath)
	if path == "" {
		return fmt.Errorf("config path is empty")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		return err
	}
	if data == nil {
		data = map[string]any{}
	}
	if normalized := normalizePanelURL(panelURL); normalized != "" {
		data["panelUrl"] = normalized
	}
	if clear {
		delete(data, "migrationFallbackPanelUrl")
		delete(data, "panelMigrationId")
		delete(data, "panelMigrationStartedAt")
	} else {
		data["migrationFallbackPanelUrl"] = normalizePanelURL(fallback)
		data["panelMigrationId"] = strings.TrimSpace(migrationID)
		data["panelMigrationStartedAt"] = startedAt.Unix()
	}
	next, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	next = append(next, '\n')
	tmp := path + ".migration.tmp"
	if err := os.WriteFile(tmp, next, 0600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Chmod(path, 0600)
}
