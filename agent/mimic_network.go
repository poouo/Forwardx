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
	// ForwardX uses userspace UDP transports, including wireguard-go. They do
	// not need NIC offloads disabled for Mimic's checksum rewrite.
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
	raw, err := commandCombinedOutputWithTimeout(3*time.Second, "ethtool", "-k", iface)
	if err != nil {
		return strings.Join(append(parts, "offload=inspect-failed"), " ")
	}
	if enabled := enabledMimicOffloads(string(raw)); len(enabled) > 0 {
		parts = append(parts, "offload=enabled:"+strings.Join(enabled, ","))
	} else {
		parts = append(parts, "offload=disabled")
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

	restored, restoreError := restoreMimicNetworkOffloads(iface)
	message := mimicInterfaceNetworkSummary(iface)
	if restored {
		message = strings.TrimSpace(message + " offloadRestore=restored")
	} else if restoreError != "" {
		message = strings.TrimSpace(message + " offloadRestore=" + restoreError)
		if shouldLogAgentReport("mimic-offload-restore:"+iface, agentReportLogInterval) {
			logf("mimic offload restore failed interface=%s error=%s", iface, restoreError)
		}
	}
	mimicNetworkTuneMu.Lock()
	mimicNetworkTuneCache[iface] = mimicNetworkTuneResult{checkedAt: now, message: message}
	mimicNetworkTuneMu.Unlock()
	return message
}
