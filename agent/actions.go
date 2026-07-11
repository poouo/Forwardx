package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const desiredActionFailureRetryInterval = 30 * time.Second
const desiredRuntimeReadyCacheTTL = 2 * time.Second

type desiredRuntimeReadyCacheEntry struct {
	value     bool
	checkedAt time.Time
}

var desiredRuntimeReadyMu sync.Mutex
var desiredNginxRuntimeReadyCache = map[string]desiredRuntimeReadyCacheEntry{}
var desiredGostRuntimeReadyCache = map[string]desiredRuntimeReadyCacheEntry{}
var actionSerialMu sync.Mutex
var actionSerialLocks = map[string]*actionSerialLock{}
var desiredActionRecordMu sync.Mutex
var sharedRuntimeSyncGate sync.RWMutex

type actionSerialLock struct {
	mu   sync.Mutex
	refs int
}

func reserveQueuedAction(a action) bool {
	if key := actionQueueKey(a); key != "" && a.IssuedAt > 0 {
		queuedActionMu.Lock()
		existing := queuedActionKeys[key]
		if existing == a.IssuedAt {
			queuedActionMu.Unlock()
			logActionDuplicateSkip(a, key)
			return false
		}
		queuedActionKeys[key] = a.IssuedAt
		queuedActionMu.Unlock()
	}
	return true
}

func enqueueAction(cfg Config, a action) <-chan struct{} {
	done := make(chan struct{})
	if isOlderAction(a, true) {
		close(done)
		return done
	}
	if !reserveQueuedAction(a) {
		close(done)
		return done
	}
	atomic.AddInt64(&actionPendingCount, 1)
	enqueueActionJob(actionJob{cfg: cfg, action: a, done: done})
	return done
}

func desiredStateActions(state *desiredState) []action {
	if state == nil {
		return nil
	}
	return state.Actions
}

func syncDesiredState(cfg Config, state *desiredState) []<-chan struct{} {
	if state == nil {
		return nil
	}
	kernelSnapshot := newKernelForwardSnapshot()
	// Pre-populate the per-port readiness cache once for all gost/nginx actions in this
	// batch. Without this, canAdoptDesiredAction → desiredGostRuntimeReady calls
	// readLocalRuntimeReadiness() once per unique (port, protocol) pair — O(N) expensive
	// syscalls (ss -H -ltnup + systemctl + config parse) for N rules on first restart.
	primeDesiredRuntimeReadyCacheForActions(state.Actions)
	desiredActionRecordMu.Lock()
	records := readDesiredActionRecordsLocked()
	done := make([]<-chan struct{}, 0, len(state.Actions))
	seen := map[string]bool{}
	pendingJobs := make([]actionJob, 0, len(state.Actions))
	adoptedStatusReports := make([]action, 0)
	for _, a := range state.Actions {
		if a.IssuedAt <= 0 {
			a.IssuedAt = state.IssuedAt
		}
		key := desiredActionKey(a)
		if key == "" {
			doneCh := make(chan struct{})
			pendingJobs = append(pendingJobs, actionJob{cfg: cfg, action: a, done: doneCh})
			done = append(done, doneCh)
			continue
		}
		signature := desiredActionSignature(a)
		seen[key] = true
		if record, ok := records[key]; ok && record.Signature == signature {
			if record.Success {
				if desiredActionRecordConsistent(a, kernelSnapshot) {
					continue
				}
				delete(records, key)
				if shouldLogAgentReport("desired-state-drift:"+key, agentReportLogInterval) {
					logf("desired state drift detected; reapply queued key=%s %s", key, actionLogSummary(a))
				}
			} else if time.Since(time.Unix(record.UpdatedAt, 0)) < desiredActionFailureRetryInterval {
				continue
			}
		}
		if canAdoptDesiredAction(a) {
			records[key] = desiredActionRecord{Signature: signature, Success: true, UpdatedAt: time.Now().Unix()}
			if shouldReportDesiredAdoptionStatus(a) {
				writeState(a)
				adoptedStatusReports = append(adoptedStatusReports, a)
			}
			continue
		}
		doneCh := make(chan struct{})
		if isOlderAction(a, true) {
			close(doneCh)
			continue
		}
		if !reserveQueuedAction(a) {
			close(doneCh)
			continue
		}
		pendingJobs = append(pendingJobs, actionJob{
			cfg:              cfg,
			action:           a,
			done:             doneCh,
			desiredKey:       key,
			desiredSignature: signature,
		})
		done = append(done, doneCh)
	}
	for key := range records {
		if !seen[key] {
			delete(records, key)
		}
	}
	writeDesiredActionRecordsLocked(records)
	desiredActionRecordMu.Unlock()
	if len(adoptedStatusReports) > 0 {
		go reportAdoptedDesiredActions(cfg, adoptedStatusReports)
	}
	for _, job := range pendingJobs {
		if isOlderAction(job.action, true) {
			if job.done != nil {
				close(job.done)
			}
			continue
		}
		if job.desiredKey == "" {
			if !reserveQueuedAction(job.action) {
				if job.done != nil {
					close(job.done)
				}
				continue
			}
		}
		atomic.AddInt64(&actionPendingCount, 1)
		enqueueActionJob(job)
	}
	return done
}

