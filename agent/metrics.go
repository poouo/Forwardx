package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"net"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	agentStateDir        = "/var/lib/forwardx-agent"
	tcpingRuleBatchSize  = 24
	tcpingProbeBatchSize = 12
	tcpingMaxConcurrency = 32
	tcpingProbeTimeout   = 2 * time.Second
	tcpingPingProbeCount = 5
)

var (
	tcpingCursorMu           sync.Mutex
	tcpingRuleCursor         int
	tcpingTunnelCursor       int
	tcpingForwardGroupCursor int
	tcpingServiceCursor      int
	tcpingCollectRunning     int32
)

type localRuleState struct {
	Port        string
	RuleID      int
	TunnelID    int
	ForwardType string
	TargetIP    string
	TargetPort  int
	Protocol    string
}

type trafficCounters struct {
	In  uint64
	Out uint64
}

type tcpingTask struct {
	Kind            string
	RuleID          int
	TunnelID        int
	GroupID         int
	MemberID        int
	ProbeType       string
	ServiceID       int
	Method          string
	TargetIP        string
	TargetPort      int
	HopIndex        int
	HopCount        int
	SeriesKey       string
	SeriesLabel     string
	WireGuardPeerID string
	SourcePort      int
	ProbeKey        string
	TopologyKey     string
}

type tcpingTaskResult struct {
	Kind    string
	Payload map[string]any
}

func compactTrafficStat(stat map[string]any) []any {
	return []any{
		stat["ruleId"],
		stat["bytesIn"],
		stat["bytesOut"],
		stat["connections"],
	}
}

func hostTrafficSnapshot() map[string]any {
	return map[string]any{
		"bytesIn":  netBytes(0),
		"bytesOut": netBytes(1),
	}
}

func collectTraffic(cfg Config) time.Duration {
	started := time.Now()
	states := readLocalRuleStates()
	nextInterval := trafficCollectIntervalForRuleCount(len(states))
	defer func() {
		elapsed := time.Since(started)
		if elapsed >= nextInterval/2 {
			if shouldLogAgentReport("traffic-collect-slow", 5*time.Minute) {
				logf("traffic collect slow rules=%d duration=%s nextInterval=%s", len(states), elapsed.Truncate(time.Millisecond), trafficCollectBackoffInterval(nextInterval, elapsed))
			}
		}
	}()
	iptablesCounters := iptablesCounterSnapshot()
	nftCounters := nftablesCounterSnapshot()
	connCounts := conntrackConnectionsSnapshot(states)
	stats := []map[string]any{}
	watched := len(states)
	for _, state := range states {
		if state.RuleID <= 0 {
			continue
		}
		counters := iptablesCounters[state.Port]
		if state.ForwardType == "nftables" {
			if nft, ok := nftCounters[state.RuleID]; ok {
				counters = nft
			}
		}
		curConns := connCounts[state.Port]
		prevRuleID, prevIn, prevOut, prevConns := readPrev(state.Port)
		if prevRuleID <= 0 || prevRuleID != state.RuleID {
			prevIn, prevOut = counters.In, counters.Out
			prevConns = curConns
		}
		din, dout, dconns := delta(counters.In, prevIn), delta(counters.Out, prevOut), delta(curConns, prevConns)
		writePrev(state.Port, state.RuleID, counters.In, counters.Out, curConns)
		if din > 0 || dout > 0 || dconns > 0 {
			stats = append(stats, map[string]any{"ruleId": state.RuleID, "bytesIn": din, "bytesOut": dout, "connections": dconns})
		}
		logTrafficCounterDiagnostic(state, counters, din, dout, curConns, nftCounters)
	}
	hostTraffic := hostTrafficSnapshot()
	payload := map[string]any{"stats": stats, "hostTraffic": hostTraffic}
	if compactAgentReports.Load() {
		compactStats := make([][]any, 0, len(stats))
		for _, stat := range stats {
			compactStats = append(compactStats, compactTrafficStat(stat))
		}
		payload = map[string]any{
			"s": compactStats,
			"h": []any{hostTraffic["bytesIn"], hostTraffic["bytesOut"]},
		}
	}
	if len(stats) > 0 || hostTraffic != nil {
		if err := post(cfg, "/api/agent/traffic", payload, &map[string]any{}); err != nil {
			if isTransientAgentCommError(err) {
				logAgentCommError("traffic-report", err)
			} else if shouldLogAgentReport("traffic-report-failed", agentReportLogInterval) {
				logf("traffic report failed watched=%d stats=%d: %v", watched, len(stats), err)
			}
		} else if agentVerboseLogs && len(stats) > 0 && shouldLogAgentReport("traffic-report-ok", 5*time.Minute) {
			logf("traffic report ok watched=%d stats=%d", watched, len(stats))
		}
	}
	return trafficCollectBackoffInterval(nextInterval, time.Since(started))
}

func trafficCollectIntervalForRuleCount(count int) time.Duration {
	switch {
	case count >= 500:
		return 15 * time.Second
	case count >= 300:
		return 12 * time.Second
	case count >= 150:
		return 8 * time.Second
	case count >= 50:
		return 5 * time.Second
	default:
		return trafficCollectInterval
	}
}

func trafficCollectBackoffInterval(base time.Duration, elapsed time.Duration) time.Duration {
	next := base
	if elapsed >= 5*time.Second {
		next = base * 3
	} else if elapsed >= 2*time.Second {
		next = base * 2
	}
	if next < trafficCollectInterval {
		next = trafficCollectInterval
	}
	if next > trafficCollectMaxInterval {
		next = trafficCollectMaxInterval
	}
	return next
}

