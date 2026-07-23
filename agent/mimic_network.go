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

const mimicNetworkTuneInterval = 5 * time.Minute

var mimicOffloadStateDir = "/var/lib/forwardx-agent/mimic-offload"

type mimicNetworkTuneResult struct {
	checkedAt time.Time
	message   string
}

var (
	mimicNetworkTuneMu    sync.Mutex
	mimicNetworkTuneCache = map[string]mimicNetworkTuneResult{}
)

var mimicOffloadKeys = map[string]string{
	"rx-checksumming":              "rx",
	"tx-checksumming":              "tx",
	"tcp-segmentation-offload":     "tso",
	"generic-segmentation-offload": "gso",
	"generic-receive-offload":      "gro",
	"large-receive-offload":        "lro",
}

func validMimicInterfaceName(iface string) bool {
	iface = strings.TrimSpace(iface)
	return validNetworkInterfaceName(iface) && iface != "." && iface != ".." && filepath.Base(iface) == iface
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

func mimicOffloadDisableArgs(iface string, features []string) []string {
	args := []string{"-K", iface}
	for _, feature := range features {
		args = append(args, feature, "off")
	}
	return args
}

func mimicOffloadRestoreArgs(iface string, features []string) ([]string, bool) {
	if !validMimicInterfaceName(iface) {
		return nil, false
	}
	allowed := map[string]bool{"gro": true, "gso": true, "tso": true, "lro": true, "tx": true, "rx": true}
	seen := map[string]bool{}
	args := []string{"-K", iface}
	for _, feature := range features {
		feature = strings.TrimSpace(feature)
		if !allowed[feature] {
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
	mutableEnabled := mutableMimicOffloads(string(beforeRaw))
	if err := captureMimicOffloadState(iface, mutableEnabled); err != nil {
		return strings.Join(append(parts, "offload=state-failed:"+compactLogOutput(err.Error())), " ")
	}

	failed := ""
	if len(mutableEnabled) > 0 {
		args := mimicOffloadDisableArgs(iface, mutableEnabled)
		if output, runErr := commandCombinedOutputWithTimeout(5*time.Second, "ethtool", args...); runErr != nil {
			failed = compactLogOutput(string(output))
			if failed == "" {
				failed = runErr.Error()
			}
		}
	}

	raw, err := commandCombinedOutputWithTimeout(3*time.Second, "ethtool", "-k", iface)
	if err != nil {
		parts = append(parts, "offload=inspect-failed")
	} else if enabled := enabledMimicOffloads(string(raw)); len(enabled) > 0 {
		parts = append(parts, "offload=still-on:"+strings.Join(enabled, ","))
	} else {
		parts = append(parts, "offload=off")
	}
	if failed != "" {
		parts = append(parts, "offloadTuneError="+failed)
	}
	return compactLogOutput(strings.Join(parts, " "))
}

func restoreUnusedMimicNetworkCompatibility(activeServices []string) {
	active := map[string]bool{}
	for _, service := range activeServices {
		if strings.HasPrefix(service, "mimic@") {
			active[strings.TrimPrefix(service, "mimic@")] = true
		}
	}
	entries, err := os.ReadDir(mimicOffloadStateDir)
	if err != nil || !commandExists("ethtool") {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".state") {
			continue
		}
		iface := strings.TrimSuffix(entry.Name(), ".state")
		if !validMimicInterfaceName(iface) || active[iface] || managedServiceActive("mimic@"+iface) {
			continue
		}
		if _, restoreError := restoreMimicNetworkOffloads(iface); restoreError != "" && shouldLogAgentReport("mimic-offload-restore:"+iface, agentReportLogInterval) {
			logf("mimic offload restore failed interface=%s error=%s", iface, restoreError)
		}
	}
}

func ensureMimicNetworkCompatibility(iface string) string {
	if !validMimicInterfaceName(iface) {
		return "network=invalid-interface"
	}
	now := time.Now()
	mimicNetworkTuneMu.Lock()
	if cached, ok := mimicNetworkTuneCache[iface]; ok && now.Sub(cached.checkedAt) < mimicNetworkTuneInterval {
		mimicNetworkTuneMu.Unlock()
		return cached.message
	}
	mimicNetworkTuneMu.Unlock()

	message := mimicInterfaceNetworkSummary(iface)
	mimicNetworkTuneMu.Lock()
	mimicNetworkTuneCache[iface] = mimicNetworkTuneResult{checkedAt: now, message: message}
	mimicNetworkTuneMu.Unlock()
	return message
}