func desiredActionRecordConsistent(a action, kernelSnapshot *kernelForwardSnapshot) bool {
	if actionRequiresKernelForwardConsistency(a) {
		if kernelSnapshot == nil {
			kernelSnapshot = newKernelForwardSnapshot()
		}
		return kernelSnapshot.desiredActionConsistent(a)
	}
	if strings.TrimSpace(a.StatusType) == "runtime" {
		return true
	}
	if strings.TrimSpace(a.Op) == "apply" {
		return canAdoptDesiredAction(a)
	}
	return true
}

func reportAdoptedDesiredActions(cfg Config, actions []action) {
	for _, a := range actions {
		reportActionStatus(cfg, a, true, "local runtime already matches desired state")
	}
}

func shouldReportDesiredAdoptionStatus(a action) bool {
	return strings.TrimSpace(a.StatusType) != "runtime" && shouldReportActionStatus(a)
}

func desiredActionKey(a action) string {
	statusType := strings.TrimSpace(a.StatusType)
	if statusType == "" {
		if a.RuleID > 0 {
			statusType = "rule"
		} else if a.TunnelID > 0 {
			statusType = "tunnel"
		}
	}
	if statusType == "runtime" {
		name := strings.TrimSpace(a.ForwardType)
		if name == "" {
			name = "runtime"
		}
		return "runtime:" + name
	}
	if statusType == "tunnel" && a.TunnelID > 0 {
		return fmt.Sprintf("tunnel:%d:%d:%s", a.TunnelID, a.SourcePort, a.ForwardType)
	}
	if a.RuleID > 0 {
		return fmt.Sprintf("rule:%d:%d:%d:%s", a.RuleID, a.TunnelID, a.SourcePort, a.ForwardType)
	}
	if a.SourcePort > 0 {
		return fmt.Sprintf("port:%d:%s", a.SourcePort, a.ForwardType)
	}
	return ""
}

func desiredActionSignature(a action) string {
	return actionCommandSignature(a)
}

func canAdoptDesiredAction(a action) bool {
	if strings.TrimSpace(a.Op) != "apply" {
		return false
	}
	if strings.TrimSpace(a.StatusType) == "runtime" {
		return false
	}
	if a.SourcePort <= 0 {
		return false
	}
	port := fmt.Sprintf("%d", a.SourcePort)
	statusType := strings.TrimSpace(a.StatusType)
	if statusType == "tunnel" || (a.TunnelID > 0 && a.RuleID <= 0) {
		localTunnelID := readTunnelIDByPort(port)
		localForwardType := readTunnelForwardTypeByPort(port)
		return localTunnelID == a.TunnelID && desiredForwardTypeCompatible(localForwardType, a.ForwardType) && desiredActionLocalRuntimeReady(a)
	}
	localRuleID := readRuleIDByPort(port)
	localForwardType := readForwardTypeByPort(port)
	localTunnelID := readRuleTunnelIDByPort(port)
	return localRuleID == a.RuleID && (localTunnelID <= 0 || localTunnelID == a.TunnelID) && desiredForwardTypeCompatible(localForwardType, a.ForwardType) && desiredActionLocalRuntimeReady(a)
}

