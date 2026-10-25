package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const trafficSourceGostNative = "gost-native-v1"
const trafficSourceGuardNative = "guard-native-v1"

func isNativeTrafficSource(source string) bool {
	return source == trafficSourceGostNative || source == trafficSourceGuardNative
}

// A missing capability in the bounding set cannot be gained by executing nft
// or iptables. Do not repeatedly spawn failing repair/snapshot subprocesses in
// restricted LXC containers. Unknown/non-Linux environments keep normal probing.
var kernelTrafficUnavailable = detectKernelTrafficUnavailable

func detectKernelTrafficUnavailable() bool {
	if runtime.GOOS != "linux" {
		return false
	}
	data, err := os.ReadFile("/proc/self/status")
	return err == nil && missingNetAdminBoundingCapability(string(data))
}

func missingNetAdminBoundingCapability(status string) bool {
	for _, line := range strings.Split(status, "\n") {
		if strings.HasPrefix(line, "CapBnd:") {
			mask, err := strconv.ParseUint(strings.TrimSpace(strings.TrimPrefix(line, "CapBnd:")), 16, 64)
			return err == nil && mask&(1<<12) == 0
		}
	}
	return false
}

func validTrafficByteIdentity(source, epoch string) bool {
	switch source {
	case "", "native-nft-v1", "iptables-v1", trafficConnectionSourceProcessNFT, trafficConnectionSourceProcessIptables:
		return epoch == ""
	case trafficSourceGostNative, trafficSourceGuardNative:
		decoded, err := hex.DecodeString(epoch)
		return err == nil && len(decoded) == sha256.Size
	default:
		return false
	}
}

type nativeTrafficSample struct {
	counters trafficCounters
	epoch    string
	source   string
}

// Verified against GOST 3.2.6 (go-gost/x v0.8.1): GET /config exposes
// service.status.stats when service.metadata.enableStats is enabled. These are
// cumulative listener payload bytes, not NIC bytes or kernel packet overhead.
type gostTrafficService struct {
	Name     string `json:"name"`
	Addr     string `json:"addr"`
	Metadata struct {
		EnableStats  bool `json:"enableStats"`
		ResetTraffic bool `json:"observer.resetTraffic"`
	} `json:"metadata"`
	Listener struct {
		Type string `json:"type"`
	} `json:"listener"`
	Status *struct {
		CreateTime int64  `json:"createTime"`
		State      string `json:"state"`
		Stats      *struct {
			InputBytes  uint64 `json:"inputBytes"`
			OutputBytes uint64 `json:"outputBytes"`
			TotalConns  uint64 `json:"totalConns"`
		} `json:"stats"`
	} `json:"status"`
}

func parseGostTrafficSnapshot(data []byte, states []localRuleState, runtimeEpoch string) (map[string]nativeTrafficSample, error) {
	var config struct {
		Services []gostTrafficService `json:"services"`
	}
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("invalid GOST traffic snapshot")
	}
	services := make(map[string]gostTrafficService, len(config.Services))
	duplicates := map[string]bool{}
	for _, service := range config.Services {
		if _, exists := services[service.Name]; exists {
			duplicates[service.Name] = true
		}
		services[service.Name] = service
	}
	result := map[string]nativeTrafficSample{}
	for _, state := range states {
		if strings.ToLower(strings.TrimSpace(state.ForwardType)) != "gost" || !shouldCollectRuleTraffic(state) {
			continue // Never count FXP, probe, relay or exit services a second time.
		}
		sample := nativeTrafficSample{source: trafficSourceGostNative}
		epoch := runtimeEpoch
		complete := true
		for _, protocol := range runtimeProtocols(state.Protocol) {
			name := fmt.Sprintf("fwx-%d-%s", state.RuleID, protocol)
			service, exists := services[name]
			_, port, err := net.SplitHostPort(service.Addr)
			if !exists || duplicates[name] || err != nil || port != state.Port || service.Listener.Type != protocol ||
				!service.Metadata.EnableStats || service.Metadata.ResetTraffic || service.Status == nil ||
				service.Status.Stats == nil || service.Status.CreateTime <= 0 ||
				(service.Status.State != "running" && service.Status.State != "ready") {
				complete = false
				break
			}
			stats := service.Status.Stats
			if ^uint64(0)-sample.counters.In < stats.InputBytes || ^uint64(0)-sample.counters.Out < stats.OutputBytes ||
				^uint64(0)-sample.counters.Connections < stats.TotalConns {
				complete = false
				break
			}
			sample.counters.In += stats.InputBytes
			sample.counters.Out += stats.OutputBytes
			sample.counters.Connections += stats.TotalConns
			epoch += ":" + name + ":" + strconv.FormatInt(service.Status.CreateTime, 10)
		}
		if complete {
			hash := sha256.Sum256([]byte(epoch))
			sample.epoch = hex.EncodeToString(hash[:])
			result[state.Port] = sample
		}
	}
	return result, nil
}