func collectTCPing(cfg Config, probes []tunnelProbe, groupProbes []forwardGroupProbe, serviceProbes []hostProbeServiceProbe, force bool) {
	ruleTasks := []tcpingTask{}
	for _, state := range readLocalRuleStates() {
		if task, ok := buildRuleLatencyProbeTask(state); ok {
			ruleTasks = append(ruleTasks, task)
		}
	}

	tunnelTasks := []tcpingTask{}
	for _, probe := range probes {
		if probe.TunnelID <= 0 || probe.TargetIP == "" || probe.TargetPort <= 0 {
			continue
		}
		tunnelTasks = append(tunnelTasks, tcpingTask{
			Kind:            "tunnel",
			TunnelID:        probe.TunnelID,
			TargetIP:        probe.TargetIP,
			TargetPort:      probe.TargetPort,
			Method:          "tcp",
			HopIndex:        probe.HopIndex,
			HopCount:        probe.HopCount,
			SeriesKey:       probe.SeriesKey,
			SeriesLabel:     probe.SeriesLabel,
			WireGuardPeerID: probe.WireGuardPeerID,
			ProbeKey:        probe.ProbeKey,
			TopologyKey:     probe.TopologyKey,
		})
	}

	serviceTasks := []tcpingTask{}
	for _, probe := range serviceProbes {
		if probe.ServiceID <= 0 || probe.TargetIP == "" {
			continue
		}
		method := strings.ToLower(strings.TrimSpace(probe.Method))
		if method == "ping" {
			serviceTasks = append(serviceTasks, tcpingTask{
				Kind:      "service",
				ServiceID: probe.ServiceID,
				Method:    method,
				TargetIP:  probe.TargetIP,
				ProbeKey:  fmt.Sprintf("service:%d:%s:ping", probe.ServiceID, strings.ToLower(strings.TrimSpace(probe.TargetIP))),
			})
			continue
		}
		if probe.TargetPort <= 0 {
			continue
		}
		serviceTasks = append(serviceTasks, tcpingTask{
			Kind:       "service",
			ServiceID:  probe.ServiceID,
			Method:     "tcping",
			TargetIP:   probe.TargetIP,
			TargetPort: probe.TargetPort,
			ProbeKey:   fmt.Sprintf("service:%d:%s:%d:tcping", probe.ServiceID, strings.ToLower(strings.TrimSpace(probe.TargetIP)), probe.TargetPort),
		})
	}

	forwardGroupTasks := []tcpingTask{}
	for _, probe := range groupProbes {
		if probe.GroupID <= 0 || probe.TargetIP == "" || probe.HopCount <= 0 {
			continue
		}
		method := strings.ToLower(strings.TrimSpace(probe.Method))
		if method != "ping" && probe.TargetPort <= 0 {
			continue
		}
		if method != "ping" {
			method = "tcp"
		}
		forwardGroupTasks = append(forwardGroupTasks, tcpingTask{
			Kind:        "forwardGroup",
			GroupID:     probe.GroupID,
			MemberID:    probe.MemberID,
			ProbeType:   probe.ProbeType,
			Method:      method,
			TargetIP:    probe.TargetIP,
			TargetPort:  probe.TargetPort,
			HopIndex:    probe.HopIndex,
			HopCount:    probe.HopCount,
			ProbeKey:    probe.ProbeKey,
			TopologyKey: probe.TopologyKey,
		})
	}

	cycleInterval := tcpingDueInterval(serviceProbes, len(ruleTasks), len(tunnelTasks)+len(forwardGroupTasks))
	ruleRounds := tcpingRoundsForWindow(cycleInterval, 3*time.Minute)
	ruleLimit := tcpingDynamicBatchLimit(len(ruleTasks), tcpingRuleBatchSize, ruleRounds, 256)
	probeLimit := len(forwardGroupTasks)
	serviceLimit := tcpingDynamicBatchLimit(len(serviceTasks), tcpingProbeBatchSize, 1, 96)
	if force {
		ruleLimit = minInt(len(ruleTasks), ruleLimit*2)
		serviceLimit = minInt(len(serviceTasks), serviceLimit*2)
	}
	tunnelProbeLimit := len(tunnelTasks)
	tcpingCursorMu.Lock()
	selected := []tcpingTask{}
	selected = append(selected, rotateTCPingTasks(ruleTasks, &tcpingRuleCursor, ruleLimit)...)
	selected = append(selected, rotateTCPingTasks(tunnelTasks, &tcpingTunnelCursor, tunnelProbeLimit)...)
	selected = append(selected, rotateTCPingTasks(forwardGroupTasks, &tcpingForwardGroupCursor, probeLimit)...)
	selected = append(selected, rotateTCPingTasks(serviceTasks, &tcpingServiceCursor, serviceLimit)...)
	tcpingCursorMu.Unlock()
	if len(selected) == 0 {
		return
	}

	results, tunnels, forwardGroups, services := runTCPingTasks(selected)
	if len(results) > 0 || len(tunnels) > 0 || len(forwardGroups) > 0 || len(services) > 0 {
		payload := map[string]any{"results": results, "tunnels": tunnels, "forwardGroups": forwardGroups, "services": services}
		if err := post(cfg, "/api/agent/tcping", payload, &map[string]any{}); err != nil {
			if isTransientAgentCommError(err) {
				logAgentCommError("tcping-report", err)
			} else if shouldLogAgentReport("tcping-report-failed", agentReportLogInterval) {
				logf("tcping report failed rules=%d tunnels=%d groups=%d services=%d: %v", len(results), len(tunnels), len(forwardGroups), len(services), err)
			}
		} else if agentVerboseLogs && (len(tunnels) > 0 || len(forwardGroups) > 0 || len(services) > 0) {
			total, timeouts, avgLatency := summarizeTCPingReport(results, tunnels, forwardGroups, services)
			if shouldLogAgentReport("tcping-report-ok", agentReportLogInterval) {
				logf("tcping report ok rules=%d tunnels=%d groups=%d services=%d timeouts=%d/%d avg=%s", len(results), len(tunnels), len(forwardGroups), len(services), timeouts, total, avgLatency)
			}
		}
	}
}