func desiredActionLocalRuntimeReady(a action) bool {
	if a.KnownRunning {
		return desiredKnownRunningActionReady(a)
	}
	checkedService := false
	if strings.TrimSpace(a.ServiceName) != "" {
		checkedService = true
		if !desiredManagedServiceReady(a, a.ServiceName, a.Unit) {
			return false
		}
	}
	if strings.TrimSpace(a.ServiceNameExtra) != "" {
		checkedService = true
		if !desiredManagedServiceReady(a, a.ServiceNameExtra, a.UnitExtra) {
			return false
		}
	}
	if a.Fxp != nil {
		checkedService = true
		if !fxpMatchesRunning(a.Fxp) {
			return false
		}
		if a.ForwardType == "forwardx" || a.ForwardType == "forwardx-tunnel" {
			return true
		}
	}
	if a.Failover != nil && a.Failover.Enabled {
		return false
	}
	forwardType := strings.TrimSpace(a.ForwardType)
	switch forwardType {
	case "iptables", "nftables":
		return newKernelForwardSnapshot().actionApplyReady(a)
	case "nginx", "nginx-tunnel", "nginx-tunnel-exit":
		return desiredNginxRuntimeReady(a.SourcePort, a.Protocol)
	case "gost", "forwardx", "gost-tunnel", "guard":
		return desiredGostRuntimeReady(a.SourcePort, a.Protocol)
	}
	return checkedService
}

func desiredKnownRunningActionReady(a action) bool {
	if !desiredManagedServiceReady(a, a.ServiceName, a.Unit) {
		return false
	}
	if !desiredManagedServiceReady(a, a.ServiceNameExtra, a.UnitExtra) {
		return false
	}
	if a.Fxp != nil && !fxpMatchesRunning(a.Fxp) {
		return false
	}
	if a.Failover != nil && a.Failover.Enabled {
		return false
	}
	if a.Fxp != nil && (a.ForwardType == "forwardx" || a.ForwardType == "forwardx-tunnel") {
		return true
	}
	switch strings.TrimSpace(a.ForwardType) {
	case "nginx", "nginx-tunnel", "nginx-tunnel-exit":
		return desiredNginxRuntimeReady(a.SourcePort, a.Protocol)
	case "iptables", "nftables":
		return newKernelForwardSnapshot().actionApplyReady(a)
	case "gost", "forwardx", "gost-tunnel", "guard":
		return desiredGostRuntimeReady(a.SourcePort, a.Protocol)
	default:
		return true
	}
}

func desiredManagedServiceReady(a action, serviceName string, unit string) bool {
	serviceName = strings.TrimSpace(serviceName)
	if serviceName == "" {
		return true
	}
	if !managedServiceActive(serviceName) {
		return false
	}
	if strings.TrimSpace(unit) == "" {
		return true
	}
	signature := managedServiceActionSignature(a, serviceName, unit)
	if !managedServiceSignatureMatches(serviceName, signature) {
		if shouldLogAgentReport("desired-service-signature-mismatch:"+serviceName, agentReportLogInterval) {
			logf("desired service signature mismatch; reapply needed service=%s %s", serviceName, actionLogSummary(a))
		}
		return false
	}
	return true
}

func desiredRuntimeServicesHealthy() bool {
	services := requiredRuntimeServicesFromLocalConfig()
	if len(services) == 0 {
		return false
	}
	for _, name := range services {
		if strings.HasPrefix(name, "mimic@") {
			if !mimicRuntimeServiceHealthy(name) {
				return false
			}
			continue
		}
		if !managedServiceActive(name) {
			return false
		}
	}
	return true
}

func desiredNginxRuntimeReady(port int, protocol string) bool {
	return cachedDesiredRuntimeReady(desiredNginxRuntimeReadyCache, port, protocol, func() bool {
		readiness := readLocalRuntimeReadiness()
		return port > 0 &&
			readiness.nginxReadyForPort(port, protocol)
	})
}

func desiredGostRuntimeReady(port int, protocol string) bool {
	if port <= 0 {
		return false
	}
	return cachedDesiredRuntimeReady(desiredGostRuntimeReadyCache, port, protocol, func() bool {
		readiness := readLocalRuntimeReadiness()
		matched := false
		for _, item := range []struct {
			path      string
			service   string
			readyPort func(int, string) bool
		}{
			{runtimeConfigPath, runtimeServiceName, readiness.gostReadyForPort},
			{tunnelRuntimeConfigPath, tunnelRuntimeServiceName, readiness.gostReadyForPort},
		} {
			if managedRuntimeConfigUsesPort(item.path, port) {
				matched = true
				if !managedServiceActive(item.service) || !item.readyPort(port, protocol) {
					return false
				}
			}
		}
		return matched
	})
}

