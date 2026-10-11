package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"sync/atomic"
	"time"
)

func cloneFXPSpecForAdditive(spec fxpSpec) fxpSpec {
	spec.Exits = append([]fxpExitEndpoint(nil), spec.Exits...)
	if spec.Entries != nil {
		entries := make([]fxpSpec, len(spec.Entries))
		for index, entry := range spec.Entries {
			entries[index] = cloneFXPSpecForAdditive(entry)
		}
		spec.Entries = entries
	}
	return spec
}

// An apply snapshot is not a deletion instruction. Concurrent batch creates
// can be queued with different group snapshots; preserve members already added
// by a sibling batch. Explicit remove/handoff actions retire their own members.
func mergeFXPApplyGroup(current, desired fxpSpec) fxpSpec {
	byID := make(map[int]bool, len(desired.Entries))
	for _, entry := range desired.Entries {
		byID[entry.RuleID] = true
	}
	entries := append([]fxpSpec(nil), desired.Entries...)
	for _, entry := range current.Entries {
		if !byID[entry.RuleID] {
			entries = append(entries, entry)
		}
	}
	group, ok := buildSharedFXPEntryGroup(entries, desired.TunnelID, desired.TransportVersion)
	if !ok {
		return desired
	}
	return group
}

func fxpIsAdditiveUpdate(old, next fxpSpec) bool {
	old, next = normalizeFXPSpec(old), normalizeFXPSpec(next)
	if fxpServerID(old) != fxpServerID(next) {
		return false
	}
	if isFXPEntryGroup(old) && isFXPEntryGroup(next) {
		previous, desired := old.Entries, next.Entries
		old.Entries, next.Entries = nil, nil
		if fxpServerSignature(old) != fxpServerSignature(next) || len(desired) <= len(previous) {
			return false
		}
		byID := make(map[int]string, len(desired))
		for _, entry := range desired {
			if _, exists := byID[entry.RuleID]; exists {
				return false
			}
			byID[entry.RuleID] = fxpServerSignature(entry)
		}
		for _, entry := range previous {
			if byID[entry.RuleID] != fxpServerSignature(entry) {
				return false
			}
		}
		return true
	}
	if old.Role == "exit" && next.Role == "exit" {
		previous, desired := old.UDPTargets, next.UDPTargets
		old.UDPTargets, next.UDPTargets = nil, nil
		if fxpServerSignature(old) != fxpServerSignature(next) || len(desired) <= len(previous) {
			return false
		}
		byID := make(map[int]fxpUDPTarget, len(desired))
		for _, target := range desired {
			byID[target.RuleID] = target
		}
		for _, target := range previous {
			if byID[target.RuleID] != target {
				return false
			}
		}
		return true
	}
	return false
}

func requestFXPAddition(ctx context.Context, path string, payload []byte) error {
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", path)
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 15 * time.Second}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://unix/additive", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("local incremental API unavailable (upgrade FXP runtime if necessary): %w", err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode != http.StatusNoContent {
		return fmt.Errorf("local incremental API refused update (HTTP %d)", response.StatusCode)
	}
	return nil
}

func syncFXPAdditive(cfg Config, existing *fxpProcess, desired fxpSpec, persistenceEnabled bool, message *actionMessage) bool {
	// Read the actual config to retain the existing control address. Older
	// binaries ignore the new JSON property and run normally, but cannot hot-add.
	data, err := os.ReadFile(existing.configPath)
	var previous fxpSpec
	if err != nil || json.Unmarshal(data, &previous) != nil || previous.ControlSocket != existing.configPath+".sock" {
		message.set("fxp incremental update unavailable tunnel=%d; upgrade runtime; existing connections preserved", desired.TunnelID)
		return false
	}
	prepared := cloneFXPSpecForAdditive(desired)
	refID := ""
	if desired.TransportVersion == forwardXWireGuardVersion {
		refID = fmt.Sprintf("%s#add-%d", fxpServerID(desired), atomic.AddUint64(&fxpWireGuardRefSequence, 1))
		prepared, err = prepareFXPWireGuard(desired, refID)
		if err != nil {
			message.set("fxp incremental V2 preparation failed tunnel=%d: %v; existing connections preserved", desired.TunnelID, err)
			return false
		}
	}
	prepared.ControlSocket = previous.ControlSocket
	if isFXPEntryGroup(prepared) {
		for index := range prepared.Entries {
			prepared.Entries[index].PanelURL = currentPanelURL(cfg)
			prepared.Entries[index].Token = cfg.Token
		}
	}
	payload, err := json.Marshal(prepared)
	if err != nil {
		if refID != "" {
			releaseWireGuardRuntimeRef(desired.TunnelID, refID)
		}
		message.set("fxp incremental config encoding failed tunnel=%d", desired.TunnelID)
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	err = requestFXPAddition(ctx, prepared.ControlSocket, payload)
	if refID != "" {
		// A lost response can conceal a committed update. Keep its proxies alive.
		// The full desired group owns all old/new endpoints, so a later retry can
		// replace this one reference without accumulating references per batch.
		fxpMu.Lock()
		oldRef := existing.wireGuardAdditiveRefID
		active := fxpServers[fxpServerID(desired)] == existing && fxpProcessActive(existing)
		if active {
			existing.wireGuardAdditiveRefID = refID
		}
		fxpMu.Unlock()
		if !active {
			releaseWireGuardRuntimeRef(desired.TunnelID, refID)
			if err == nil {
				err = fmt.Errorf("runtime exited during incremental update")
			}
		}
		if active && oldRef != "" {
			releaseWireGuardRuntimeRef(desired.TunnelID, oldRef)
		}
	}
	if err == nil {
		err = writeManagedConfigAtomic(existing.configPath, payload, 0600)
	}
	if err == nil && persistenceEnabled {
		err = persistFXPSpec(desired)
	}
	if err != nil {
		message.set("fxp incremental update failed tunnel=%d: %v; refusing shared restart", desired.TunnelID, err)
		return false
	}
	fxpMu.Lock()
	existing.spec = desired
	existing.signature = fxpServerSignature(desired)
	fxpMu.Unlock()
	invalidateLocalRuntimeReadinessCache()
	logf("fxp additive sync role=%s version=%s tunnel=%d entries=%d udpTargets=%d; existing connections preserved", desired.Role, desired.TransportVersion, desired.TunnelID, len(desired.Entries), len(desired.UDPTargets))
	return true
}