func buildRuleLatencyProbeTask(state localRuleState) (tcpingTask, bool) {
	port := parseStatePort(state.Port)
	if desired, ok := desiredRunningRuleForStatePort(state.RuleID, port); ok {
		state.TunnelID = desired.TunnelID
		state.ForwardType = desired.ForwardType
		state.TargetIP = desired.TargetIP
		state.TargetPort = desired.TargetPort
		state.Protocol = desired.Protocol
	}
	if state.RuleID <= 0 || port <= 0 || strings.TrimSpace(state.TargetIP) == "" || state.TargetPort <= 0 {
		return tcpingTask{}, false
	}
	method := "tcping"
	if normalizeRuntimeProtocol(state.Protocol) == "udp" {
		method = "ping"
	}
	return tcpingTask{
		Kind:       "rule",
		RuleID:     state.RuleID,
		Method:     method,
		TargetIP:   state.TargetIP,
		TargetPort: state.TargetPort,
		SourcePort: port,
		ProbeKey:   fmt.Sprintf("rule:%d:%s:%d:%s", state.RuleID, strings.ToLower(strings.TrimSpace(state.TargetIP)), state.TargetPort, method),
	}, true
}

func scheduleTCPingCollection(cfg Config, probes []tunnelProbe, groupProbes []forwardGroupProbe, serviceProbes []hostProbeServiceProbe, force bool) bool {
	if !atomic.CompareAndSwapInt32(&tcpingCollectRunning, 0, 1) {
		logVerbosef("tcping collect skip because previous run is still active")
		return false
	}
	probesCopy := append([]tunnelProbe(nil), probes...)
	groupProbesCopy := append([]forwardGroupProbe(nil), groupProbes...)
	serviceProbesCopy := append([]hostProbeServiceProbe(nil), serviceProbes...)
	go func() {
		started := time.Now()
		defer atomic.StoreInt32(&tcpingCollectRunning, 0)
		collectTCPing(cfg, probesCopy, groupProbesCopy, serviceProbesCopy, force)
		if elapsed := time.Since(started); elapsed >= 5*time.Second && shouldLogAgentReport("tcping-collect-slow-async", 5*time.Minute) {
			logf("tcping collect slow duration=%s tunnels=%d groups=%d services=%d force=%v", elapsed.Round(time.Millisecond), len(probesCopy), len(groupProbesCopy), len(serviceProbesCopy), force)
		}
	}()
	return true
}

func tcpingDynamicBatchLimit(total, minimum, targetRounds, maximum int) int {
	if total <= 0 {
		return 0
	}
	if targetRounds <= 0 {
		targetRounds = 1
	}
	limit := (total + targetRounds - 1) / targetRounds
	if limit < minimum {
		limit = minimum
	}
	if maximum > 0 && limit > maximum {
		limit = maximum
	}
	if limit > total {
		limit = total
	}
	return limit
}

func tcpingRoundsForWindow(interval time.Duration, window time.Duration) int {
	if interval <= 0 || window <= interval {
		return 1
	}
	return int((window + interval - 1) / interval)
}

func summarizeTCPingReport(results, tunnels, forwardGroups, services []map[string]any) (int, int, string) {
	groups := [][]map[string]any{results, tunnels, forwardGroups, services}
	total := 0
	timeouts := 0
	latencyTotal := 0
	latencyCount := 0
	for _, group := range groups {
		for _, item := range group {
			total++
			if timeout, _ := item["isTimeout"].(bool); timeout {
				timeouts++
			}
			switch value := item["latencyMs"].(type) {
			case int:
				if value > 0 {
					latencyTotal += value
					latencyCount++
				}
			case int64:
				if value > 0 {
					latencyTotal += int(value)
					latencyCount++
				}
			case float64:
				if value > 0 {
					latencyTotal += int(value)
					latencyCount++
				}
			}
		}
	}
	if latencyCount == 0 {
		return total, timeouts, "-"
	}
	return total, timeouts, fmt.Sprintf("%dms", latencyTotal/latencyCount)
}

func readLocalRuleStates() []localRuleState {
	files, err := os.ReadDir(agentStateDir)
	if err != nil {
		return nil
	}
	states := make([]localRuleState, 0, len(files))
	for _, f := range files {
		name := f.Name()
		if !strings.HasPrefix(name, "port_") || !strings.HasSuffix(name, ".rule") {
			continue
		}
		port := strings.TrimSuffix(strings.TrimPrefix(name, "port_"), ".rule")
		ridBytes, err := os.ReadFile(agentStateDir + "/" + name)
		if err != nil {
			continue
		}
		ruleID, _ := strconv.Atoi(strings.TrimSpace(string(ridBytes)))
		targetIP, targetPort, protocol, _ := readTargetInfo(port)
		states = append(states, localRuleState{
			Port:        port,
			RuleID:      ruleID,
			TunnelID:    readRuleTunnelIDByPort(port),
			ForwardType: readForwardTypeByPort(port),
			TargetIP:    targetIP,
			TargetPort:  targetPort,
			Protocol:    protocol,
		})
	}
	sort.Slice(states, func(i, j int) bool {
		if states[i].RuleID != states[j].RuleID {
			return states[i].RuleID < states[j].RuleID
		}
		return states[i].Port < states[j].Port
	})
	return states
}

func parseStatePort(value string) int {
	port, _ := strconv.Atoi(strings.TrimSpace(value))
	return port
}