func cachedDesiredRuntimeReady(cache map[string]desiredRuntimeReadyCacheEntry, port int, protocol string, compute func() bool) bool {
	if port <= 0 {
		return false
	}
	key := desiredRuntimeReadyCacheKey(port, protocol)
	now := time.Now()
	desiredRuntimeReadyMu.Lock()
	if entry, ok := cache[key]; ok && now.Sub(entry.checkedAt) <= desiredRuntimeReadyCacheTTL {
		desiredRuntimeReadyMu.Unlock()
		return entry.value
	}
	desiredRuntimeReadyMu.Unlock()
	value := compute()
	desiredRuntimeReadyMu.Lock()
	cache[key] = desiredRuntimeReadyCacheEntry{value: value, checkedAt: now}
	if len(cache) > 2048 {
		for key, entry := range cache {
			if now.Sub(entry.checkedAt) > desiredRuntimeReadyCacheTTL {
				delete(cache, key)
			}
		}
	}
	desiredRuntimeReadyMu.Unlock()
	return value
}

func desiredRuntimeReadyCacheKey(port int, protocol string) string {
	return fmt.Sprintf("%d:%s", port, normalizeRuntimeProtocol(protocol))
}

// primeDesiredRuntimeReadyCacheForActions computes readLocalRuntimeReadiness() once
// and pre-populates the per-(port,protocol) cache for every gost/nginx action in the
// batch. Without this, a host with N rules would call readLocalRuntimeReadiness() N
// times during the adoption check loop in syncDesiredState, each time running
// ss -H -ltnup + systemctl is-active + config JSON parse — O(N) expensive syscalls
// that add 10-30 seconds for 500+ rules on the first heartbeat after Agent restart.
func primeDesiredRuntimeReadyCacheForActions(actions []action) {
	type portKey struct {
		port  int
		proto string
		ft    string
	}
	unique := map[portKey]struct{}{}
	for _, a := range actions {
		if a.SourcePort <= 0 {
			continue
		}
		ft := strings.TrimSpace(a.ForwardType)
		switch ft {
		case "gost", "forwardx", "gost-tunnel", "guard",
			"nginx", "nginx-tunnel", "nginx-tunnel-exit":
			unique[portKey{a.SourcePort, normalizeRuntimeProtocol(a.Protocol), ft}] = struct{}{}
		}
	}
	if len(unique) == 0 {
		return
	}
	// Filter to only uncached keys — skip work we already know.
	needCompute := make([]portKey, 0, len(unique))
	desiredRuntimeReadyMu.Lock()
	now := time.Now()
	for pk := range unique {
		key := fmt.Sprintf("%d:%s", pk.port, pk.proto)
		var cache map[string]desiredRuntimeReadyCacheEntry
		switch pk.ft {
		case "gost", "forwardx", "gost-tunnel", "guard":
			cache = desiredGostRuntimeReadyCache
		default:
			cache = desiredNginxRuntimeReadyCache
		}
		if entry, ok := cache[key]; !ok || now.Sub(entry.checkedAt) > desiredRuntimeReadyCacheTTL {
			needCompute = append(needCompute, pk)
		}
	}
	desiredRuntimeReadyMu.Unlock()
	if len(needCompute) == 0 {
		return
	}

	// Single shared readiness snapshot — one ss + one systemctl call for the whole batch.
	// All compute below is pure in-memory; no IO while holding the cache mutex.
	// 使用跨心跳缓存，避免在快速 SSE 唤醒窗口内重复执行 ss/systemctl。
	readiness := readLocalRuntimeReadinessCached()

	// Cache managedServiceActive results per service name: at most 2 calls total
	// (runtimeServiceName, tunnelRuntimeServiceName) for the entire batch.
	svcActiveCache := map[string]bool{}
	svcActive := func(name string) bool {
		if v, ok := svcActiveCache[name]; ok {
			return v
		}
		v := managedServiceActive(name)
		svcActiveCache[name] = v
		return v
	}

	type result struct {
		key   string
		value bool
		cache *map[string]desiredRuntimeReadyCacheEntry
	}
	results := make([]result, 0, len(needCompute))
	runtimeItems := []struct {
		path      string
		service   string
		readyPort func(int, string) bool
	}{
		{runtimeConfigPath, runtimeServiceName, readiness.gostReadyForPort},
		{tunnelRuntimeConfigPath, tunnelRuntimeServiceName, readiness.gostReadyForPort},
	}
	for _, pk := range needCompute {
		key := fmt.Sprintf("%d:%s", pk.port, pk.proto)
		var ready bool
		var target *map[string]desiredRuntimeReadyCacheEntry
		switch pk.ft {
		case "gost", "forwardx", "gost-tunnel", "guard":
			target = &desiredGostRuntimeReadyCache
			// Replicate desiredGostRuntimeReady: matched AND all-services-pass.
			matched := false
			allOK := true
			for _, item := range runtimeItems {
				if managedRuntimeConfigUsesPort(item.path, pk.port) {
					matched = true
					if !svcActive(item.service) || !item.readyPort(pk.port, pk.proto) {
						allOK = false
						break
					}
				}
			}
			ready = matched && allOK
		default: // nginx family
			target = &desiredNginxRuntimeReadyCache
			ready = readiness.nginxReadyForPort(pk.port, pk.proto)
		}
		results = append(results, result{key, ready, target})
	}

	// Write all results in one lock window.
	now = time.Now()
	desiredRuntimeReadyMu.Lock()
	for _, r := range results {
		(*r.cache)[r.key] = desiredRuntimeReadyCacheEntry{value: r.value, checkedAt: now}
	}
	desiredRuntimeReadyMu.Unlock()
}

