package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const desiredActionFailureRetryInterval = 30 * time.Second
const desiredRuntimeReadyCacheTTL = 2 * time.Second

// desiredActionRecords 的内存缓存。所有读写直接操作此 map，
// 避免在 rememberDesiredActionResult（每个 worker 完成时调用）的关键路径上
// 做全量磁盘读写。后台 flusher 异步落盘。
var desiredActionRecordsMem = map[string]desiredActionRecord{}
var desiredActionRecordsLoaded bool

// desiredActionRecordsDirty 标记内存缓存已更新、需要落盘。
var desiredActionRecordsDirty atomic.Bool

// desiredActionRecordsRevision is guarded by desiredActionRecordMu. A flush only
// clears the dirty flag when no newer mutation happened while disk I/O ran.
var desiredActionRecordsRevision uint64

// desiredActionFlushCh 用于触发 flusher 尽快落盘（带缓冲，避免阻塞写方）。
var desiredActionFlushCh = make(chan struct{}, 1)
var writeDesiredActionRecordsSnapshot = flushDesiredActionRecordsToDisk

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

// sharedGostRuntimeSyncGate 仅用于 gost/gost-tunnel/guard 动作与
// gost-runtime-sync 之间的互斥。nginx 动作不再持有此锁，因此
// gost-runtime-sync 的写锁不再阻塞 nginx worker。
var sharedGostRuntimeSyncGate sync.RWMutex
var sharedNginxRuntimeSyncGate sync.RWMutex

type actionIngressItem struct {
	job    actionJob
	key    string
	active bool
}

// actionIngressBuffer keeps heartbeat and SSE producers non-blocking when the
// worker channel is full. Repeated pending work for the same runtime identity is
// replaced in place, so rapid edits retain the latest action without spawning
// one goroutine per overflow item.
type actionIngressBuffer struct {
	mu       sync.Mutex
	items    []*actionIngressItem
	head     int
	byKey    map[string]*actionIngressItem
	sequence uint64
	active   int
}

var actionIngress = actionIngressBuffer{byKey: map[string]*actionIngressItem{}}
var actionIngressWakeCh = make(chan struct{}, 1)

func (b *actionIngressBuffer) push(job actionJob) (int, *actionJob) {
	key := actionQueueKey(job.action)
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.byKey == nil {
		b.byKey = map[string]*actionIngressItem{}
	}
	var replaced *actionJob
	if key != "" {
		if current := b.byKey[key]; current != nil && current.active {
			current.active = false
			b.active--
			oldJob := current.job
			replaced = &oldJob
		}
	} else {
		b.sequence++
	}
	item := &actionIngressItem{job: job, key: key, active: true}
	b.items = append(b.items, item)
	b.active++
	if key != "" {
		b.byKey[key] = item
	}
	return b.active, replaced
}

func (b *actionIngressBuffer) pop() (actionJob, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for b.head < len(b.items) {
		item := b.items[b.head]
		b.items[b.head] = nil
		b.head++
		if item == nil || !item.active {
			continue
		}
		item.active = false
		b.active--
		if item.key != "" && b.byKey[item.key] == item {
			delete(b.byKey, item.key)
		}
		b.compactLocked()
		return item.job, true
	}
	b.compactLocked()
	return actionJob{}, false
}

func (b *actionIngressBuffer) len() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.active
}

func (b *actionIngressBuffer) reset() []actionJob {
	b.mu.Lock()
	defer b.mu.Unlock()
	pending := make([]actionJob, 0, b.active)
	for index := b.head; index < len(b.items); index++ {
		if item := b.items[index]; item != nil && item.active {
			pending = append(pending, item.job)
		}
	}
	b.items = nil
	b.head = 0
	b.byKey = map[string]*actionIngressItem{}
	b.active = 0
	return pending
}

func (b *actionIngressBuffer) compactLocked() {
	if b.head == 0 {
		return
	}
	if b.head >= len(b.items) {
		b.items = nil
		b.head = 0
		return
	}
	if b.head >= 1024 && b.head*2 >= len(b.items) {
		remaining := append([]*actionIngressItem(nil), b.items[b.head:]...)
		b.items = remaining
		b.head = 0
	}
}

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
			releaseQueuedAction(job.action)
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
		readiness := readLocalRuntimeReadinessCached()
		return port > 0 &&
			readiness.nginxReadyForPort(port, protocol)
	})
}

