package main

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	agentStateDir        = "/var/lib/forwardx-agent"
	tcpingRuleBatchSize  = 24
	tcpingProbeBatchSize = 12
	tcpingMaxConcurrency = 8
	tcpingProbeTimeout   = 2 * time.Second
	tcpingPingProbeCount = 5
)

var (
	tcpingCursorMu           sync.Mutex
	tcpingRuleCursor         int
	tcpingTunnelCursor       int
	tcpingForwardGroupCursor int
	tcpingServiceCursor      int
)

type localRuleState struct {
	Port        string
	RuleID      int
	ForwardType string
	TargetIP    string
	TargetPort  int
}

type trafficCounters struct {
	In  uint64
	Out uint64
}

type tcpingTask struct {
	Kind        string
	RuleID      int
	TunnelID    int
	GroupID     int
	MemberID    int
	ProbeType   string
	ServiceID   int
	Method      string
	TargetIP    string
	TargetPort  int
	HopIndex    int
	HopCount    int
	SeriesKey   string
	SeriesLabel string
}

type tcpingTaskResult struct {
	Kind    string
	Payload map[string]any
}

func hostTrafficSnapshot() map[string]any {
	return map[string]any{
		"bytesIn":  netBytes(0),
		"bytesOut": netBytes(1),
	}
}
func collectTraffic(cfg Config) {
	states := readLocalRuleStates()
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
			if nft := nftCounters[state.RuleID]; nft.In > 0 || nft.Out > 0 {
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
	}
	hostTraffic := hostTrafficSnapshot()
	payload := map[string]any{"stats": stats, "hostTraffic": hostTraffic}
	if len(stats) > 0 || hostTraffic != nil {
		if err := post(cfg, "/api/agent/traffic", payload, &map[string]any{}); err != nil && shouldLogAgentReport("traffic-report-failed", agentReportLogInterval) {
			logf("traffic report failed watched=%d stats=%d: %v", watched, len(stats), err)
		}
	}
}

func collectTCPing(cfg Config, probes []tunnelProbe, groupProbes []forwardGroupProbe, serviceProbes []hostProbeServiceProbe, force bool) {
	ruleTasks := []tcpingTask{}
	for _, state := range readLocalRuleStates() {
		if state.RuleID <= 0 || state.TargetIP == "" || state.TargetPort <= 0 {
			continue
		}
		ruleTasks = append(ruleTasks, tcpingTask{
			Kind:       "rule",
			RuleID:     state.RuleID,
			TargetIP:   state.TargetIP,
			TargetPort: state.TargetPort,
		})
	}

	tunnelTasks := []tcpingTask{}
	for _, probe := range probes {
		if probe.TunnelID <= 0 || probe.TargetIP == "" || probe.TargetPort <= 0 {
			continue
		}
		tunnelTasks = append(tunnelTasks, tcpingTask{
			Kind:        "tunnel",
			TunnelID:    probe.TunnelID,
			TargetIP:    probe.TargetIP,
			TargetPort:  probe.TargetPort,
			HopIndex:    probe.HopIndex,
			HopCount:    probe.HopCount,
			SeriesKey:   probe.SeriesKey,
			SeriesLabel: probe.SeriesLabel,
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
			Kind:       "forwardGroup",
			GroupID:    probe.GroupID,
			MemberID:   probe.MemberID,
			ProbeType:  probe.ProbeType,
			Method:     method,
			TargetIP:   probe.TargetIP,
			TargetPort: probe.TargetPort,
			HopIndex:   probe.HopIndex,
			HopCount:   probe.HopCount,
		})
	}

	ruleLimit := tcpingRuleBatchSize
	probeLimit := tcpingProbeBatchSize
	if force {
		ruleLimit *= 2
		probeLimit *= 2
	}
	tunnelProbeLimit := probeLimit
	if len(tunnelTasks) > tunnelProbeLimit {
		tunnelProbeLimit = len(tunnelTasks)
	}
	tcpingCursorMu.Lock()
	selected := []tcpingTask{}
	selected = append(selected, rotateTCPingTasks(ruleTasks, &tcpingRuleCursor, ruleLimit)...)
	selected = append(selected, rotateTCPingTasks(tunnelTasks, &tcpingTunnelCursor, tunnelProbeLimit)...)
	selected = append(selected, rotateTCPingTasks(forwardGroupTasks, &tcpingForwardGroupCursor, probeLimit)...)
	selected = append(selected, rotateTCPingTasks(serviceTasks, &tcpingServiceCursor, probeLimit)...)
	tcpingCursorMu.Unlock()
	if len(selected) == 0 {
		return
	}

	results, tunnels, forwardGroups, services := runTCPingTasks(selected)
	if len(results) > 0 || len(tunnels) > 0 || len(forwardGroups) > 0 || len(services) > 0 {
		payload := map[string]any{"results": results, "tunnels": tunnels, "forwardGroups": forwardGroups, "services": services}
		if err := post(cfg, "/api/agent/tcping", payload, &map[string]any{}); err != nil {
			if shouldLogAgentReport("tcping-report-failed", agentReportLogInterval) {
				logf("tcping report failed rules=%d tunnels=%d groups=%d services=%d: %v", len(results), len(tunnels), len(forwardGroups), len(services), err)
			}
		} else if len(tunnels) > 0 || len(forwardGroups) > 0 || len(services) > 0 {
			total, timeouts, avgLatency := summarizeTCPingReport(results, tunnels, forwardGroups, services)
			if shouldLogAgentReport("tcping-report-ok", agentReportLogInterval) {
				logf("tcping report ok rules=%d tunnels=%d groups=%d services=%d timeouts=%d/%d avg=%s", len(results), len(tunnels), len(forwardGroups), len(services), timeouts, total, avgLatency)
			}
		}
	}
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
		targetIP, targetPort, _ := readTargetInfo(port)
		states = append(states, localRuleState{
			Port:        port,
			RuleID:      ruleID,
			ForwardType: readForwardTypeByPort(port),
			TargetIP:    targetIP,
			TargetPort:  targetPort,
		})
	}
	return states
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
	if (task.Kind == "forwardGroup" || task.Kind == "service") && task.Method == "ping" {
		latency, reachable, _ = pingLatencyWithCount(task.TargetIP, tcpingProbeTimeout, tcpingPingProbeCount)
	} else {
		latency, reachable = tcpLatency(task.TargetIP, task.TargetPort, tcpingProbeTimeout)
	}
	payload := map[string]any{}
	switch task.Kind {
	case "rule":
		payload["ruleId"] = task.RuleID
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
	if reachable {
		payload["latencyMs"] = latency
		payload["isTimeout"] = false
	} else {
		payload["latencyMs"] = 0
		payload["isTimeout"] = true
	}
	return tcpingTaskResult{Kind: task.Kind, Payload: payload}
}