func desiredRuntimeConfigUsesPort(port int) bool {
	if port <= 0 {
		return false
	}
	for _, item := range managedRuntimeConfigs() {
		if managedRuntimeConfigUsesPort(item.path, port) {
			return true
		}
	}
	return false
}

func desiredForwardTypeCompatible(local string, desired string) bool {
	local = strings.TrimSpace(local)
	desired = strings.TrimSpace(desired)
	if local == "" || desired == "" {
		return false
	}
	if local == desired {
		return true
	}
	if local == "gost" && (desired == "forwardx" || desired == "nginx-tunnel") {
		return true
	}
	if local == "guard" && desired == "guard" {
		return true
	}
	return false
}

func readDesiredActionRecordsLocked() map[string]desiredActionRecord {
	records := map[string]desiredActionRecord{}
	raw, err := os.ReadFile(desiredStateRecordPath)
	if err != nil || len(raw) == 0 {
		return records
	}
	_ = json.Unmarshal(raw, &records)
	return records
}

func writeDesiredActionRecordsLocked(records map[string]desiredActionRecord) {
	_ = os.MkdirAll("/var/lib/forwardx-agent", 0755)
	raw, err := json.Marshal(records)
	if err != nil {
		return
	}
	tmpPath := desiredStateRecordPath + ".tmp"
	if err := os.WriteFile(tmpPath, raw, 0644); err != nil {
		return
	}
	if err := os.Rename(tmpPath, desiredStateRecordPath); err != nil {
		_ = os.Remove(tmpPath)
	}
}

func rememberDesiredActionResult(key string, signature string, ok bool) {
	desiredActionRecordMu.Lock()
	defer desiredActionRecordMu.Unlock()
	records := readDesiredActionRecordsLocked()
	records[key] = desiredActionRecord{Signature: signature, Success: ok, UpdatedAt: time.Now().Unix()}
	writeDesiredActionRecordsLocked(records)
}

func resetDesiredActionRecordsAfterAgentUpgrade() {
	desiredActionRecordMu.Lock()
	defer desiredActionRecordMu.Unlock()
	_ = os.MkdirAll("/var/lib/forwardx-agent", 0755)
	raw, err := os.ReadFile(desiredStateVersionPath)
	previous := strings.TrimSpace(string(raw))
	if previous == "" {
		if _, statErr := os.Stat(desiredStateRecordPath); statErr == nil {
			_ = os.Remove(desiredStateRecordPath)
			logf("agent desired state version initialized; retry records cleared")
		}
	} else if previous != Version {
		_ = os.Remove(desiredStateRecordPath)
		logf("agent version changed from %s to %s; desired state retry records cleared", previous, Version)
	}
	if err != nil || previous != Version {
		_ = os.WriteFile(desiredStateVersionPath, []byte(Version+"\n"), 0644)
	}
}

