package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
)

const (
	persistentStateFileVersion = 1
)

var (
	persistentRuntimeDir   = "/var/lib/forwardx-agent"
	persistentFXPDir       = persistentRuntimeDir + "/fxp"
	persistentWireGuardDir = persistentRuntimeDir + "/wireguard"
	persistentFailoverDir  = persistentRuntimeDir + "/failover"
	persistentRuntimeMu    sync.Mutex
)

// writePersistentJSON keeps a last-known-good runtime snapshot available even
// if the Agent is replaced while a write is in progress.
func writePersistentJSON(path string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(directory, ".forwardx-runtime-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(raw); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return err
	}
	return os.Chmod(path, 0600)
}

func readPersistentJSONFiles(directory, prefix, suffix string, decode func([]byte) error) error {
	entries, err := os.ReadDir(directory)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), prefix) || !strings.HasSuffix(entry.Name(), suffix) {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(directory, entry.Name()))
		if err != nil {
			logf("persistent runtime snapshot read failed path=%s: %v", filepath.Join(directory, entry.Name()), err)
			continue
		}
		if err := decode(raw); err != nil {
			logf("persistent runtime snapshot decode failed path=%s: %v", filepath.Join(directory, entry.Name()), err)
		}
	}
	return nil
}

func scrubFXPSpec(spec fxpSpec) fxpSpec {
	spec = normalizeFXPSpec(spec)
	// Entry credentials are injected from the current Agent config at launch.
	spec.PanelURL = ""
	spec.Token = ""
	return spec
}

func persistentFXPPath(spec fxpSpec) string {
	spec = normalizeFXPSpec(spec)
	return filepath.Join(
		persistentFXPDir,
		fmt.Sprintf("fxp-%s-%d-%d-%d.json", spec.Role, spec.TunnelID, spec.RuleID, spec.ListenPort),
	)
}

func persistFXPSpec(spec fxpSpec) error {
	spec = scrubFXPSpec(spec)
	if spec.Role == "" || spec.TunnelID <= 0 || spec.ListenPort <= 0 || spec.Key == "" {
		return fmt.Errorf("invalid FXP persistence identity role=%s tunnel=%d rule=%d port=%d", spec.Role, spec.TunnelID, spec.RuleID, spec.ListenPort)
	}
	persistentRuntimeMu.Lock()
	defer persistentRuntimeMu.Unlock()
	return writePersistentJSON(persistentFXPPath(spec), struct {
		Version int     `json:"version"`
		Spec    fxpSpec `json:"spec"`
	}{Version: persistentStateFileVersion, Spec: spec})
}

func removePersistedFXPSpec(spec fxpSpec) {
	requestedProtocol := strings.TrimSpace(spec.Protocol)
	spec = normalizeFXPSpec(spec)
	persistentRuntimeMu.Lock()
	defer persistentRuntimeMu.Unlock()
	if spec.TunnelID > 0 && spec.ListenPort > 0 {
		_ = os.Remove(persistentFXPPath(spec))
	}
	entries, err := os.ReadDir(persistentFXPDir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), "fxp-") || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		raw, readErr := os.ReadFile(filepath.Join(persistentFXPDir, entry.Name()))
		if readErr != nil {
			continue
		}
		var stored struct {
			Spec fxpSpec `json:"spec"`
		}
		if json.Unmarshal(raw, &stored) != nil {
			continue
		}
		stored.Spec = normalizeFXPSpec(stored.Spec)
		if spec.Role != "" && stored.Spec.Role != spec.Role {
			continue
		}
		if spec.RuleID > 0 && stored.Spec.RuleID != spec.RuleID {
			continue
		}
		if spec.TunnelID > 0 && stored.Spec.TunnelID != spec.TunnelID {
			continue
		}
		if spec.ListenPort > 0 && stored.Spec.ListenPort != spec.ListenPort {
			continue
		}
		if requestedProtocol != "" && !runtimeProtocolsOverlap(stored.Spec.Protocol, spec.Protocol) {
			continue
		}
		_ = os.Remove(filepath.Join(persistentFXPDir, entry.Name()))
	}
}

