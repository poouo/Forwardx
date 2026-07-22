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
	agentStateDir              = "/var/lib/forwardx-agent"
	tcpingRuleBatchSize        = 24
	tcpingProbeBatchSize       = 12
	tcpingMaxConcurrency       = 32
	tcpingProbeTimeout         = 2 * time.Second
	tcpingWireGuardTimeout     = 8 * time.Second
	tcpingPingProbeCount       = 5
	systemPingConcurrency      = 8
	networkTargetDNSTTL        = 30 * time.Second
	networkTargetDNSFailureTTL = 5 * time.Second
	idleHostTrafficReportEvery = 30 * time.Second
)

var (
	tcpingCursorMu           sync.Mutex
	tcpingRuleCursor         int
	tcpingTunnelCursor       int
	tcpingForwardGroupCursor int
	tcpingServiceCursor      int
	tcpingCollectRunning     int32
	systemPingSlots          = make(chan struct{}, systemPingConcurrency)
	networkTargetDNSMu       sync.Mutex
	networkTargetDNSCache    = map[string]networkTargetDNSCacheEntry{}
	networkTargetDNSCalls    = map[string]*networkTargetDNSCall{}
	lookupNetworkTargetIPs   = net.DefaultResolver.LookupIPAddr
	dialNetworkTimeout       = net.DialTimeout
	trafficPrevMu            sync.Mutex
	trafficPrevCache         = map[string]trafficPrevState{}
	trafficStateDir          = agentStateDir
	lastHostTrafficReportAt  time.Time
)

type networkTargetDNSCacheEntry struct {
	addresses []string
	expiresAt time.Time
}

type networkTargetDNSCall struct {
	done      chan struct{}
	addresses []string
}

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

type trafficDiagnosticsSnapshot struct {
	iptablesMarkers  map[string]bool
	ip6tablesMarkers map[string]bool
	nftMarkers       map[int]bool
}

type trafficPrevState struct {
	ruleID int
	in     uint64
	out    uint64
	conns  uint64
}