func enqueueActionJob(job actionJob) {
	if job.enqueuedAt.IsZero() {
		job.enqueuedAt = time.Now()
	}
	if job.protectedPort == "" {
		job.protectedPort = protectActionPort(actionProtectedPort(job.action))
	}
	pending := atomic.LoadInt64(&actionPendingCount)
	if pending >= actionQueueBacklogLogThreshold && shouldLogAgentReport("action-queue-backlog", agentReportLogInterval) {
		logf("action queue backlog pendingActions=%d queued=%d capacity=%d next=%s", pending, len(actionQueue), actionQueueCapacity, actionLogSummary(job.action))
	}
	select {
	case actionQueue <- job:
	default:
		if shouldLogAgentReport("action-queue-saturated", agentReportLogInterval) {
			logf("action queue saturated pendingActions=%d capacity=%d; enqueueing asynchronously", atomic.LoadInt64(&actionPendingCount), actionQueueCapacity)
		}
		go func() {
			actionQueue <- job
		}()
	}
}

func actionWorker() {
	baseWorkers := actionWorkerBaseConcurrency
	if baseWorkers < 1 {
		baseWorkers = 1
	}
	if baseWorkers > actionWorkerConcurrency {
		baseWorkers = actionWorkerConcurrency
	}
	startActionWorkerLoops(baseWorkers)
	go actionWorkerScaler()
}

func startActionWorkerLoops(count int) {
	for i := 0; i < count; i++ {
		workerID := int(atomic.AddInt64(&actionWorkerStartedCount, 1))
		go actionWorkerLoop(workerID)
	}
}

func actionWorkerScaler() {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for range ticker.C {
		pending := atomic.LoadInt64(&actionPendingCount)
		started := atomic.LoadInt64(&actionWorkerStartedCount)
		if pending <= started || started >= int64(actionWorkerConcurrency) {
			continue
		}
		target := pending
		if target < int64(actionWorkerBaseConcurrency) {
			target = int64(actionWorkerBaseConcurrency)
		}
		if target > int64(actionWorkerConcurrency) {
			target = int64(actionWorkerConcurrency)
		}
		if add := int(target - started); add > 0 {
			startActionWorkerLoops(add)
			logf("action workers scaled pendingActions=%d workers=%d/%d", pending, target, actionWorkerConcurrency)
		}
	}
}

func actionWorkerLoop(workerID int) {
	for job := range actionQueue {
		func() {
			if !job.enqueuedAt.IsZero() {
				waited := time.Since(job.enqueuedAt)
				if waited >= actionQueueSlowWaitThreshold && shouldLogAgentReport("action-queue-wait-slow", agentReportLogInterval) {
					logf("action queue wait slow worker=%d waited=%s pendingActions=%d queued=%d %s", workerID, waited.Round(time.Millisecond), atomic.LoadInt64(&actionPendingCount), len(actionQueue), actionLogSummary(job.action))
				}
			}
			if job.done != nil {
				defer close(job.done)
			}
			defer func() {
				if atomic.AddInt64(&actionPendingCount, -1) == 0 {
					wakeHeartbeat()
				}
			}()
			defer releaseProtectedActionPort(job.protectedPort)
			defer releaseQueuedAction(job.action)
			if isOlderAction(job.action, false) {
				return
			}
			releaseRuntimeGate := acquireSharedRuntimeSyncGate(job.action)
			if releaseRuntimeGate != nil {
				defer releaseRuntimeGate()
			}
			serialKey := actionSerialKey(job.action)
			unlock := acquireActionSerialLock(serialKey)
			if unlock != nil {
				defer unlock()
			}
			started := time.Now()
			ok := handleAction(job.cfg, job.action)
			elapsed := time.Since(started)
			if elapsed >= actionSlowHandleThreshold && shouldLogAgentReport("action-handle-slow:"+actionDiagnosticKey(job.action), agentReportLogInterval) {
				logf("action handle slow worker=%d duration=%s ok=%v pendingActions=%d queued=%d %s", workerID, elapsed.Round(time.Millisecond), ok, atomic.LoadInt64(&actionPendingCount), len(actionQueue), actionLogSummary(job.action))
			}
			if !ok && shouldLogAgentReport("action-handle-failed:"+actionDiagnosticKey(job.action), agentReportLogInterval) {
				logf("action handle failed worker=%d duration=%s pendingActions=%d queued=%d %s", workerID, elapsed.Round(time.Millisecond), atomic.LoadInt64(&actionPendingCount), len(actionQueue), actionLogSummary(job.action))
			}
			if job.desiredKey != "" && job.desiredSignature != "" {
				rememberDesiredActionResult(job.desiredKey, job.desiredSignature, ok)
			}
		}()
	}
}