func rotateTCPingTasks(tasks []tcpingTask, cursor *int, limit int) []tcpingTask {
	if len(tasks) == 0 || limit <= 0 {
		return nil
	}
	if limit >= len(tasks) {
		*cursor = 0
		return append([]tcpingTask(nil), tasks...)
	}
	start := *cursor % len(tasks)
	if start < 0 {
		start = 0
	}
	selected := make([]tcpingTask, 0, limit)
	for i := 0; i < limit; i++ {
		selected = append(selected, tasks[(start+i)%len(tasks)])
	}
	*cursor = (start + limit) % len(tasks)
	return selected
}

func runTCPingTasks(tasks []tcpingTask) ([]map[string]any, []map[string]any, []map[string]any, []map[string]any) {
	sem := make(chan struct{}, tcpingMaxConcurrency)
	out := make(chan tcpingTaskResult, len(tasks))
	var wg sync.WaitGroup
	for _, task := range tasks {
		task := task
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			out <- executeTCPingTask(task)
		}()
	}
	wg.Wait()
	close(out)
	results := []map[string]any{}
	tunnels := []map[string]any{}
	forwardGroups := []map[string]any{}
	services := []map[string]any{}
	for result := range out {
		if result.Payload == nil {
			continue
		}
		switch result.Kind {
		case "rule":
			results = append(results, result.Payload)
		case "tunnel":
			tunnels = append(tunnels, result.Payload)
		case "forwardGroup":
			forwardGroups = append(forwardGroups, result.Payload)
		case "service":
			services = append(services, result.Payload)
		}
	}
	return results, tunnels, forwardGroups, services
}

func executeTCPingTask(task tcpingTask) tcpingTaskResult {
	var latency int
	var reachable bool
	if (task.Kind == "rule" || task.Kind == "forwardGroup" || task.Kind == "service") && task.Method == "ping" {
		latency, reachable, _ = pingLatencyWithCount(task.TargetIP, tcpingProbeTimeout, tcpingPingProbeCount)
	} else if task.Kind == "tunnel" && task.WireGuardPeerID != "" {
		latency, reachable = wireGuardTCPLatency(task.TunnelID, task.WireGuardPeerID, task.TargetPort, tcpingProbeTimeout)
	} else {
		latency, reachable = tcpLatency(task.TargetIP, task.TargetPort, tcpingProbeTimeout)
	}
	payload := map[string]any{}
	switch task.Kind {
	case "rule":
		payload["ruleId"] = task.RuleID
		payload["sourcePort"] = task.SourcePort
	case "tunnel":
		payload["tunnelId"] = task.TunnelID
		if task.HopCount > 0 {
			payload["hopIndex"] = task.HopIndex
			payload["hopCount"] = task.HopCount
		}
		if task.SeriesKey != "" {
			payload["seriesKey"] = task.SeriesKey
		}
		if task.SeriesLabel != "" {
			payload["seriesLabel"] = task.SeriesLabel
		}
	case "forwardGroup":
		payload["groupId"] = task.GroupID
		if task.MemberID > 0 {
			payload["memberId"] = task.MemberID
		}
		if task.ProbeType != "" {
			payload["probeType"] = task.ProbeType
		}
		payload["method"] = task.Method
		payload["hopIndex"] = task.HopIndex
		payload["hopCount"] = task.HopCount
	case "service":
		payload["serviceId"] = task.ServiceID
		payload["method"] = task.Method
	default:
		return tcpingTaskResult{}
	}
	if task.TargetIP != "" {
		payload["targetIp"] = task.TargetIP
	}
	if task.TargetPort > 0 {
		payload["targetPort"] = task.TargetPort
	}
	if task.Method != "" {
		payload["method"] = task.Method
	}
	if task.ProbeKey != "" {
		payload["probeKey"] = task.ProbeKey
	}
	if task.TopologyKey != "" {
		payload["topologyKey"] = task.TopologyKey
	}
	if reachable {
		payload["latencyMs"] = latency
		payload["isTimeout"] = false
	} else {
		payload["latencyMs"] = 0
		payload["isTimeout"] = true
	}
	return tcpingTaskResult{Kind: task.Kind, Payload: payload}
}

func readTargetInfo(port string) (string, int, string, bool) {
	b, err := os.ReadFile("/var/lib/forwardx-agent/target_" + port + ".info")
	if err != nil {
		return "", 0, "tcp", false
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) < 2 {
		return "", 0, "tcp", false
	}
	targetIP := strings.TrimSpace(lines[0])
	targetPort, _ := strconv.Atoi(strings.TrimSpace(lines[1]))
	protocol := "tcp"
	if len(lines) >= 3 {
		protocol = normalizeRuntimeProtocol(lines[2])
	}
	return targetIP, targetPort, protocol, targetIP != "" && targetPort > 0
}

func tcpLatency(ip string, port int, timeout time.Duration) (int, bool) {
	latency, ok, _ := tcpLatencyResolved(ip, port, timeout)
	return latency, ok
}

func tcpLatencyResolved(host string, port int, timeout time.Duration) (int, bool, string) {
	target := normalizeNetworkTargetHost(host)
	if target == "" || port <= 0 {
		return 0, false, ""
	}
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	targets := []string{target}
	if net.ParseIP(target) == nil {
		resolved := resolveNetworkTargetIPs(target, timeout)
		if len(resolved) == 0 {
			return 0, false, ""
		}
		targets = resolved
	}
	for _, dialHost := range targets {
		start := time.Now()
		conn, err := net.DialTimeout("tcp", net.JoinHostPort(dialHost, strconv.Itoa(port)), timeout)
		if err != nil {
			continue
		}
		_ = conn.Close()
		latency := int(time.Since(start).Milliseconds())
		if latency < 1 {
			latency = 1
		}
		return latency, true, dialHost
	}
	return 0, false, ""
}

func resolveNetworkTargetIPs(host string, timeout time.Duration) []string {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	targets := make([]string, 0, len(addrs))
	for _, addr := range addrs {
		value := strings.TrimSpace(addr.String())
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		targets = append(targets, value)
	}
	return targets
}