func desiredGostRuntimeReady(port int, protocol string) bool {
	if port <= 0 {
		return false
	}
	return cachedDesiredRuntimeReady(desiredGostRuntimeReadyCache, port, protocol, func() bool {
		readiness := readLocalRuntimeReadinessCached()
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

// ensureDesiredActionRecordsLoadedLocked 在持有 desiredActionRecordMu 的情况下
// 从磁盘加载记录到内存缓存（仅首次调用执行 I/O）。
func ensureDesiredActionRecordsLoadedLocked() {
	if desiredActionRecordsLoaded {
		return
	}
	records := map[string]desiredActionRecord{}
	raw, err := os.ReadFile(desiredStateRecordPath)
	if err == nil && len(raw) > 0 {
		_ = json.Unmarshal(raw, &records)
	}
	desiredActionRecordsMem = records
	desiredActionRecordsLoaded = true
}

// readDesiredActionRecordsLocked 返回内存缓存的深拷贝（调用方持有 desiredActionRecordMu）。
func readDesiredActionRecordsLocked() map[string]desiredActionRecord {
	ensureDesiredActionRecordsLoadedLocked()
	out := make(map[string]desiredActionRecord, len(desiredActionRecordsMem))
	for k, v := range desiredActionRecordsMem {
		out[k] = v
	}
	return out
}

// writeDesiredActionRecordsLocked 将 records 写入内存缓存并通知 flusher 落盘
// （调用方持有 desiredActionRecordMu，不做磁盘 I/O）。
func writeDesiredActionRecordsLocked(records map[string]desiredActionRecord) {
	desiredActionRecordsMem = records
	desiredActionRecordsLoaded = true
	markDesiredActionRecordsDirtyLocked()
}

func markDesiredActionRecordsDirtyLocked() {
	desiredActionRecordsRevision++
	desiredActionRecordsDirty.Store(true)
	select {
	case desiredActionFlushCh <- struct{}{}:
	default:
	}
}

// flushDesiredActionRecordsToDisk writes records atomically and returns errors so
// the background flusher can retain the dirty state and retry.
func flushDesiredActionRecordsToDisk(records map[string]desiredActionRecord) error {
	if err := os.MkdirAll("/var/lib/forwardx-agent", 0755); err != nil {
		return err
	}
	raw, err := json.Marshal(records)
	if err != nil {
		return err
	}
	tmpPath := desiredStateRecordPath + ".tmp"
	if err := os.WriteFile(tmpPath, raw, 0644); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, desiredStateRecordPath); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return nil
}

const desiredActionFlushDebounce = 250 * time.Millisecond
const desiredActionFlushMaxDelay = 5 * time.Second

func flushDesiredActionRecordsOnce() {
	desiredActionRecordMu.Lock()
	ensureDesiredActionRecordsLoadedLocked()
	if !desiredActionRecordsDirty.Load() {
		desiredActionRecordMu.Unlock()
		return
	}
	revision := desiredActionRecordsRevision
	snapshot := make(map[string]desiredActionRecord, len(desiredActionRecordsMem))
	for key, value := range desiredActionRecordsMem {
		snapshot[key] = value
	}
	desiredActionRecordMu.Unlock()

	err := writeDesiredActionRecordsSnapshot(snapshot)
	desiredActionRecordMu.Lock()
	if err == nil && desiredActionRecordsRevision == revision {
		desiredActionRecordsDirty.Store(false)
	}
	stillDirty := desiredActionRecordsDirty.Load()
	desiredActionRecordMu.Unlock()
	if err != nil && shouldLogAgentReport("desired-state-record-flush", agentReportLogInterval) {
		logf("desired state record flush failed: %v", err)
	}
	if stillDirty {
		select {
		case desiredActionFlushCh <- struct{}{}:
		default:
		}
	}
}

// startDesiredActionRecordsFlusher batches completion bursts into one snapshot
// write. The max-delay ticker also retries failed writes.
func startDesiredActionRecordsFlusher() {
	go func() {
		ticker := time.NewTicker(desiredActionFlushMaxDelay)
		defer ticker.Stop()
		var timer *time.Timer
		var timerCh <-chan time.Time
		resetTimer := func() {
			if timer == nil {
				timer = time.NewTimer(desiredActionFlushDebounce)
			} else {
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				timer.Reset(desiredActionFlushDebounce)
			}
			timerCh = timer.C
		}
		for {
			select {
			case <-desiredActionFlushCh:
				resetTimer()
			case <-timerCh:
				timerCh = nil
				flushDesiredActionRecordsOnce()
			case <-ticker.C:
				flushDesiredActionRecordsOnce()
			}
		}
	}()
}

// rememberDesiredActionResult 更新内存缓存中的单条记录（无磁盘 I/O）。
// 后台 flusher 会在 ≤5s 内将变更落盘。
func rememberDesiredActionResult(key string, signature string, ok bool) {
	desiredActionRecordMu.Lock()
	ensureDesiredActionRecordsLoadedLocked()
	desiredActionRecordsMem[key] = desiredActionRecord{Signature: signature, Success: ok, UpdatedAt: time.Now().Unix()}
	markDesiredActionRecordsDirtyLocked()
	desiredActionRecordMu.Unlock()
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
		// 同步清空内存缓存，避免 flusher 把旧数据重写回去。
		desiredActionRecordsMem = map[string]desiredActionRecord{}
		desiredActionRecordsLoaded = true
		desiredActionRecordsRevision++
		desiredActionRecordsDirty.Store(false)
	} else if previous != Version {
		_ = os.Remove(desiredStateRecordPath)
		logf("agent version changed from %s to %s; desired state retry records cleared", previous, Version)
		desiredActionRecordsMem = map[string]desiredActionRecord{}
		desiredActionRecordsLoaded = true
		desiredActionRecordsRevision++
		desiredActionRecordsDirty.Store(false)
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
		logf("action queue backlog pendingActions=%d queued=%d ingress=%d capacity=%d next=%s", pending, len(actionQueue), actionIngress.len(), actionQueueCapacity, actionLogSummary(job.action))
	}
	depth, replaced := actionIngress.push(job)
	if replaced != nil {
		finishActionJob(*replaced)
	}
	select {
	case actionIngressWakeCh <- struct{}{}:
	default:
	}
	if depth >= actionQueueCapacity && shouldLogAgentReport("action-ingress-backlog", agentReportLogInterval) {
		logf("action ingress backlog pendingActions=%d ingress=%d workerQueue=%d; producers remain non-blocking", atomic.LoadInt64(&actionPendingCount), depth, len(actionQueue))
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
	go actionDispatcherLoop()
	startActionWorkerLoops(baseWorkers)
	go actionWorkerScaler()
}

func actionDispatcherLoop() {
	for {
		job, ok := actionIngress.pop()
		if !ok {
			<-actionIngressWakeCh
			continue
		}
		if isOlderAction(job.action, false) {
			finishActionJob(job)
			continue
		}
		actionQueue <- job
	}
}

func finishActionJob(job actionJob) {
	if job.done != nil {
		close(job.done)
	}
	releaseProtectedActionPort(job.protectedPort)
	releaseQueuedAction(job.action)
	if atomic.AddInt64(&actionPendingCount, -1) == 0 {
		wakeHeartbeat()
	}
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
			defer finishActionJob(job)
			if isOlderAction(job.action, false) {
				return
			}
			releaseRuntimeGate := acquireSharedRuntimeSyncGate(job.action)
			if releaseRuntimeGate != nil {
				var releaseOnce sync.Once
				release := releaseRuntimeGate
				releaseRuntimeGate = func() { releaseOnce.Do(release) }
				defer releaseRuntimeGate()
			}
			unlock := acquireActionSerialLocks(actionSerialKeys(job.action))
			if unlock != nil {
				defer unlock()
			}
			started := time.Now()
			ok := handleActionWithRuntimeGate(job.cfg, job.action, releaseRuntimeGate)
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
		// 独占写锁：等待所有 gost/guard worker 完成后才重写 gost.json 并重启服务。
		sharedGostRuntimeSyncGate.Lock()
		return sharedGostRuntimeSyncGate.Unlock
	}
	if statusType == "runtime" && forwardType == "nginx-runtime-sync" {
		sharedNginxRuntimeSyncGate.Lock()
		return sharedNginxRuntimeSyncGate.Unlock
	}
	if statusType == "runtime" {
		return nil
	}
	switch forwardType {
	case "gost", "gost-tunnel", "gost-tunnel-exit", "gost-tunnel-hop", "guard":
		// 共享读锁：与同类 worker 并发，但阻塞 gost-runtime-sync 写锁。
		sharedGostRuntimeSyncGate.RLock()
		return sharedGostRuntimeSyncGate.RUnlock
	case "nginx", "nginx-tunnel", "nginx-tunnel-exit":
		sharedNginxRuntimeSyncGate.RLock()
		return sharedNginxRuntimeSyncGate.RUnlock
	default:
		// nginx / iptables / nftables 等不参与 gost 运行时同步门，无需持锁。
		return nil
	}
}

func actionSerialKeys(a action) []string {
	statusType := strings.TrimSpace(a.StatusType)
	if statusType == "runtime" {
		name := strings.TrimSpace(a.ForwardType)
		if name == "" {
			name = "runtime"
		}
		return []string{"runtime:" + name}
	}
	keys := make([]string, 0, 2)
	if a.RuleID > 0 {
		keys = append(keys, fmt.Sprintf("rule:%d", a.RuleID))
	} else if a.TunnelID > 0 {
		keys = append(keys, fmt.Sprintf("tunnel:%d", a.TunnelID))
	}
	if validActionPort(a.SourcePort) {
		keys = append(keys, fmt.Sprintf("port:%d", a.SourcePort))
	}
	sort.Strings(keys)
	return keys
}

func acquireActionSerialLocks(keys []string) func() {
	if len(keys) == 0 {
		return nil
	}
	normalizedKeys := make([]string, 0, len(keys))
	for _, key := range keys {
		key = strings.TrimSpace(key)
		if key != "" {
			normalizedKeys = append(normalizedKeys, key)
		}
	}
	sort.Strings(normalizedKeys)
	uniqueKeys := normalizedKeys[:0]
	for _, key := range normalizedKeys {
		if len(uniqueKeys) == 0 || uniqueKeys[len(uniqueKeys)-1] != key {
			uniqueKeys = append(uniqueKeys, key)
		}
	}
	if len(uniqueKeys) == 0 {
		return nil
	}
	unlocks := make([]func(), 0, len(uniqueKeys))
	for _, key := range uniqueKeys {
		unlocks = append(unlocks, acquireActionSerialLock(key))
	}
	return func() {
		for index := len(unlocks) - 1; index >= 0; index-- {
			unlocks[index]()
		}
	}
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
	if statusType == "runtime" {
		name := strings.TrimSpace(a.ForwardType)
		if name == "" {
			name = "runtime"
		}
		return []string{"runtime:" + name}
	}
	if statusType == "tunnel" && a.TunnelID > 0 {
		keys = append(keys, fmt.Sprintf("tunnel:%d:%d", a.TunnelID, a.SourcePort))
		// A host can have only one listener for a tunnel. Make a newer port
		// assignment supersede queued work for the old port.
		keys = append(keys, fmt.Sprintf("tunnel:%d", a.TunnelID))
	}
	if a.RuleID > 0 {
		keys = append(keys, fmt.Sprintf("rule:%d:%d:%d", a.RuleID, a.TunnelID, a.SourcePort))
		keys = append(keys, fmt.Sprintf("rule:%d:%d", a.RuleID, a.SourcePort))
		// A rule has one active listener identity per Agent. A newer host, tunnel,
		// port, or protocol assignment must supersede queued work for the old one.
		keys = append(keys, fmt.Sprintf("rule:%d", a.RuleID))
	}
	if validActionPort(a.SourcePort) {
		for _, protocol := range runtimeProtocols(a.Protocol) {
			keys = append(keys, fmt.Sprintf("port:%d:%s", a.SourcePort, protocol))
		}
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
