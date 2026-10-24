package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
)

type agentInstallationState struct {
	ID         string `json:"id"`
	TokenHash  string `json:"tokenHash"`
	Superseded bool   `json:"superseded,omitempty"`
}

var agentInstallationMu sync.Mutex
var agentRegistrationMu sync.Mutex
var agentInstallation agentInstallationState
var agentInstallationPath string
var agentSuperseded atomic.Bool
var agentInstallationRegistered atomic.Bool

func initializeAgentInstallation(configPath, token string) error {
	agentInstallationMu.Lock()
	defer agentInstallationMu.Unlock()
	path := filepath.Join(filepath.Dir(configPath), "installation.json")
	sum := sha256.Sum256([]byte(token))
	tokenHash := hex.EncodeToString(sum[:])
	var state agentInstallationState
	raw, err := os.ReadFile(path)
	if err == nil {
		if err = json.Unmarshal(raw, &state); err != nil {
			return fmt.Errorf("read Agent installation identity: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	_, identityErr := hex.DecodeString(state.ID)
	if state.TokenHash != tokenHash || len(state.ID) != 64 || identityErr != nil || strings.ToLower(state.ID) != state.ID {
		nonce := make([]byte, 32)
		if _, err := rand.Read(nonce); err != nil {
			return err
		}
		state = agentInstallationState{ID: hex.EncodeToString(nonce), TokenHash: tokenHash}
		raw, _ := json.Marshal(state)
		if err := writeConfigFileAtomic(path, raw); err != nil {
			return err
		}
	}
	agentInstallation = state
	agentInstallationPath = path
	_, retirementErr := os.Stat(agentRetirementPath(path, state.ID))
	agentSuperseded.Store(state.Superseded || retirementErr == nil)
	agentInstallationRegistered.Store(false)
	return nil
}

func currentAgentInstallationID() string {
	agentInstallationMu.Lock()
	defer agentInstallationMu.Unlock()
	return agentInstallation.ID
}

func markAgentSuperseded() {
	if agentSuperseded.Swap(true) {
		return
	}
	agentInstallationMu.Lock()
	agentInstallation.Superseded = true
	path := agentInstallationPath
	if path != "" {
		// Separate per-instance markers avoid a read/rename race with a new
		// installation on this machine. Never rewrite its installation.json.
		_ = writeConfigFileAtomic(agentRetirementPath(path, agentInstallation.ID), []byte("retired\n"))
	}
	agentInstallationMu.Unlock()
	logf("Agent installation superseded; panel synchronization stopped, existing forwarding preserved")
}

func agentRetirementPath(path, installationID string) string {
	return filepath.Join(filepath.Dir(path), "retired-installations", installationID)
}

func ensureAgentInstallationRegistered(cfg Config) error {
	if currentAgentInstallationID() == "" || agentSuperseded.Load() || agentInstallationRegistered.Load() {
		return nil
	}
	agentRegistrationMu.Lock()
	defer agentRegistrationMu.Unlock()
	if agentSuperseded.Load() || agentInstallationRegistered.Load() {
		return nil
	}
	return register(cfg)
}

func quietSupersededAgentResponse(out any) error {
	if out == nil {
		return nil
	}
	return json.Unmarshal([]byte(`{"success":true,"agentSuperseded":true,"heartbeatInterval":300}`), out)
}

// Only a decrypted, authenticated response can stop control-plane operations.
func observeAgentOwnershipResponse(raw []byte, authenticated bool) {
	if !authenticated {
		return
	}
	var directive struct {
		Superseded bool `json:"agentSuperseded"`
	}
	if json.Unmarshal(raw, &directive) == nil && directive.Superseded {
		markAgentSuperseded()
	}
}

func agentInstallationBoundCredentialDigest(panelURL, token, installationID string) string {
	digest := fxpPanelCredentialDigest(panelURL, token)
	if digest == "" || strings.TrimSpace(installationID) == "" {
		return digest
	}
	sum := sha256.Sum256([]byte(digest + "\x00" + installationID))
	return hex.EncodeToString(sum[:])
}