func loadPersistedFXPSpecs() []fxpSpec {
	byID := map[string]fxpSpec{}
	_ = readPersistentJSONFiles(persistentFXPDir, "fxp-", ".json", func(raw []byte) error {
		var stored struct {
			Version int     `json:"version"`
			Spec    fxpSpec `json:"spec"`
		}
		if err := json.Unmarshal(raw, &stored); err != nil {
			return err
		}
		stored.Spec = scrubFXPSpec(stored.Spec)
		if stored.Spec.Role == "" || stored.Spec.TunnelID <= 0 || stored.Spec.ListenPort <= 0 || stored.Spec.Key == "" {
			return fmt.Errorf("invalid FXP snapshot")
		}
		byID[fxpServerID(stored.Spec)] = stored.Spec
		return nil
	})
	result := make([]fxpSpec, 0, len(byID))
	for _, spec := range byID {
		result = append(result, spec)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].TransportVersion != result[j].TransportVersion {
			return result[i].TransportVersion < result[j].TransportVersion
		}
		if result[i].TunnelID != result[j].TunnelID {
			return result[i].TunnelID < result[j].TunnelID
		}
		if result[i].RuleID != result[j].RuleID {
			return result[i].RuleID < result[j].RuleID
		}
		return result[i].ListenPort < result[j].ListenPort
	})
	return result
}

func migrateRuntimeFXPConfigsToPersistent() {
	paths, _ := filepath.Glob("/run/forwardx-agent/fxp-*.json")
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var spec fxpSpec
		if json.Unmarshal(raw, &spec) != nil {
			continue
		}
		spec = scrubFXPSpec(spec)
		if spec.TransportVersion == forwardXWireGuardVersion && fxpSpecLooksPreparedForWireGuard(spec) {
			// Older Agents only persisted the WireGuard-translated config. It
			// cannot safely be replayed because its peer ports are local proxy
			// ports, so let the panel provide the original plan once.
			continue
		}
		if err := persistFXPSpec(spec); err == nil {
			logf("migrated runtime FXP snapshot path=%s tunnel=%d rule=%d", path, spec.TunnelID, spec.RuleID)
		}
	}
}

func fxpSpecLooksPreparedForWireGuard(spec fxpSpec) bool {
	if spec.TransportVersion != forwardXWireGuardVersion {
		return false
	}
	if spec.Role == "entry" {
		return isLoopbackHost(spec.ExitHost) || fxpExitsContainLoopback(spec.Exits)
	}
	if spec.Role == "relay" {
		return isLoopbackHost(spec.RelayExitHost) || fxpExitsContainLoopback(spec.Exits)
	}
	return isLoopbackHost(spec.ListenHost)
}

func fxpExitsContainLoopback(exits []fxpExitEndpoint) bool {
	for _, exit := range exits {
		if isLoopbackHost(exit.Host) {
			return true
		}
	}
	return false
}

func isLoopbackHost(host string) bool {
	host = strings.TrimSpace(strings.Trim(host, "[]"))
	return host == "127.0.0.1" || host == "::1" || strings.EqualFold(host, "localhost")
}

func persistentWireGuardPath(tunnelID int) string {
	return filepath.Join(persistentWireGuardDir, "wireguard-"+strconv.Itoa(tunnelID)+".json")
}

func persistWireGuardSpec(spec wireGuardSpec) error {
	normalized, err := normalizeWireGuardSpec(spec)
	if err != nil {
		return err
	}
	persistentRuntimeMu.Lock()
	defer persistentRuntimeMu.Unlock()
	return writePersistentJSON(persistentWireGuardPath(normalized.TunnelID), struct {
		Version int           `json:"version"`
		Spec    wireGuardSpec `json:"spec"`
	}{Version: persistentStateFileVersion, Spec: normalized})
}

func removePersistedWireGuardSpec(tunnelID int) {
	if tunnelID <= 0 {
		return
	}
	persistentRuntimeMu.Lock()
	defer persistentRuntimeMu.Unlock()
	_ = os.Remove(persistentWireGuardPath(tunnelID))
}

func loadPersistedWireGuardSpecs() []wireGuardSpec {
	result := []wireGuardSpec{}
	_ = readPersistentJSONFiles(persistentWireGuardDir, "wireguard-", ".json", func(raw []byte) error {
		var stored struct {
			Version int           `json:"version"`
			Spec    wireGuardSpec `json:"spec"`
		}
		if err := json.Unmarshal(raw, &stored); err != nil {
			return err
		}
		normalized, err := normalizeWireGuardSpec(stored.Spec)
		if err != nil {
			return err
		}
		result = append(result, normalized)
		return nil
	})
	sort.Slice(result, func(i, j int) bool { return result[i].TunnelID < result[j].TunnelID })
	return result
}

