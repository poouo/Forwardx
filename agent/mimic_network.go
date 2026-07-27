package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	mimicNetworkTuneInterval       = 5 * time.Minute
	mimicNetworkFailureRetryWindow = 30 * time.Second
)

var mimicOffloadStateDir = "/var/lib/forwardx-agent/mimic-offload"

type mimicNetworkTuneResult struct {
	checkedAt         time.Time
	interfaceIdentity string
	message           string
}

var (
	mimicNetworkTuneMu       sync.Mutex
	mimicNetworkTuneCache    = map[string]mimicNetworkTuneResult{}
	mimicOffloadOperationMu  sync.Mutex
	mimicOffloadOperationMap = map[string]*sync.Mutex{}
)

var mimicOffloadKeys = map[string]string{
	"rx-checksumming":              "rx",
	"tx-checksumming":              "tx",
	"tcp-segmentation-offload":     "tso",
	"generic-segmentation-offload": "gso",
	"generic-receive-offload":      "gro",
	"large-receive-offload":        "lro",
	"rx-gro-hw":                    "rx-gro-hw",
}

var mimicReceiveAggregationOffloads = map[string]bool{
	"gro":       true,
	"lro":       true,
	"rx-gro-hw": true,
}

type mimicOffloadTunePlan struct {
	snapshot []string
	restore  []string
	disable  []string
}

func validMimicInterfaceName(iface string) bool {
	iface = strings.TrimSpace(iface)
	return validNetworkInterfaceName(iface) && iface != "." && iface != ".." && filepath.Base(iface) == iface
}

func mimicOffloadOperationLock(iface string) *sync.Mutex {
	mimicOffloadOperationMu.Lock()
	defer mimicOffloadOperationMu.Unlock()
	lock := mimicOffloadOperationMap[iface]
	if lock == nil {
		lock = &sync.Mutex{}
		mimicOffloadOperationMap[iface] = lock
	}
	return lock
}

func parsedMimicOffloads(output string, mutableOnly bool) []string {
	enabled := []string{}
	for _, line := range strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 2 || fields[1] != "on" || (mutableOnly && strings.Contains(line, "[fixed]")) {
			continue
		}
		key := strings.TrimSuffix(fields[0], ":")
		if short := mimicOffloadKeys[key]; short != "" {
			enabled = append(enabled, short)
		}
	}
	sort.Strings(enabled)
	return enabled
}

func enabledMimicOffloads(output string) []string {
	return parsedMimicOffloads(output, false)
}

func mutableMimicOffloads(output string) []string {
	return parsedMimicOffloads(output, true)
}

func filterMimicReceiveAggregationOffloads(features []string) []string {
	filtered := make([]string, 0, len(features))
	for _, feature := range features {
		if mimicReceiveAggregationOffloads[feature] {
			filtered = append(filtered, feature)
		}
	}
	sort.Strings(filtered)
	return filtered
}

func enabledMimicReceiveAggregationOffloads(output string) []string {
	return filterMimicReceiveAggregationOffloads(enabledMimicOffloads(output))
}

func mutableMimicReceiveAggregationOffloads(output string) []string {
	return filterMimicReceiveAggregationOffloads(mutableMimicOffloads(output))
}

func knownMimicOffload(feature string) bool {
	for _, short := range mimicOffloadKeys {
		if feature == short {
			return true
		}
	}
	return false
}

func buildMimicOffloadTunePlan(enabled, mutableReceive, saved []string, stateExists bool) (mimicOffloadTunePlan, bool) {
	plan := mimicOffloadTunePlan{disable: append([]string(nil), mutableReceive...)}
	sort.Strings(plan.disable)
	if !stateExists {
		plan.snapshot = append([]string(nil), plan.disable...)
		return plan, true
	}

	enabledSet := make(map[string]bool, len(enabled))
	for _, feature := range enabled {
		enabledSet[feature] = true
	}
	seen := map[string]bool{}
	for _, feature := range saved {
		feature = strings.TrimSpace(feature)
		if !knownMimicOffload(feature) {
			return mimicOffloadTunePlan{}, false
		}
		if seen[feature] {
			continue
		}
		seen[feature] = true
		if !mimicReceiveAggregationOffloads[feature] && !enabledSet[feature] {
			plan.restore = append(plan.restore, feature)
		}
	}
	sort.Strings(plan.restore)
	return plan, true
}

func readMimicInterfaceValue(iface, name string) string {
	if !validMimicInterfaceName(iface) {
		return "-"
	}
	raw, err := os.ReadFile(fmt.Sprintf("/sys/class/net/%s/%s", iface, name))
	if err != nil {
		return "-"
	}
	value := strings.TrimSpace(string(raw))
	if value == "" {
		return "-"
	}
	return value
}