func acquireSharedRuntimeSyncGate(a action) func() {
	statusType := strings.TrimSpace(a.StatusType)
	forwardType := strings.TrimSpace(a.ForwardType)
	if statusType == "runtime" && forwardType == "gost-runtime-sync" {
		sharedRuntimeSyncGate.Lock()
		return sharedRuntimeSyncGate.Unlock
	}
	if statusType == "runtime" {
		return nil
	}
	switch forwardType {
	case "gost", "gost-tunnel", "gost-tunnel-exit", "gost-tunnel-hop", "nginx", "nginx-tunnel", "nginx-tunnel-exit", "guard":
		sharedRuntimeSyncGate.RLock()
		return sharedRuntimeSyncGate.RUnlock
	default:
		return nil
	}
}

func actionSerialKey(a action) string {
	statusType := strings.TrimSpace(a.StatusType)
	if statusType == "runtime" {
		name := strings.TrimSpace(a.ForwardType)
		if name == "" {
			name = "runtime"
		}
		return "runtime:" + name
	}
	if validActionPort(a.SourcePort) {
		return fmt.Sprintf("port:%d", a.SourcePort)
	}
	if a.RuleID > 0 {
		return fmt.Sprintf("rule:%d", a.RuleID)
	}
	if a.TunnelID > 0 {
		return fmt.Sprintf("tunnel:%d", a.TunnelID)
	}
	return ""
}

func acquireActionSerialLock(key string) func() {
	key = strings.TrimSpace(key)
	if key == "" {
		return nil
	}
	actionSerialMu.Lock()
	lock := actionSerialLocks[key]
	if lock == nil {
		lock = &actionSerialLock{}
		actionSerialLocks[key] = lock
	}
	lock.refs++
	actionSerialMu.Unlock()

	startedAt := time.Now()
	lock.mu.Lock()
	if waited := time.Since(startedAt); waited >= actionQueueSlowWaitThreshold && shouldLogAgentReport("action-serial-wait:"+key, agentReportLogInterval) {
		logf("action serial wait slow key=%s waited=%s", key, waited.Round(time.Millisecond))
	}
	return func() {
		lock.mu.Unlock()
		actionSerialMu.Lock()
		lock.refs--
		if lock.refs <= 0 {
			delete(actionSerialLocks, key)
		}
		actionSerialMu.Unlock()
	}
}

func actionProtectedPort(a action) string {
	if !validActionPort(a.SourcePort) || strings.TrimSpace(a.StatusType) == "runtime" {
		return ""
	}
	return actionPortProtocolKey(a.SourcePort, a.Protocol)
}

func validActionPort(port int) bool {
	return port > 0 && port <= 65535
}

func protectActionPort(port string) string {
	port = strings.TrimSpace(port)
	if port == "" {
		return ""
	}
	protectedActionPortMu.Lock()
	protectedActionPorts[port]++
	protectedActionPortMu.Unlock()
	return port
}

func releaseProtectedActionPort(port string) {
	port = strings.TrimSpace(port)
	if port == "" {
		return
	}
	protectedActionPortMu.Lock()
	count := protectedActionPorts[port]
	if count <= 1 {
		delete(protectedActionPorts, port)
	} else {
		protectedActionPorts[port] = count - 1
	}
	protectedActionPortMu.Unlock()
}

func snapshotProtectedActionPorts() map[string]bool {
	protectedActionPortMu.Lock()
	defer protectedActionPortMu.Unlock()
	if len(protectedActionPorts) == 0 {
		return nil
	}
	ports := make(map[string]bool, len(protectedActionPorts))
	for port := range protectedActionPorts {
		ports[port] = true
	}
	return ports
}