func pingLatency(host string, timeout time.Duration) (int, bool, string) {
	return pingLatencyWithCount(host, timeout, 1)
}

func normalizeNetworkTargetHost(host string) string {
	target := strings.TrimSpace(strings.ReplaceAll(host, "：", ":"))
	if target == "" {
		return ""
	}
	lower := strings.ToLower(target)
	for _, prefix := range []string{"tcp://", "udp://"} {
		if strings.HasPrefix(lower, prefix) {
			target = strings.TrimSpace(target[len(prefix):])
			lower = strings.ToLower(target)
			break
		}
	}
	if parsedHost, _, err := net.SplitHostPort(target); err == nil {
		return strings.TrimSpace(parsedHost)
	}
	if strings.HasPrefix(target, "[") {
		if end := strings.Index(target, "]"); end > 0 {
			return strings.TrimSpace(target[1:end])
		}
	}
	return target
}

func pingFamilyArg(host string) string {
	ip := net.ParseIP(normalizeNetworkTargetHost(host))
	if ip == nil {
		return ""
	}
	if ip.To4() != nil {
		return "-4"
	}
	return "-6"
}

func pingLatencyWithCount(host string, timeout time.Duration, count int) (int, bool, string) {
	target := normalizeNetworkTargetHost(host)
	if target == "" {
		return 0, false, "目标为空"
	}
	if count < 1 {
		count = 1
	}
	if latency, ok, detail, err := nativePingLatencyWithCount(target, timeout, count); err == nil {
		return latency, ok, detail
	} else if shouldLogAgentReport("native-ping-fallback", 5*time.Minute) {
		logf("native ping unavailable target=%s: %v; falling back to system ping", target, err)
	}
	start := time.Now()
	ctxTimeout := timeout + time.Second
	if count > 1 {
		ctxTimeout = timeout*time.Duration(count) + 2*time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), ctxTimeout)
	defer cancel()
	timeoutSeconds := int(timeout.Seconds())
	if timeoutSeconds < 1 {
		timeoutSeconds = 1
	}
	familyArg := pingFamilyArg(target)
	args := []string{}
	if familyArg != "" {
		args = append(args, familyArg)
	}
	args = append(args, "-c", strconv.Itoa(count), "-W", strconv.Itoa(timeoutSeconds), target)
	if runtime.GOOS == "windows" {
		args = []string{}
		if familyArg != "" {
			args = append(args, familyArg)
		}
		args = append(args, "-n", strconv.Itoa(count), "-w", strconv.Itoa(int(timeout.Milliseconds())), target)
	}
	output, err := exec.CommandContext(ctx, "ping", args...).CombinedOutput()
	elapsed := int(time.Since(start).Milliseconds())
	if elapsed < 1 {
		elapsed = 1
	}
	text := string(output)
	if ctx.Err() == context.DeadlineExceeded {
		return 0, false, "timeout"
	}
	if parsed := parsePingLatencyMs(text); parsed > 0 {
		return parsed, true, ""
	}
	if err != nil {
		detail := strings.TrimSpace(text)
		if detail == "" {
			detail = err.Error()
		}
		return 0, false, detail
	}
	return elapsed, true, ""
}

func nativePingLatencyWithCount(target string, timeout time.Duration, count int) (int, bool, string, error) {
	if runtime.GOOS == "windows" {
		return 0, false, "", fmt.Errorf("native ping unsupported on windows")
	}
	if timeout <= 0 {
		timeout = tcpingProbeTimeout
	}
	targets := []string{target}
	if net.ParseIP(target) == nil {
		resolved := resolveNetworkTargetIPs(target, timeout)
		if len(resolved) == 0 {
			return 0, false, "resolve failed", nil
		}
		targets = resolved
	}
	var lastErr error
	for _, value := range targets {
		ip := net.ParseIP(value)
		if ip == nil {
			continue
		}
		latency, ok, err := nativePingIP(ip, timeout, count)
		if err != nil {
			lastErr = err
			continue
		}
		if ok {
			return latency, true, value, nil
		}
	}
	if lastErr != nil {
		return 0, false, "", lastErr
	}
	return 0, false, "timeout", nil
}

func nativePingIP(ip net.IP, timeout time.Duration, count int) (int, bool, error) {
	ipv4 := ip.To4()
	if ipv4 == nil {
		return 0, false, fmt.Errorf("native ping currently supports ipv4 only")
	}
	conn, err := net.ListenPacket("ip4:icmp", "0.0.0.0")
	if err != nil {
		return 0, false, err
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return 0, false, err
	}
	id := os.Getpid() & 0xffff
	baseSeq := int(time.Now().UnixNano()) & 0xffff
	sentAt := map[int]time.Time{}
	for i := 0; i < count; i++ {
		seq := (baseSeq + i) & 0xffff
		packet := buildICMPEchoRequest(8, id, seq)
		sentAt[seq] = time.Now()
		if _, err := conn.WriteTo(packet, &net.IPAddr{IP: ipv4}); err != nil {
			return 0, false, err
		}
	}
	buf := make([]byte, 1500)
	totalLatency := 0
	successes := 0
	for {
		n, addr, err := conn.ReadFrom(buf)
		if err != nil {
			break
		}
		if ipAddr, ok := addr.(*net.IPAddr); ok && !ipAddr.IP.Equal(ipv4) {
			continue
		}
		msg := stripIPv4Header(buf[:n])
		if len(msg) < 8 || msg[0] != 0 || msg[1] != 0 {
			continue
		}
		if int(binary.BigEndian.Uint16(msg[4:6])) != id {
			continue
		}
		seq := int(binary.BigEndian.Uint16(msg[6:8]))
		started, ok := sentAt[seq]
		if !ok {
			continue
		}
		delete(sentAt, seq)
		latency := int(time.Since(started).Milliseconds())
		if latency < 1 {
			latency = 1
		}
		totalLatency += latency
		successes++
		if successes >= count {
			break
		}
	}
	if successes == 0 {
		return 0, false, nil
	}
	return totalLatency / successes, true, nil
}