func readTargetInfo(port string) (string, int, bool) {
	b, err := os.ReadFile("/var/lib/forwardx-agent/target_" + port + ".info")
	if err != nil {
		return "", 0, false
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) < 2 {
		return "", 0, false
	}
	targetIP := strings.TrimSpace(lines[0])
	targetPort, _ := strconv.Atoi(strings.TrimSpace(lines[1]))
	return targetIP, targetPort, targetIP != "" && targetPort > 0
}

func tcpLatency(ip string, port int, timeout time.Duration) (int, bool) {
	start := time.Now()
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(ip, strconv.Itoa(port)), timeout)
	if err != nil {
		return 0, false
	}
	_ = conn.Close()
	latency := int(time.Since(start).Milliseconds())
	if latency < 1 {
		latency = 1
	}
	return latency, true
}

func pingLatency(host string, timeout time.Duration) (int, bool, string) {
	return pingLatencyWithCount(host, timeout, 1)
}

func pingLatencyWithCount(host string, timeout time.Duration, count int) (int, bool, string) {
	target := strings.TrimSpace(host)
	if target == "" {
		return 0, false, "目标为空"
	}
	if count < 1 {
		count = 1
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
	args := []string{"-c", strconv.Itoa(count), "-W", strconv.Itoa(timeoutSeconds), target}
	if runtime.GOOS == "windows" {
		args = []string{"-n", strconv.Itoa(count), "-w", strconv.Itoa(int(timeout.Milliseconds())), target}
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
	commentPattern := regexp.MustCompile(`fwx-rule-([0-9]+):(in|out)`)
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
	in := nftablesRuleBytes("traffic_prerouting", ruleID, "in")
	out := nftablesRuleBytes("traffic_postrouting", ruleID, "out")
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
	marker := fmt.Sprintf("fwx-rule-%d:%s", ruleID, direction)
	cmd := fmt.Sprintf(`nft -a list chain inet forwardx %s 2>/dev/null | awk -v marker=%s '$0 ~ marker && /counter packets/ {for(i=1;i<=NF;i++) if($i=="bytes") {s+=$(i+1)}} END{print s+0}'`, shellQuote(chain), shellQuote(marker))
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