func mimicOffloadStatePath(iface string) string {
	return filepath.Join(mimicOffloadStateDir, iface+".state")
}

func captureMimicOffloadState(iface string, enabled []string) error {
	path := mimicOffloadStatePath(iface)
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(mimicOffloadStateDir, 0755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(mimicOffloadStateDir, iface+".state.*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.WriteString(strings.Join(enabled, " ") + "\n"); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

func mimicOffloadDisableArgs(iface string, features []string) ([]string, bool) {
	if !validMimicInterfaceName(iface) {
		return nil, false
	}
	seen := map[string]bool{}
	args := []string{"-K", iface}
	for _, feature := range features {
		feature = strings.TrimSpace(feature)
		if !mimicReceiveAggregationOffloads[feature] {
			return nil, false
		}
		if seen[feature] {
			continue
		}
		seen[feature] = true
		args = append(args, feature, "off")
	}
	return args, true
}

func mimicOffloadRestoreArgs(iface string, features []string) ([]string, bool) {
	if !validMimicInterfaceName(iface) {
		return nil, false
	}
	seen := map[string]bool{}
	args := []string{"-K", iface}
	for _, feature := range features {
		feature = strings.TrimSpace(feature)
		if !knownMimicOffload(feature) {
			return nil, false
		}
		if seen[feature] {
			continue
		}
		seen[feature] = true
		args = append(args, feature, "on")
	}
	return args, true
}

func restoreMimicNetworkOffloads(iface string) (bool, string) {
	if !validMimicInterfaceName(iface) {
		return false, "restore-invalid-interface"
	}
	operationLock := mimicOffloadOperationLock(iface)
	operationLock.Lock()
	defer operationLock.Unlock()
	return restoreMimicNetworkOffloadsLocked(iface)
}

func restoreMimicNetworkOffloadsLocked(iface string) (bool, string) {
	path := mimicOffloadStatePath(iface)
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return false, ""
	}
	if err != nil {
		return false, "restore-state-read-failed:" + compactLogOutput(err.Error())
	}
	features := strings.Fields(string(raw))
	args, valid := mimicOffloadRestoreArgs(iface, features)
	if !valid {
		return false, "restore-state-invalid"
	}
	if len(features) > 0 {
		if !commandExists("ethtool") {
			return false, "restore-ethtool-missing"
		}
		if output, runErr := commandCombinedOutputWithTimeout(5*time.Second, "ethtool", args...); runErr != nil {
			detail := compactLogOutput(string(output))
			if detail == "" {
				detail = runErr.Error()
			}
			return false, "restore-failed:" + detail
		}
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return false, "restore-state-remove-failed:" + compactLogOutput(err.Error())
	}
	mimicNetworkTuneMu.Lock()
	delete(mimicNetworkTuneCache, iface)
	mimicNetworkTuneMu.Unlock()
	logf("mimic network offloads restored interface=%s features=%s", iface, strings.Join(features, ","))
	return true, ""
}

func mimicInterfaceNetworkSummary(iface string) string {
	operationLock := mimicOffloadOperationLock(iface)
	operationLock.Lock()
	defer operationLock.Unlock()

	// Mimic 0.7.1 cannot split fake-TCP packets coalesced by GRO/LRO before the
	// encapsulated WireGuard datagrams reach wireguard-go. Other offloads do not
	// merge receive packets, so preserve them for throughput and CPU efficiency.
	parts := []string{
		"mtu=" + readMimicInterfaceValue(iface, "mtu"),
		"rxDropped=" + readMimicInterfaceValue(iface, "statistics/rx_dropped"),
		"txDropped=" + readMimicInterfaceValue(iface, "statistics/tx_dropped"),
		"rxErrors=" + readMimicInterfaceValue(iface, "statistics/rx_errors"),
		"txErrors=" + readMimicInterfaceValue(iface, "statistics/tx_errors"),
	}
	if !commandExists("ethtool") {
		return strings.Join(append(parts, "offload=ethtool-missing"), " ")
	}
	beforeRaw, err := commandCombinedOutputWithTimeout(3*time.Second, "ethtool", "-k", iface)
	if err != nil {
		return strings.Join(append(parts, "offload=inspect-failed"), " ")
	}

	statePath := mimicOffloadStatePath(iface)
	saved := []string(nil)
	stateExists := false
	if raw, readErr := os.ReadFile(statePath); readErr == nil {
		saved = strings.Fields(string(raw))
		stateExists = true
	} else if !os.IsNotExist(readErr) {
		return strings.Join(append(parts, "offload=state-failed:"+compactLogOutput(readErr.Error())), " ")
	}

	plan, valid := buildMimicOffloadTunePlan(
		enabledMimicOffloads(string(beforeRaw)),
		mutableMimicReceiveAggregationOffloads(string(beforeRaw)),
		saved,
		stateExists,
	)
	if !valid {
		return strings.Join(append(parts, "offload=state-failed:invalid"), " ")
	}
	if !stateExists && len(plan.snapshot) > 0 {
		if err := captureMimicOffloadState(iface, plan.snapshot); err != nil {
			return strings.Join(append(parts, "offload=state-failed:"+compactLogOutput(err.Error())), " ")
		}
	}

	tuneFailures := []string{}
	if len(plan.restore) > 0 {
		args, _ := mimicOffloadRestoreArgs(iface, plan.restore)
		if output, runErr := commandCombinedOutputWithTimeout(5*time.Second, "ethtool", args...); runErr != nil {
			detail := compactLogOutput(string(output))
			if detail == "" {
				detail = runErr.Error()
			}
			tuneFailures = append(tuneFailures, "legacy-restore:"+detail)
		} else {
			parts = append(parts, "offloadMigration=restored:"+strings.Join(plan.restore, ","))
		}
	}
	if len(plan.disable) > 0 {
		args, _ := mimicOffloadDisableArgs(iface, plan.disable)
		if output, runErr := commandCombinedOutputWithTimeout(5*time.Second, "ethtool", args...); runErr != nil {
			detail := compactLogOutput(string(output))
			if detail == "" {
				detail = runErr.Error()
			}
			tuneFailures = append(tuneFailures, "receive-disable:"+detail)
		}
	}

	afterRaw, err := commandCombinedOutputWithTimeout(3*time.Second, "ethtool", "-k", iface)
	if err != nil {
		parts = append(parts, "offload=inspect-failed")
	} else {
		if enabled := enabledMimicOffloads(string(afterRaw)); len(enabled) > 0 {
			parts = append(parts, "offload=enabled:"+strings.Join(enabled, ","))
		} else {
			parts = append(parts, "offload=disabled")
		}
		if receive := enabledMimicReceiveAggregationOffloads(string(afterRaw)); len(receive) > 0 {
			parts = append(parts, "mimicReceive=still-on:"+strings.Join(receive, ","))
		} else {
			parts = append(parts, "mimicReceive=off")
		}
	}
	if len(tuneFailures) > 0 {
		parts = append(parts, "offload=state-failed:"+strings.Join(tuneFailures, ","))
	}
	return compactLogOutput(strings.Join(parts, " "))
}

func restoreUnusedMimicNetworkCompatibility() {
	entries, err := os.ReadDir(mimicOffloadStateDir)
	if err != nil || !commandExists("ethtool") {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".state") {
			continue
		}
		iface := strings.TrimSuffix(entry.Name(), ".state")
		if !validMimicInterfaceName(iface) || managedServiceActive("mimic@"+iface) {
			continue
		}
		if _, restoreError := restoreMimicNetworkOffloads(iface); restoreError != "" && shouldLogAgentReport("mimic-offload-restore:"+iface, agentReportLogInterval) {
			logf("mimic offload restore failed interface=%s error=%s", iface, restoreError)
		}
	}
}

func mimicInterfaceIdentity(iface string) string {
	return strings.Join([]string{
		readMimicInterfaceValue(iface, "ifindex"),
		readMimicInterfaceValue(iface, "address"),
	}, ":")
}

func mimicNetworkTuneCacheWindow(message string) time.Duration {
	for _, marker := range []string{"missing", "failed", "still-on:"} {
		if strings.Contains(message, marker) {
			return mimicNetworkFailureRetryWindow
		}
	}
	return mimicNetworkTuneInterval
}

func ensureMimicNetworkCompatibility(iface string) string {
	if !validMimicInterfaceName(iface) {
		return "network=invalid-interface"
	}
	now := time.Now()
	interfaceIdentity := mimicInterfaceIdentity(iface)
	mimicNetworkTuneMu.Lock()
	if cached, ok := mimicNetworkTuneCache[iface]; ok &&
		cached.interfaceIdentity == interfaceIdentity &&
		now.Sub(cached.checkedAt) < mimicNetworkTuneCacheWindow(cached.message) {
		mimicNetworkTuneMu.Unlock()
		return cached.message
	}
	mimicNetworkTuneMu.Unlock()

	message := mimicInterfaceNetworkSummary(iface)
	mimicNetworkTuneMu.Lock()
	mimicNetworkTuneCache[iface] = mimicNetworkTuneResult{
		checkedAt:         now,
		interfaceIdentity: interfaceIdentity,
		message:           message,
	}
	mimicNetworkTuneMu.Unlock()
	return message
}