func buildICMPEchoRequest(typ byte, id int, seq int) []byte {
	payload := make([]byte, 24)
	payload[0] = typ
	binary.BigEndian.PutUint16(payload[4:6], uint16(id))
	binary.BigEndian.PutUint16(payload[6:8], uint16(seq))
	binary.BigEndian.PutUint64(payload[8:16], uint64(time.Now().UnixNano()))
	copy(payload[16:], []byte("forwardx"))
	checksum := icmpChecksum(payload)
	binary.BigEndian.PutUint16(payload[2:4], checksum)
	return payload
}

func stripIPv4Header(packet []byte) []byte {
	if len(packet) < 20 || packet[0]>>4 != 4 {
		return packet
	}
	headerLen := int(packet[0]&0x0f) * 4
	if headerLen < 20 || len(packet) < headerLen+8 {
		return packet
	}
	return packet[headerLen:]
}

func icmpChecksum(data []byte) uint16 {
	sum := uint32(0)
	for i := 0; i+1 < len(data); i += 2 {
		sum += uint32(binary.BigEndian.Uint16(data[i : i+2]))
	}
	if len(data)%2 == 1 {
		sum += uint32(data[len(data)-1]) << 8
	}
	for sum>>16 != 0 {
		sum = (sum & 0xffff) + (sum >> 16)
	}
	return ^uint16(sum)
}

func parsePingLatencyMs(output string) int {
	summaryPatterns := []*regexp.Regexp{
		regexp.MustCompile(`(?i)(?:rtt|round-trip)[^=]*=\s*[0-9]+(?:\.[0-9]+)?/([0-9]+(?:\.[0-9]+)?)`),
		regexp.MustCompile(`(?i)Average\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*ms`),
		regexp.MustCompile(`(?i)avg[/=]\s*([0-9]+(?:\.[0-9]+)?)`),
	}
	for _, pattern := range summaryPatterns {
		matches := pattern.FindStringSubmatch(output)
		if len(matches) >= 2 {
			if latency := roundPositiveLatency(matches[1]); latency > 0 {
				return latency
			}
		}
	}
	timePattern := regexp.MustCompile(`time[=<]\s*([0-9]+(?:\.[0-9]+)?)\s*ms`)
	timeMatches := timePattern.FindAllStringSubmatch(output, -1)
	if len(timeMatches) > 0 {
		total := 0
		count := 0
		for _, match := range timeMatches {
			if len(match) < 2 {
				continue
			}
			if latency := roundPositiveLatency(match[1]); latency > 0 {
				total += latency
				count++
			}
		}
		if count > 0 {
			return total / count
		}
	}
	patterns := []*regexp.Regexp{
		regexp.MustCompile(`(?i)time[=<]\s*([0-9]+(?:\.[0-9]+)?)\s*ms`),
	}
	for _, pattern := range patterns {
		matches := pattern.FindStringSubmatch(output)
		if len(matches) < 2 {
			continue
		}
		if latency := roundPositiveLatency(matches[1]); latency > 0 {
			return latency
		}
	}
	return 0
}

func roundPositiveLatency(value string) int {
	latencyValue, err := strconv.ParseFloat(value, 64)
	if err != nil || latencyValue <= 0 {
		return 0
	}
	latency := int(latencyValue + 0.5)
	if latency < 1 {
		latency = 1
	}
	return latency
}

func iptablesCounterSnapshot() map[string]trafficCounters {
	chainCounters := map[string]map[string]uint64{}
	parseIptablesCounterSnapshot("iptables", chainCounters)
	parseIptablesCounterSnapshot("ip6tables", chainCounters)

	out := map[string]trafficCounters{}
	for marker, byChain := range chainCounters {
		parts := strings.SplitN(marker, ":", 2)
		if len(parts) != 2 {
			continue
		}
		port, direction := parts[0], parts[1]
		maxBytes := uint64(0)
		for _, value := range byChain {
			if value > maxBytes {
				maxBytes = value
			}
		}
		counters := out[port]
		if direction == "in" {
			counters.In = maxBytes
		} else {
			counters.Out = maxBytes
		}
		out[port] = counters
	}
	return out
}

func parseIptablesCounterSnapshot(binary string, chainCounters map[string]map[string]uint64) {
	raw, err := exec.Command(binary, "-t", "mangle", "-nvxL").Output()
	if err != nil {
		return
	}
	markerPattern := regexp.MustCompile(`fwx-stat-([0-9]+):(in|out)`)
	currentChain := ""
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "Chain ") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				currentChain = fields[1]
			}
			continue
		}
		match := markerPattern.FindStringSubmatch(line)
		if len(match) < 3 || currentChain == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		bytesValue, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		marker := match[1] + ":" + match[2]
		if chainCounters[marker] == nil {
			chainCounters[marker] = map[string]uint64{}
		}
		chainCounters[marker][currentChain] += bytesValue
	}
}

