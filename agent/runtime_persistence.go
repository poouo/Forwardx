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
	if isFXPEntryGroup(spec) {
		for index := range spec.Entries {
			spec.Entries[index] = scrubFXPSpec(spec.Entries[index])
		}
		return spec
	}
	// Entry credentials are injected from the current Agent config at launch.
	spec.PanelURL = ""
	spec.Token = ""
	return spec
}

func persistentFXPPath(spec fxpSpec) string {
	spec = normalizeFXPSpec(spec)
	return filepath.Join(
		persistentFXPDir,
		fmt.Sprintf("fxp-%s-%s-%d-%d-%d.json", spec.TransportVersion, spec.Role, spec.TunnelID, spec.RuleID, spec.ListenPort),
	)
}

func persistentFXPEntryGroupPath(spec fxpSpec) string {
	spec = normalizeFXPSpec(spec)
	return filepath.Join(
		persistentFXPDir,
		fmt.Sprintf("fxp-group-%s-%d.json", spec.TransportVersion, spec.TunnelID),
	)
}

func persistFXPSpec(spec fxpSpec) error {
	spec = scrubFXPSpec(spec)
	if isFXPEntryGroup(spec) {
		return replacePersistedSharedFXPEntryGroup(spec)
	}
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

func replacePersistedSharedFXPEntryGroup(group fxpSpec) error {
	group = scrubFXPSpec(group)
	if !isFXPEntryGroup(group) || len(group.Entries) == 0 {
		return fmt.Errorf("invalid FXP entry group tunnel=%d entries=%d", group.TunnelID, len(group.Entries))
	}
	for _, entry := range group.Entries {
		if !isSharedFXPEntry(entry) || entry.Key == "" {
			return fmt.Errorf("invalid FXP entry group member tunnel=%d rule=%d port=%d", entry.TunnelID, entry.RuleID, entry.ListenPort)
		}
	}
	persistentRuntimeMu.Lock()
	defer persistentRuntimeMu.Unlock()
	groupPath := persistentFXPEntryGroupPath(group)
	if err := writePersistentJSON(groupPath, struct {
		Version int     `json:"version"`
		Spec    fxpSpec `json:"spec"`
	}{Version: persistentStateFileVersion, Spec: group}); err != nil {
		return err
	}
	entries, err := os.ReadDir(persistentFXPDir)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, file := range entries {
		if file.IsDir() || !strings.HasPrefix(file.Name(), "fxp-") || !strings.HasSuffix(file.Name(), ".json") {
			continue
		}
		path := filepath.Join(persistentFXPDir, file.Name())
		if path == groupPath {
			continue
		}
		raw, readErr := os.ReadFile(path)
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
		sameTunnelGroup := isFXPEntryGroup(stored.Spec) && stored.Spec.TunnelID == group.TunnelID && stored.Spec.TransportVersion == group.TransportVersion
		sameTunnelEntry := isSharedFXPEntry(stored.Spec) && stored.Spec.TunnelID == group.TunnelID && stored.Spec.TransportVersion == group.TransportVersion
		if sameTunnelGroup || sameTunnelEntry {
			if removeErr := os.Remove(path); removeErr != nil && !os.IsNotExist(removeErr) {
				return removeErr
			}
		}
	}
	return nil
}

func removePersistedFXPSpec(spec fxpSpec) {
	requestedProtocol := strings.TrimSpace(spec.Protocol)
	requestedTransportVersion := strings.TrimSpace(spec.TransportVersion)
	spec = normalizeFXPSpec(spec)
	matchSpec := spec
	if requestedTransportVersion == "" {
		matchSpec.TransportVersion = ""
	}
	if isFXPEntryGroup(spec) {
		persistentRuntimeMu.Lock()
		_ = os.Remove(persistentFXPEntryGroupPath(spec))
		persistentRuntimeMu.Unlock()
		for _, entry := range spec.Entries {
			removePersistedFXPSpec(entry)
		}
		return
	}
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
		if isFXPEntryGroup(stored.Spec) {
			remaining := make([]fxpSpec, 0, len(stored.Spec.Entries))
			for _, member := range stored.Spec.Entries {
				if !fxpRemovalMatchesEntry(matchSpec, member) {
					remaining = append(remaining, member)
				}
			}
			if len(remaining) == len(stored.Spec.Entries) {
				continue
			}
			path := filepath.Join(persistentFXPDir, entry.Name())
			if len(remaining) == 0 {
				_ = os.Remove(path)
				continue
			}
			stored.Spec.Entries = remaining
			stored.Spec = scrubFXPSpec(stored.Spec)
			if err := writePersistentJSON(path, struct {
				Version int     `json:"version"`
				Spec    fxpSpec `json:"spec"`
			}{Version: persistentStateFileVersion, Spec: stored.Spec}); err != nil {
				logf("persistent FXP entry group removal failed path=%s: %v", path, err)
			}
			continue
		}
		if spec.Role != "" && stored.Spec.Role != spec.Role {
			continue
		}
		if spec.RuleID > 0 && stored.Spec.RuleID != spec.RuleID {
			continue
		}
		if spec.TunnelID > 0 && stored.Spec.TunnelID != spec.TunnelID {
			continue
		}
		if requestedTransportVersion != "" && stored.Spec.TransportVersion != normalizeFXPTransportVersion(requestedTransportVersion) {
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
	persistentRuntimeMu.Lock()
	defer persistentRuntimeMu.Unlock()
	type groupCandidate struct {
		spec    fxpSpec
		modTime int64
		name    string
	}
	groupsByTunnel := map[string]groupCandidate{}
	standalone := make([]fxpSpec, 0)
	files, err := os.ReadDir(persistentFXPDir)
	if err != nil {
		return nil
	}
	for _, file := range files {
		if file.IsDir() || !strings.HasPrefix(file.Name(), "fxp-") || !strings.HasSuffix(file.Name(), ".json") {
			continue
		}
		path := filepath.Join(persistentFXPDir, file.Name())
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			logf("persistent runtime snapshot read failed path=%s: %v", path, readErr)
			continue
		}
		var stored struct {
			Version int     `json:"version"`
			Spec    fxpSpec `json:"spec"`
		}
		if decodeErr := json.Unmarshal(raw, &stored); decodeErr != nil {
			logf("persistent runtime snapshot decode failed path=%s: %v", path, decodeErr)
			continue
		}
		stored.Spec = scrubFXPSpec(stored.Spec)
		if isFXPEntryGroup(stored.Spec) {
			if len(stored.Spec.Entries) == 0 {
				logf("persistent runtime snapshot invalid path=%s: empty FXP entry group", path)
				continue
			}
			info, _ := file.Info()
			modTime := int64(0)
			if info != nil {
				modTime = info.ModTime().UnixNano()
			}
			groupKey := fxpEntryGroupKey(stored.Spec.TransportVersion, stored.Spec.TunnelID)
			previous, exists := groupsByTunnel[groupKey]
			if !exists || modTime > previous.modTime || (modTime == previous.modTime && file.Name() > previous.name) {
				groupsByTunnel[groupKey] = groupCandidate{spec: stored.Spec, modTime: modTime, name: file.Name()}
			}
			continue
		}
		if stored.Spec.Role == "" || stored.Spec.TunnelID <= 0 || stored.Spec.ListenPort <= 0 || stored.Spec.Key == "" {
			logf("persistent runtime snapshot invalid path=%s", path)
			continue
		}
		standalone = append(standalone, stored.Spec)
	}

	byID := map[string]fxpSpec{}
	for _, spec := range standalone {
		if _, grouped := groupsByTunnel[fxpEntryGroupKey(spec.TransportVersion, spec.TunnelID)]; grouped && isSharedFXPEntry(spec) {
			continue
		}
		byID[fxpServerID(spec)] = spec
	}
	for _, candidate := range groupsByTunnel {
		for _, entry := range candidate.spec.Entries {
			if isSharedFXPEntry(entry) && entry.Key != "" {
				byID[fxpServerID(entry)] = entry
			}
		}
	}
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
			// Runtime V2 configs contain translated loopback proxy endpoints. The
			// original panel plan must remain the source for restart recovery.
			continue
		}
		if isFXPEntryGroup(spec) {
			if err := persistFXPSpec(spec); err == nil {
				logf("migrated grouped runtime FXP snapshot path=%s tunnel=%d entries=%d", path, spec.TunnelID, len(spec.Entries))
			}
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
	if isFXPEntryGroup(spec) {
		if len(spec.Entries) == 0 {
			return false
		}
		for _, entry := range spec.Entries {
			if fxpSpecLooksPreparedForWireGuard(entry) {
				return true
			}
		}
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
	specs = planPersistedFXPRestoreSpecs(specs)
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
				ok := startFXP(cfg, spec, nil, message)
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

func planPersistedFXPRestoreSpecs(specs []fxpSpec) []fxpSpec {
	standalone := make([]fxpSpec, 0, len(specs))
	entriesByGroup := map[string][]fxpSpec{}
	groupSeeds := map[string]fxpSpec{}
	for _, spec := range specs {
		spec = normalizeFXPSpec(spec)
		if isFXPEntryGroup(spec) {
			key := fxpEntryGroupKey(spec.TransportVersion, spec.TunnelID)
			entriesByGroup[key] = append(entriesByGroup[key], spec.Entries...)
			groupSeeds[key] = spec
			continue
		}
		if isSharedFXPEntry(spec) {
			key := fxpEntryGroupKey(spec.TransportVersion, spec.TunnelID)
			entriesByGroup[key] = append(entriesByGroup[key], spec)
			groupSeeds[key] = spec
			continue
		}
		standalone = append(standalone, spec)
	}
	for key, entries := range entriesByGroup {
		seed := groupSeeds[key]
		if group, ok := buildSharedFXPEntryGroup(entries, seed.TunnelID, seed.TransportVersion); ok {
			standalone = append(standalone, group)
		}
	}
	sort.Slice(standalone, func(i, j int) bool {
		if standalone[i].TransportVersion != standalone[j].TransportVersion {
			return standalone[i].TransportVersion < standalone[j].TransportVersion
		}
		if standalone[i].TunnelID != standalone[j].TunnelID {
			return standalone[i].TunnelID < standalone[j].TunnelID
		}
		if standalone[i].Role != standalone[j].Role {
			return standalone[i].Role < standalone[j].Role
		}
		if standalone[i].RuleID != standalone[j].RuleID {
			return standalone[i].RuleID < standalone[j].RuleID
		}
		return standalone[i].ListenPort < standalone[j].ListenPort
	})
	return standalone
}