func waitForActionBatch(done []<-chan struct{}, timeout time.Duration) {
	if len(done) == 0 {
		return
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for i, ch := range done {
		if ch == nil {
			continue
		}
		select {
		case <-ch:
		case <-timer.C:
			logf("selftest action wait timeout completed=%d total=%d timeout=%s", i, len(done), timeout)
			return
		}
	}
}

func logActionDuplicateSkip(a action, key string) {
	pending := atomic.LoadInt64(&actionPendingCount)
	if agentVerboseLogs {
		logf("action queue duplicate skip key=%s pendingActions=%d %s", key, pending, actionLogSummary(a))
		return
	}
	if pending >= actionQueueBacklogLogThreshold && shouldLogAgentReport("action-queue-duplicate:"+key, agentReportLogInterval) {
		logf("action queue duplicate skip key=%s pendingActions=%d queued=%d %s", key, pending, len(actionQueue), actionLogSummary(a))
	}
}

func actionLogSummary(a action) string {
	return fmt.Sprintf(
		"op=%s statusType=%s rule=%d tunnel=%d port=%d forwardType=%s protocol=%s issuedAt=%d",
		strings.TrimSpace(a.Op),
		strings.TrimSpace(a.StatusType),
		a.RuleID,
		a.TunnelID,
		a.SourcePort,
		strings.TrimSpace(a.ForwardType),
		strings.TrimSpace(a.Protocol),
		a.IssuedAt,
	)
}

func actionDiagnosticKey(a action) string {
	key := actionQueueKey(a)
	if key != "" {
		return key
	}
	statusType := strings.TrimSpace(a.StatusType)
	if statusType == "" {
		statusType = "unknown"
	}
	return fmt.Sprintf("%s:%s:%d:%d:%d", statusType, strings.TrimSpace(a.Op), a.RuleID, a.TunnelID, a.SourcePort)
}

func actionStaleKeys(a action) []string {
	keys := []string{}
	statusType := strings.TrimSpace(a.StatusType)
	if statusType == "" {
		if a.RuleID > 0 {
			statusType = "rule"
		} else if a.TunnelID > 0 {
			statusType = "tunnel"
		}
	}
	if statusType == "tunnel" && a.TunnelID > 0 {
		keys = append(keys, fmt.Sprintf("tunnel:%d:%d", a.TunnelID, a.SourcePort))
	}
	if a.RuleID > 0 {
		keys = append(keys, fmt.Sprintf("rule:%d:%d:%d", a.RuleID, a.TunnelID, a.SourcePort))
		keys = append(keys, fmt.Sprintf("rule:%d:%d", a.RuleID, a.SourcePort))
	}
	if validActionPort(a.SourcePort) {
		keys = append(keys, fmt.Sprintf("port:%d", a.SourcePort))
	}
	return keys
}

func isOlderAction(a action, remember bool) bool {
	if a.IssuedAt <= 0 {
		return false
	}
	keys := actionStaleKeys(a)
	if len(keys) == 0 {
		return false
	}
	actionEpochMu.Lock()
	latest := int64(0)
	for _, key := range keys {
		if ts := latestActionIssuedAt[key]; ts > latest {
			latest = ts
		}
	}
	if remember {
		for _, key := range keys {
			if a.IssuedAt > latestActionIssuedAt[key] {
				latestActionIssuedAt[key] = a.IssuedAt
			}
		}
		if a.IssuedAt > latest {
			latest = a.IssuedAt
		}
	}
	actionEpochMu.Unlock()
	if a.IssuedAt < latest {
		if shouldLogAgentReport("action-stale-drop", agentReportLogInterval) {
			logf("action stale drop op=%s statusType=%s rule=%d tunnel=%d port=%d issuedAt=%d latest=%d", a.Op, a.StatusType, a.RuleID, a.TunnelID, a.SourcePort, a.IssuedAt, latest)
		}
		return true
	}
	return false
}

func actionQueueKey(a action) string {
	keys := actionStaleKeys(a)
	if len(keys) == 0 {
		return ""
	}
	return strings.Join(keys, "|")
}

func releaseQueuedAction(a action) {
	key := actionQueueKey(a)
	if key == "" || a.IssuedAt <= 0 {
		return
	}
	queuedActionMu.Lock()
	if queuedActionKeys[key] == a.IssuedAt {
		delete(queuedActionKeys, key)
	}
	queuedActionMu.Unlock()
}