type trafficBaselineUpdate struct {
	port  string
	state trafficPrevState
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

func shouldIncludeHostTraffic(statCount int, now time.Time) bool {
	return statCount > 0 || lastHostTrafficReportAt.IsZero() || now.Sub(lastHostTrafficReportAt) >= idleHostTrafficReportEvery
}

func scheduleTrafficCollection(cfg Config) bool {
	now := time.Now()
	trafficCollectMu.Lock()
	if trafficCollectRunning || (!lastTrafficCollectAt.IsZero() && now.Sub(lastTrafficCollectAt) < nextTrafficCollectInterval) {
		trafficCollectMu.Unlock()
		return false
	}
	if atomic.LoadInt64(&actionPendingCount) > 0 {
		trafficCollectMu.Unlock()
		return false
	}
	trafficCollectRunning = true
	lastTrafficCollectAt = now
	trafficCollectMu.Unlock()
	go func() {
		next := collectTraffic(cfg)
		trafficCollectMu.Lock()
		nextTrafficCollectInterval = next
		lastTrafficCollectAt = time.Now()
		trafficCollectRunning = false
		trafficCollectMu.Unlock()
	}()
	return true
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
	iptablesCounters, diagnostics := iptablesCounterSnapshotWithDiagnostics()
	nftCounters, nftMarkers := nftablesCounterSnapshotWithDiagnostics()
	diagnostics.nftMarkers = nftMarkers
	connCounts := conntrackConnectionsSnapshot(states)
	stats := []map[string]any{}
	pendingBaselines := make([]trafficBaselineUpdate, 0, len(states))
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
		initialBaseline := prevRuleID <= 0 || prevRuleID != state.RuleID
		if initialBaseline {
			prevIn, prevOut = counters.In, counters.Out
			prevConns = curConns
		}
		din, dout, dconns := delta(counters.In, prevIn), delta(counters.Out, prevOut), delta(curConns, prevConns)
		nextBaseline := trafficPrevState{ruleID: state.RuleID, in: counters.In, out: counters.Out, conns: curConns}
		if din > 0 || dout > 0 || dconns > 0 {
			stats = append(stats, map[string]any{"ruleId": state.RuleID, "bytesIn": din, "bytesOut": dout, "connections": dconns})
			pendingBaselines = append(pendingBaselines, trafficBaselineUpdate{port: state.Port, state: nextBaseline})
		} else {
			writePrevState(state.Port, nextBaseline)
		}
		logTrafficCounterDiagnostic(state, counters, din, dout, curConns, nftCounters, diagnostics)
	}
	var hostTraffic map[string]any
	if shouldIncludeHostTraffic(len(stats), time.Now()) {
		hostTraffic = hostTrafficSnapshot()
	}
	payload := map[string]any{"stats": stats}
	if hostTraffic != nil {
		payload["hostTraffic"] = hostTraffic
	}
	if compactAgentReports.Load() {
		compactStats := make([][]any, 0, len(stats))
		for _, stat := range stats {
			compactStats = append(compactStats, compactTrafficStat(stat))
		}
		payload = map[string]any{"s": compactStats}
		if hostTraffic != nil {
			payload["h"] = []any{hostTraffic["bytesIn"], hostTraffic["bytesOut"]}
		}
	}
	if len(stats) > 0 || hostTraffic != nil {
		if err := post(cfg, "/api/agent/traffic", payload, &map[string]any{}); err != nil {
			if isTransientAgentCommError(err) {
				logAgentCommError("traffic-report", err)
			} else if shouldLogAgentReport("traffic-report-failed", agentReportLogInterval) {
				logf("traffic report failed watched=%d stats=%d: %v", watched, len(stats), err)
			}
		} else {
			commitTrafficBaselines(true, pendingBaselines)
			if hostTraffic != nil {
				lastHostTrafficReportAt = time.Now()
			}
			if agentVerboseLogs && len(stats) > 0 && shouldLogAgentReport("traffic-report-ok", 5*time.Minute) {
				logf("traffic report ok watched=%d stats=%d", watched, len(stats))
			}
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

func collectTCPing(cfg Config, ruleProbes []ruleLatencyProbe, probes []tunnelProbe, groupProbes []forwardGroupProbe, serviceProbes []hostProbeServiceProbe, force bool) {
	ruleTasks := []tcpingTask{}
	for _, state := range readLocalRuleStates() {
		if task, ok := buildRuleLatencyProbeTask(state); ok {
			ruleTasks = append(ruleTasks, task)
		}
	}
	for _, probe := range ruleProbes {
		if task, ok := buildExplicitRuleLatencyProbeTask(probe); ok {
			ruleTasks = append(ruleTasks, task)
		}
	}

	tunnelTasks := buildTunnelProbeTasks(probes)

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

func buildTunnelProbeTasks(probes []tunnelProbe) []tcpingTask {
	tasks := make([]tcpingTask, 0, len(probes))
	for _, probe := range probes {
		if probe.TunnelID <= 0 || strings.TrimSpace(probe.TargetIP) == "" || probe.TargetPort <= 0 {
			continue
		}
		tasks = append(tasks, tcpingTask{
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
	return tasks
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
	// Tunnel rules are measured from an explicit exit-host probe supplied by
	// the panel. Probing their final target from an entry or relay host bypasses
	// the tunnel and produces unrelated latency or false timeouts.
	if state.TunnelID > 0 {
		return tcpingTask{}, false
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

func buildExplicitRuleLatencyProbeTask(probe ruleLatencyProbe) (tcpingTask, bool) {
	method := strings.ToLower(strings.TrimSpace(probe.Method))
	if method != "ping" {
		method = "tcping"
	}
	if probe.RuleID <= 0 || probe.TunnelID <= 0 || strings.TrimSpace(probe.TargetIP) == "" || probe.TargetPort <= 0 {
		return tcpingTask{}, false
	}
	probeKey := strings.TrimSpace(probe.ProbeKey)
	if probeKey == "" {
		probeKey = fmt.Sprintf("rule:%d:tunnel:%d:%s:%d:%s", probe.RuleID, probe.TunnelID, strings.ToLower(strings.TrimSpace(probe.TargetIP)), probe.TargetPort, method)
	}
	return tcpingTask{
		Kind:        "rule",
		RuleID:      probe.RuleID,
		TunnelID:    probe.TunnelID,
		Method:      method,
		TargetIP:    probe.TargetIP,
		TargetPort:  probe.TargetPort,
		ProbeKey:    probeKey,
		TopologyKey: strings.TrimSpace(probe.TopologyKey),
	}, true
}

func scheduleTCPingCollection(cfg Config, ruleProbes []ruleLatencyProbe, probes []tunnelProbe, groupProbes []forwardGroupProbe, serviceProbes []hostProbeServiceProbe, force bool) bool {
	if atomic.LoadInt64(&actionPendingCount) > 0 && (len(ruleProbes) > 0 || len(probes) > 0 || len(groupProbes) > 0) {
		logVerbosef("tcping collect deferred while runtime actions are pending=%d", atomic.LoadInt64(&actionPendingCount))
		return false
	}
	if !atomic.CompareAndSwapInt32(&tcpingCollectRunning, 0, 1) {
		logVerbosef("tcping collect skip because previous run is still active")
		return false
	}
	ruleProbesCopy := append([]ruleLatencyProbe(nil), ruleProbes...)
	probesCopy := append([]tunnelProbe(nil), probes...)
	groupProbesCopy := append([]forwardGroupProbe(nil), groupProbes...)
	serviceProbesCopy := append([]hostProbeServiceProbe(nil), serviceProbes...)
	go func() {
		started := time.Now()
		defer atomic.StoreInt32(&tcpingCollectRunning, 0)
		collectTCPing(cfg, ruleProbesCopy, probesCopy, groupProbesCopy, serviceProbesCopy, force)
		if elapsed := time.Since(started); elapsed >= 5*time.Second && shouldLogAgentReport("tcping-collect-slow-async", 5*time.Minute) {
			logf("tcping collect slow duration=%s ruleProbes=%d tunnels=%d groups=%d services=%d force=%v", elapsed.Round(time.Millisecond), len(ruleProbesCopy), len(probesCopy), len(groupProbesCopy), len(serviceProbesCopy), force)
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
		if desired, ok := desiredRunningRuleForStatePort(ruleID, parseStatePort(port)); ok {
			states = append(states, localRuleState{
				Port:        port,
				RuleID:      ruleID,
				TunnelID:    desired.TunnelID,
				ForwardType: desired.ForwardType,
				TargetIP:    desired.TargetIP,
				TargetPort:  desired.TargetPort,
				Protocol:    desired.Protocol,
			})
			continue
		}
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
	workerCount := tcpingTaskConcurrency(len(tasks))
	out := make(chan tcpingTaskResult, len(tasks))
	jobs := make(chan tcpingTask, workerCount)
	var wg sync.WaitGroup
	for worker := 0; worker < workerCount; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for task := range jobs {
				out <- executeTCPingTask(task)
			}
		}()
	}
	for _, task := range tasks {
		jobs <- task
	}
	close(jobs)
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

func tcpingTaskConcurrency(taskCount int) int {
	if taskCount <= 0 {
		return 0
	}
	limit := runtime.NumCPU() * 8
	if limit < 16 {
		limit = 16
	}
	if limit > tcpingMaxConcurrency {
		limit = tcpingMaxConcurrency
	}
	if atomic.LoadInt64(&actionPendingCount) > 0 && limit > 4 {
		limit = 4
	}
	if limit > taskCount {
		limit = taskCount
	}
	return limit
}

func executeTCPingTask(task tcpingTask) tcpingTaskResult {
	var latency int
	var reachable bool
	if (task.Kind == "rule" || task.Kind == "forwardGroup" || task.Kind == "service") && task.Method == "ping" {
		latency, reachable, _ = pingLatencyWithCount(task.TargetIP, tcpingProbeTimeout, tcpingPingProbeCount)
	} else if task.Kind == "tunnel" && task.WireGuardPeerID != "" {
		latency, reachable = wireGuardTCPLatency(task.TunnelID, task.WireGuardPeerID, task.TargetPort, tcpingWireGuardTimeout)
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
	deadline := time.Now().Add(timeout)
	targets := []string{target}
	if net.ParseIP(target) == nil {
		resolved := resolveNetworkTargetIPs(target, time.Until(deadline))
		if len(resolved) == 0 {
			return 0, false, ""
		}
		targets = resolved
	}
	for _, dialHost := range targets {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		start := time.Now()
		conn, err := dialNetworkTimeout("tcp", net.JoinHostPort(dialHost, strconv.Itoa(port)), remaining)
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
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	now := time.Now()
	networkTargetDNSMu.Lock()
	if cached, ok := networkTargetDNSCache[host]; ok && now.Before(cached.expiresAt) {
		addresses := append([]string(nil), cached.addresses...)
		networkTargetDNSMu.Unlock()
		return addresses
	}
	if call := networkTargetDNSCalls[host]; call != nil {
		done := call.done
		networkTargetDNSMu.Unlock()
		select {
		case <-done:
			return append([]string(nil), call.addresses...)
		case <-ctx.Done():
			return nil
		}
	}
	call := &networkTargetDNSCall{done: make(chan struct{})}
	networkTargetDNSCalls[host] = call
	networkTargetDNSMu.Unlock()

	addrs, err := lookupNetworkTargetIPs(ctx, host)
	if err != nil {
		addrs = nil
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
	ttl := networkTargetDNSTTL
	if len(targets) == 0 {
		ttl = networkTargetDNSFailureTTL
	}
	networkTargetDNSMu.Lock()
	call.addresses = append([]string(nil), targets...)
	networkTargetDNSCache[host] = networkTargetDNSCacheEntry{
		addresses: append([]string(nil), targets...),
		expiresAt: time.Now().Add(ttl),
	}
	delete(networkTargetDNSCalls, host)
	close(call.done)
	networkTargetDNSMu.Unlock()
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
	select {
	case systemPingSlots <- struct{}{}:
		defer func() { <-systemPingSlots }()
	case <-ctx.Done():
		return 0, false, "system ping queue timeout"
	}
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
	counters, _ := iptablesCounterSnapshotWithDiagnostics()
	return counters
}

func iptablesCounterSnapshotWithDiagnostics() (map[string]trafficCounters, trafficDiagnosticsSnapshot) {
	chainCounters := map[string]map[string]uint64{}
	diagnostics := trafficDiagnosticsSnapshot{
		iptablesMarkers:  map[string]bool{},
		ip6tablesMarkers: map[string]bool{},
		nftMarkers:       map[int]bool{},
	}
	parseIptablesCounterSnapshot("iptables", chainCounters, diagnostics.iptablesMarkers)
	parseIptablesCounterSnapshot("ip6tables", chainCounters, diagnostics.ip6tablesMarkers)

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
	return out, diagnostics
}

func parseIptablesCounterSnapshot(binary string, chainCounters map[string]map[string]uint64, markers map[string]bool) {
	raw, err := commandOutputWithTimeout(5*time.Second, binary, "-t", "mangle", "-nvxL")
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
		markers[match[1]] = true
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
	counters, _ := nftablesCounterSnapshotWithDiagnostics()
	return counters
}

func nftablesCounterSnapshotWithDiagnostics() (map[int]trafficCounters, map[int]bool) {
	out := map[int]trafficCounters{}
	markers := map[int]bool{}
	raw, err := commandOutputWithTimeout(5*time.Second, "nft", "-a", "list", "table", "inet", "forwardx")
	if err != nil {
		return out, markers
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
			if currentLegacyRuleID > 0 {
				markers[currentLegacyRuleID] = true
			}
			continue
		}
		if strings.HasPrefix(line, "chain ") {
			currentLegacyDirection = ""
			currentLegacyRuleID = 0
		}
		commentMatch := commentPattern.FindStringSubmatch(line)
		if len(commentMatch) >= 3 {
			ruleID, _ := strconv.Atoi(commentMatch[1])
			if ruleID > 0 {
				markers[ruleID] = true
			}
		}
		bytesValue, ok := nftCounterBytes(line)
		if !ok {
			continue
		}
		if len(commentMatch) >= 3 {
			ruleID, _ := strconv.Atoi(commentMatch[1])
			counters := out[ruleID]
			if commentMatch[2] == "in" {
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
	return out, markers
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

func logTrafficCounterDiagnostic(state localRuleState, counters trafficCounters, din uint64, dout uint64, connections uint64, nftCounters map[int]trafficCounters, diagnostics trafficDiagnosticsSnapshot) {
	if state.RuleID <= 0 || state.Port == "" {
		return
	}
	key := "traffic-diag:" + strconv.Itoa(state.RuleID) + ":" + state.Port
	if !shouldLogAgentReport(key, 5*time.Minute) {
		return
	}
	target := strings.Trim(strings.TrimSpace(state.TargetIP), "[]")
	targetIPv6 := strings.Contains(target, ":")
	iptablesMarker := diagnostics.iptablesMarkers[state.Port]
	ip6tablesMarker := diagnostics.ip6tablesMarkers[state.Port]
	nftMarker := false
	if state.ForwardType == "nftables" {
		nftMarker = diagnostics.nftMarkers[state.RuleID]
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
	out, err := commandOutputWithTimeout(5*time.Second, "sh", "-lc", cmd)
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
			raw, err := commandOutputWithTimeout(5*time.Second, binary, "-t", "mangle", "-nvxL", parent)
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
	out, err := commandOutputWithTimeout(5*time.Second, "sh", "-lc", cmd)
	if err != nil {
		return 0
	}
	v, _ := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
	return v
}

func nftablesChainBytes(chain string) uint64 {
	cmd := fmt.Sprintf(`nft -a list chain inet forwardx %s 2>/dev/null | awk '/counter packets/ {for(i=1;i<=NF;i++) if($i=="bytes") {s+=$(i+1)}} END{print s+0}'`, shellQuote(chain))
	out, err := commandOutputWithTimeout(5*time.Second, "sh", "-lc", cmd)
	if err != nil {
		return 0
	}
	v, _ := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
	return v
}

func readPrev(port string) (int, uint64, uint64, uint64) {
	trafficPrevMu.Lock()
	if cached, ok := trafficPrevCache[port]; ok {
		trafficPrevMu.Unlock()
		return cached.ruleID, cached.in, cached.out, cached.conns
	}
	trafficPrevMu.Unlock()
	raw, err := os.ReadFile(trafficStateDir + "/traffic_" + port + ".prev")
	if err != nil {
		cacheTrafficPrev(port, trafficPrevState{})
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
		cacheTrafficPrev(port, trafficPrevState{ruleID: rid, in: prevIn, out: prevOut, conns: prevConns})
		return rid, prevIn, prevOut, prevConns
	}
	// 3-line legacy format: ruleID, in, out (no conns)
	if len(lines) >= 3 {
		rid, _ := strconv.Atoi(strings.TrimSpace(lines[0]))
		prevIn, _ := strconv.ParseUint(strings.TrimSpace(lines[1]), 10, 64)
		prevOut, _ := strconv.ParseUint(strings.TrimSpace(lines[2]), 10, 64)
		cacheTrafficPrev(port, trafficPrevState{ruleID: rid, in: prevIn, out: prevOut})
		return rid, prevIn, prevOut, 0
	}
	// 2-line legacy format: in, out (no ruleID, no conns)
	prevIn, _ := strconv.ParseUint(strings.TrimSpace(lines[0]), 10, 64)
	prevOut, _ := strconv.ParseUint(strings.TrimSpace(lines[1]), 10, 64)
	cacheTrafficPrev(port, trafficPrevState{in: prevIn, out: prevOut})
	return 0, prevIn, prevOut, 0
}

func writePrev(port string, ruleID int, in, out, conns uint64) {
	writePrevState(port, trafficPrevState{ruleID: ruleID, in: in, out: out, conns: conns})
}

func writePrevState(port string, next trafficPrevState) {
	trafficPrevMu.Lock()
	previous, exists := trafficPrevCache[port]
	trafficPrevCache[port] = next
	trafficPrevMu.Unlock()
	if exists && previous == next {
		return
	}
	_ = os.WriteFile(trafficStateDir+"/traffic_"+port+".prev", []byte(fmt.Sprintf("%d\n%d\n%d\n%d\n", next.ruleID, next.in, next.out, next.conns)), 0644)
}

func commitTrafficBaselines(reportSucceeded bool, updates []trafficBaselineUpdate) {
	if !reportSucceeded {
		return
	}
	for _, update := range updates {
		writePrevState(update.port, update.state)
	}
}

func cacheTrafficPrev(port string, state trafficPrevState) {
	trafficPrevMu.Lock()
	trafficPrevCache[port] = state
	trafficPrevMu.Unlock()
}

func invalidateTrafficPrev(port string) {
	trafficPrevMu.Lock()
	delete(trafficPrevCache, port)
	trafficPrevMu.Unlock()
}

func delta(cur, prev uint64) uint64 {
	if cur >= prev {
		return cur - prev
	}
	return cur
}