func gostNativeTrafficSnapshot(states []localRuleState) map[string]nativeTrafficSample {
	needed := false
	for _, state := range states {
		if strings.ToLower(strings.TrimSpace(state.ForwardType)) == "gost" {
			needed = true
			break
		}
	}
	if !needed {
		return nil
	}
	// One bounded request for the entire runtime, not one request per rule.
	socket := gostAPIDir + "/" + runtimeServiceName + ".sock"
	info, err := os.Stat(socket)
	if err != nil || info.Mode()&os.ModeSocket == 0 {
		if shouldLogAgentReport("traffic-native-gost-unavailable", 5*time.Minute) {
			logf("traffic native GOST unavailable reason=local-api-missing; update panel/Agent and synchronize GOST rules to enable native statistics")
		}
		return nil
	}
	api, closeIdle := localGostAPI(socket)
	defer closeIdle()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	data, err := api.request(ctx, "GET", "", nil)
	var samples map[string]nativeTrafficSample
	if err == nil {
		// Socket birth changes on runtime restart, even if counters have already
		// exceeded the old baseline. Listener createTime handles API replacements.
		samples, err = parseGostTrafficSnapshot(data, states, strconv.FormatInt(info.ModTime().UnixNano(), 10))
	}
	if err != nil && shouldLogAgentReport("traffic-native-gost-unavailable", 5*time.Minute) {
		logf("traffic native GOST unavailable reason=local-api-read-failed: %v", err)
	}
	return samples
}

func kernelTrafficByteSource(state localRuleState, diagnostics trafficDiagnosticsSnapshot) string {
	switch trafficCounterFamilyForForwardType(state.ForwardType) {
	case trafficCounterFamilyNativeNFT:
		return "native-nft-v1"
	case trafficCounterFamilyIptables:
		return "iptables-v1"
	case trafficCounterFamilyProcess:
		if hasCompleteNftProcessLayout(state, diagnostics.nftProcessMarkers) {
			return trafficConnectionSourceProcessNFT
		}
		return trafficConnectionSourceProcessIptables
	default:
		return ""
	}
}

func trafficByteDeltas(previous trafficPrevState, ruleID int, counters trafficCounters, source, epoch string) (uint64, uint64, bool) {
	initial := previous.ruleID <= 0 || previous.ruleID != ruleID
	changed := previous.byteSource != source && (previous.byteSource != "" || isNativeTrafficSource(source))
	reset := isNativeTrafficSource(source) && (previous.byteEpoch != epoch || counters.In < previous.in || counters.Out < previous.out)
	if initial || changed || reset {
		// Counters from different sources/epochs cannot be subtracted. Start a
		// conservative new baseline rather than replaying already billed bytes.
		return 0, 0, true
	}
	return delta(counters.In, previous.in), delta(counters.Out, previous.out), false
}

// Existing protocol/rate-limit guards already carry TCP/UDP payloads in this
// process. Count that point without introducing another proxy or changing the
// selected forwarding engine. Closed/replaced guards are never misattributed.
func guardNativeTrafficSnapshot(states []localRuleState) map[string]nativeTrafficSample {
	result := map[string]nativeTrafficSample{}
	protocolGuardMu.Lock()
	defer protocolGuardMu.Unlock()
	for _, state := range states {
		if strings.ToLower(strings.TrimSpace(state.ForwardType)) != "guard" {
			continue
		}
		server := protocolGuards[guardID(guardRule{RuleID: state.RuleID, ListenPort: parseStatePort(state.Port)})]
		if server == nil || normalizeRuntimeProtocol(server.rule.Protocol) != normalizeRuntimeProtocol(state.Protocol) {
			continue
		}
		select {
		case <-server.done:
			continue
		default:
		}
		if server.trafficEpoch == "" {
			continue
		}
		result[state.Port] = nativeTrafficSample{
			counters: trafficCounters{In: server.trafficIn.Load(), Out: server.trafficOut.Load(), Connections: server.trafficConns.Load()},
			epoch:    server.trafficEpoch, source: trafficSourceGuardNative,
		}
	}
	return result
}