func nftablesCounterSnapshot() map[int]trafficCounters {
	out := map[int]trafficCounters{}
	raw, err := exec.Command("nft", "-a", "list", "table", "inet", "forwardx").Output()
	if err != nil {
		return out
	}
	commentPattern := regexp.MustCompile(`fwx-rule-([0-9]+)(?::|-)(in|out)`)
	chainPattern := regexp.MustCompile(`^chain\s+(in|out)_([0-9]+)\s+\{`)
	currentLegacyDirection := ""
	currentLegacyRuleID := 0
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if match := chainPattern.FindStringSubmatch(line); len(match) >= 3 {
			currentLegacyDirection = match[1]
			currentLegacyRuleID, _ = strconv.Atoi(match[2])
			continue
		}
		if strings.HasPrefix(line, "chain ") {
			currentLegacyDirection = ""
			currentLegacyRuleID = 0
		}
		bytesValue, ok := nftCounterBytes(line)
		if !ok {
			continue
		}
		if match := commentPattern.FindStringSubmatch(line); len(match) >= 3 {
			ruleID, _ := strconv.Atoi(match[1])
			counters := out[ruleID]
			if match[2] == "in" {
				counters.In += bytesValue
			} else {
				counters.Out += bytesValue
			}
			out[ruleID] = counters
			continue
		}
		if currentLegacyRuleID > 0 && currentLegacyDirection != "" {
			counters := out[currentLegacyRuleID]
			if currentLegacyDirection == "in" {
				counters.In += bytesValue
			} else {
				counters.Out += bytesValue
			}
			out[currentLegacyRuleID] = counters
		}
	}
	return out
}

func nftCounterBytes(line string) (uint64, bool) {
	fields := strings.Fields(line)
	for i := 0; i+1 < len(fields); i++ {
		if fields[i] != "bytes" {
			continue
		}
		value, err := strconv.ParseUint(fields[i+1], 10, 64)
		if err == nil {
			return value, true
		}
	}
	return 0, false
}

func logTrafficCounterDiagnostic(state localRuleState, counters trafficCounters, din uint64, dout uint64, connections uint64, nftCounters map[int]trafficCounters) {
	if state.RuleID <= 0 || state.Port == "" {
		return
	}
	key := "traffic-diag:" + strconv.Itoa(state.RuleID) + ":" + state.Port
	if !shouldLogAgentReport(key, 5*time.Minute) {
		return
	}
	target := strings.Trim(strings.TrimSpace(state.TargetIP), "[]")
	targetIPv6 := strings.Contains(target, ":")
	iptablesMarker := iptablesMarkerSeen("iptables", state.Port)
	ip6tablesMarker := iptablesMarkerSeen("ip6tables", state.Port)
	nftMarker := false
	if state.ForwardType == "nftables" {
		nftMarker = nftRuleMarkerSeen(state.RuleID)
	}
	_, nftCounter := nftCounters[state.RuleID]
	if counters.In == 0 && counters.Out == 0 && connections > 0 {
		logf("traffic diag missing counters rule=%d port=%s type=%s target=%s:%d targetIPv6=%v counters=0/0 delta=%d/%d conns=%d iptablesMarker=%v ip6tablesMarker=%v nftMarker=%v nftCounter=%v hint=traffic-is-flowing-but-counter-rule-did-not-match", state.RuleID, state.Port, state.ForwardType, target, state.TargetPort, targetIPv6, din, dout, connections, iptablesMarker, ip6tablesMarker, nftMarker, nftCounter)
		return
	}
	if agentVerboseLogs && counters.In == 0 && counters.Out == 0 && connections == 0 {
		logf("traffic diag rule=%d port=%s type=%s target=%s:%d targetIPv6=%v counters=0/0 delta=0/0 conns=0 iptablesMarker=%v ip6tablesMarker=%v nftMarker=%v nftCounter=%v", state.RuleID, state.Port, state.ForwardType, target, state.TargetPort, targetIPv6, iptablesMarker, ip6tablesMarker, nftMarker, nftCounter)
		return
	}
	if agentVerboseLogs && (din > 0 || dout > 0 || connections > 0 || targetIPv6 || state.ForwardType == "nftables" || state.ForwardType == "iptables") {
		logf("traffic diag rule=%d port=%s type=%s target=%s:%d targetIPv6=%v counters=%d/%d delta=%d/%d conns=%d iptablesMarker=%v ip6tablesMarker=%v nftMarker=%v nftCounter=%v", state.RuleID, state.Port, state.ForwardType, target, state.TargetPort, targetIPv6, counters.In, counters.Out, din, dout, connections, iptablesMarker, ip6tablesMarker, nftMarker, nftCounter)
	}
}

func nftRuleMarkerSeen(ruleID int) bool {
	if ruleID <= 0 || !commandExists("nft") {
		return false
	}
	raw, err := exec.Command("nft", "-a", "list", "table", "inet", "forwardx").Output()
	if err != nil {
		return false
	}
	marker := "fwx-rule-" + strconv.Itoa(ruleID)
	return strings.Contains(string(raw), marker)
}

func iptablesMarkerSeen(binary string, port string) bool {
	if port == "" {
		return false
	}
	if binary == "ip6tables" && !commandExists("ip6tables") {
		return false
	}
	raw, err := exec.Command(binary, "-t", "mangle", "-S").Output()
	if err != nil {
		return false
	}
	marker := "fwx-stat-" + port + ":"
	return strings.Contains(string(raw), marker)
}

func conntrackConnectionsSnapshot(states []localRuleState) map[string]uint64 {
	out := map[string]uint64{}
	ports := map[string]bool{}
	for _, state := range states {
		if state.Port != "" {
			ports[state.Port] = true
		}
	}
	if len(ports) == 0 {
		return out
	}
	raw, err := os.ReadFile("/proc/net/nf_conntrack")
	if err != nil {
		raw, err = os.ReadFile("/proc/net/ip_conntrack")
		if err != nil {
			return out
		}
	}
	dportPattern := regexp.MustCompile(`\bdport=([0-9]+)\b`)
	for _, line := range strings.Split(string(raw), "\n") {
		if line == "" {
			continue
		}
		seen := map[string]bool{}
		for _, match := range dportPattern.FindAllStringSubmatch(line, -1) {
			if len(match) < 2 || !ports[match[1]] || seen[match[1]] {
				continue
			}
			out[match[1]]++
			seen[match[1]] = true
		}
	}
	return out
}