type persistedFailover struct {
	Version    int          `json:"version"`
	RuleID     int          `json:"ruleId"`
	SourcePort int          `json:"sourcePort"`
	Spec       failoverSpec `json:"spec"`
}

func persistentFailoverPath(ruleID int, sourcePort int) string {
	return filepath.Join(persistentFailoverDir, fmt.Sprintf("failover-%d-%d.json", ruleID, sourcePort))
}

func persistFailoverSpec(ruleID int, sourcePort int, spec failoverSpec) error {
	if ruleID <= 0 || sourcePort <= 0 {
		return fmt.Errorf("invalid failover persistence identity rule=%d port=%d", ruleID, sourcePort)
	}
	spec = normalizeFailoverSpec(spec)
	persistentRuntimeMu.Lock()
	defer persistentRuntimeMu.Unlock()
	return writePersistentJSON(persistentFailoverPath(ruleID, sourcePort), persistedFailover{
		Version: persistentStateFileVersion, RuleID: ruleID, SourcePort: sourcePort, Spec: spec,
	})
}

func removePersistedFailoverSpec(ruleID int, sourcePort int) {
	if ruleID <= 0 || sourcePort <= 0 {
		return
	}
	persistentRuntimeMu.Lock()
	defer persistentRuntimeMu.Unlock()
	_ = os.Remove(persistentFailoverPath(ruleID, sourcePort))
}

func loadPersistedFailovers() []persistedFailover {
	result := []persistedFailover{}
	_ = readPersistentJSONFiles(persistentFailoverDir, "failover-", ".json", func(raw []byte) error {
		var stored persistedFailover
		if err := json.Unmarshal(raw, &stored); err != nil {
			return err
		}
		stored.Spec = normalizeFailoverSpec(stored.Spec)
		if stored.RuleID <= 0 || stored.SourcePort <= 0 || !stored.Spec.Enabled || stored.Spec.ListenPort <= 0 || len(stored.Spec.Targets) < 2 {
			return fmt.Errorf("invalid failover snapshot")
		}
		result = append(result, stored)
		return nil
	})
	sort.Slice(result, func(i, j int) bool {
		if result[i].RuleID != result[j].RuleID {
			return result[i].RuleID < result[j].RuleID
		}
		return result[i].SourcePort < result[j].SourcePort
	})
	return result
}

func restorePersistedForwardXRuntimes(cfg Config) {
	migrateRuntimeFXPConfigsToPersistent()
	restoredWireGuard := 0
	for _, spec := range loadPersistedWireGuardSpecs() {
		if err := applyWireGuardRuntime(spec); err != nil {
			logf("local WireGuard runtime restore failed tunnel=%d: %v", spec.TunnelID, err)
			continue
		}
		restoredWireGuard++
	}
	restoredFXP := restorePersistedFXPSpecs(cfg, loadPersistedFXPSpecs())
	restoredFailover := 0
	for _, stored := range loadPersistedFailovers() {
		if startFailoverProxy(stored.RuleID, stored.SourcePort, stored.Spec, nil) {
			restoredFailover++
		}
	}
	if restoredWireGuard > 0 || restoredFXP > 0 || restoredFailover > 0 {
		logf("local runtime restore complete wireguard=%d fxp=%d failover=%d", restoredWireGuard, restoredFXP, restoredFailover)
	}
}

func restorePersistedFXPSpecs(cfg Config, specs []fxpSpec) int {
	if len(specs) == 0 {
		return 0
	}
	workerCount := len(specs)
	if workerCount > 4 {
		workerCount = 4
	}
	jobs := make(chan fxpSpec)
	results := make(chan bool, len(specs))
	var workers sync.WaitGroup
	for i := 0; i < workerCount; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for spec := range jobs {
				message := &actionMessage{}
				ok := startFXP(cfg, spec, message)
				if !ok {
					logf("local FXP runtime restore failed tunnel=%d rule=%d port=%d: %s", spec.TunnelID, spec.RuleID, spec.ListenPort, message.get())
				}
				results <- ok
			}
		}()
	}
	for _, spec := range specs {
		jobs <- spec
	}
	close(jobs)
	workers.Wait()
	close(results)
	restored := 0
	for ok := range results {
		if ok {
			restored++
		}
	}
	return restored
}