func conntrackConnections(port string) uint64 {
	cmd := fmt.Sprintf(`awk -v p="dport=%s" 'index($0,p" ")>0 {c++} END{print c+0}' /proc/net/nf_conntrack 2>/dev/null`, port)
	out, err := exec.Command("sh", "-lc", cmd).Output()
	if err != nil {
		return 0
	}
	v, _ := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
	return v
}

func iptablesBytes(port string, direction string) uint64 {
	counters := iptablesCounterSnapshot()[port]
	if direction == "out" {
		if counters.Out > 0 {
			return counters.Out
		}
	} else if counters.In > 0 {
		return counters.In
	}
	legacyChain := "FWX_IN_" + port
	if direction == "out" {
		legacyChain = "FWX_OUT_" + port
	}
	return iptablesLegacyBytes(legacyChain)
}

func iptablesLegacyBytes(chain string) uint64 {
	parentChains := []string{"PREROUTING", "INPUT", "FORWARD", "OUTPUT", "POSTROUTING"}
	byChain := map[string]uint64{}
	for _, binary := range []string{"iptables", "ip6tables"} {
		for _, parent := range parentChains {
			raw, err := exec.Command(binary, "-t", "mangle", "-nvxL", parent).Output()
			if err != nil {
				continue
			}
			for _, line := range strings.Split(string(raw), "\n") {
				if !strings.Contains(line, chain) {
					continue
				}
				fields := strings.Fields(line)
				if len(fields) < 2 {
					continue
				}
				value, err := strconv.ParseUint(fields[1], 10, 64)
				if err != nil {
					continue
				}
				byChain[parent] += value
			}
		}
	}
	maxBytes := uint64(0)
	for _, value := range byChain {
		if value > maxBytes {
			maxBytes = value
		}
	}
	return maxBytes
}

func nftablesBytes(ruleID int, port string) (uint64, uint64) {
	in := nftablesRuleBytes("traffic_forward", ruleID, "in")
	out := nftablesRuleBytes("traffic_forward", ruleID, "out")
	if in == 0 {
		in = nftablesRuleBytes("traffic_prerouting", ruleID, "in")
	}
	if out == 0 {
		out = nftablesRuleBytes("traffic_postrouting", ruleID, "out")
	}
	// Older generated nftables rules stored counters in per-rule chains.
	if in == 0 {
		in = nftablesChainBytes("in_" + strconv.Itoa(ruleID))
	}
	if out == 0 {
		out = nftablesChainBytes("out_" + strconv.Itoa(ruleID))
	}
	return in, out
}

func nftablesRuleBytes(chain string, ruleID int, direction string) uint64 {
	colonMarker := fmt.Sprintf("fwx-rule-%d:%s", ruleID, direction)
	dashMarker := fmt.Sprintf("fwx-rule-%d-%s", ruleID, direction)
	cmd := fmt.Sprintf(`nft -a list chain inet forwardx %s 2>/dev/null | awk -v colon=%s -v dash=%s '(index($0, colon) || index($0, dash)) && /counter packets/ {for(i=1;i<=NF;i++) if($i=="bytes") {s+=$(i+1)}} END{print s+0}'`, shellQuote(chain), shellQuote(colonMarker), shellQuote(dashMarker))
	out, err := exec.Command("sh", "-lc", cmd).Output()
	if err != nil {
		return 0
	}
	v, _ := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
	return v
}

func nftablesChainBytes(chain string) uint64 {
	cmd := fmt.Sprintf(`nft -a list chain inet forwardx %s 2>/dev/null | awk '/counter packets/ {for(i=1;i<=NF;i++) if($i=="bytes") {s+=$(i+1)}} END{print s+0}'`, shellQuote(chain))
	out, err := exec.Command("sh", "-lc", cmd).Output()
	if err != nil {
		return 0
	}
	v, _ := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
	return v
}

func readPrev(port string) (int, uint64, uint64, uint64) {
	raw, err := os.ReadFile("/var/lib/forwardx-agent/traffic_" + port + ".prev")
	if err != nil {
		return 0, 0, 0, 0
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) < 2 {
		return 0, 0, 0, 0
	}
	// 4-line format (current): ruleID, in, out, conns
	if len(lines) >= 4 {
		rid, _ := strconv.Atoi(strings.TrimSpace(lines[0]))
		prevIn, _ := strconv.ParseUint(strings.TrimSpace(lines[1]), 10, 64)
		prevOut, _ := strconv.ParseUint(strings.TrimSpace(lines[2]), 10, 64)
		prevConns, _ := strconv.ParseUint(strings.TrimSpace(lines[3]), 10, 64)
		return rid, prevIn, prevOut, prevConns
	}
	// 3-line legacy format: ruleID, in, out (no conns)
	if len(lines) >= 3 {
		rid, _ := strconv.Atoi(strings.TrimSpace(lines[0]))
		prevIn, _ := strconv.ParseUint(strings.TrimSpace(lines[1]), 10, 64)
		prevOut, _ := strconv.ParseUint(strings.TrimSpace(lines[2]), 10, 64)
		return rid, prevIn, prevOut, 0
	}
	// 2-line legacy format: in, out (no ruleID, no conns)
	prevIn, _ := strconv.ParseUint(strings.TrimSpace(lines[0]), 10, 64)
	prevOut, _ := strconv.ParseUint(strings.TrimSpace(lines[1]), 10, 64)
	return 0, prevIn, prevOut, 0
}

func writePrev(port string, ruleID int, in, out, conns uint64) {
	_ = os.WriteFile("/var/lib/forwardx-agent/traffic_"+port+".prev", []byte(fmt.Sprintf("%d\n%d\n%d\n%d\n", ruleID, in, out, conns)), 0644)
}

func delta(cur, prev uint64) uint64 {
	if cur >= prev {
		return cur - prev
	}
	return cur
}
