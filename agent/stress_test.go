package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

var stressWorkersOnce sync.Once

func TestAgentCommTransientErrorClassification(t *testing.T) {
	transient := []error{
		fmt.Errorf("520 : error code: 520"),
		fmt.Errorf("stream error: stream ID 5; INTERNAL_ERROR; received from peer"),
		fmt.Errorf("unexpected EOF"),
		fmt.Errorf("connection reset by peer"),
		fmt.Errorf("TLS handshake timeout"),
	}
	for _, err := range transient {
		if !isTransientAgentCommError(err) {
			t.Fatalf("expected transient error: %v", err)
		}
	}

	permanent := []error{
		fmt.Errorf("401 Unauthorized"),
		fmt.Errorf("400 Bad Request: invalid encrypted request"),
		fmt.Errorf("mac verification failed"),
	}
	for _, err := range permanent {
		if isTransientAgentCommError(err) {
			t.Fatalf("expected permanent error: %v", err)
		}
	}
}

func TestSkipStaleRemoveWhenDesiredRuleStillRuns(t *testing.T) {
	rememberDesiredRunningRules([]runningRule{{
		RuleID:      47,
		TunnelID:    3,
		SourcePort:  10090,
		ForwardType: "gost",
		TargetIP:    "203.0.113.10",
		TargetPort:  31470,
		Protocol:    "both",
	}})
	defer rememberDesiredRunningRules(nil)

	staleRemove := action{
		StatusType:  "rule",
		RuleID:      47,
		TunnelID:    0,
		Op:          "remove",
		ForwardType: "gost",
		SourcePort:  10090,
		Protocol:    "both",
	}
	if !shouldSkipRemoveForReassignedPort(staleRemove) {
		t.Fatal("expected stale tunnel=0 remove to be skipped while desired tunnel=3 rule is still running")
	}

	reassignedRemove := staleRemove
	reassignedRemove.RuleID = 46
	if !shouldSkipRemoveForReassignedPort(reassignedRemove) {
		t.Fatal("expected stale remove from previous rule to be skipped while the port is desired by another rule")
	}

	realRemove := staleRemove
	realRemove.SourcePort = 10091
	if shouldSkipRemoveForReassignedPort(realRemove) {
		t.Fatal("unexpected skip for remove outside the desired running rule set")
	}

	currentRouteRemove := staleRemove
	currentRouteRemove.TunnelID = 3
	if shouldSkipRemoveForReassignedPort(currentRouteRemove) {
		t.Fatal("unexpected skip for explicit remove of the currently desired rule route")
	}
}

func TestTunnelPortChangeSupersedesOlderAction(t *testing.T) {
	actionEpochMu.Lock()
	previous := latestActionIssuedAt
	latestActionIssuedAt = map[string]int64{}
	actionEpochMu.Unlock()
	t.Cleanup(func() {
		actionEpochMu.Lock()
		latestActionIssuedAt = previous
		actionEpochMu.Unlock()
	})

	oldPort := action{
		StatusType:  "tunnel",
		TunnelID:    35,
		Op:          "apply",
		ForwardType: "gost-tunnel",
		SourcePort:  9999,
		Protocol:    "tcp",
		IssuedAt:    100,
	}
	if isOlderAction(oldPort, true) {
		t.Fatal("first tunnel action must not be stale")
	}

	newPort := oldPort
	newPort.SourcePort = 12845
	newPort.IssuedAt = 200
	if isOlderAction(newPort, true) {
		t.Fatal("new tunnel port assignment must not be stale")
	}
	if !isOlderAction(oldPort, false) {
		t.Fatal("old tunnel port assignment must be discarded after a newer port assignment")
	}
}

func TestRulePortChangeSupersedesOlderAction(t *testing.T) {
	actionEpochMu.Lock()
	previous := latestActionIssuedAt
	latestActionIssuedAt = map[string]int64{}
	actionEpochMu.Unlock()
	t.Cleanup(func() {
		actionEpochMu.Lock()
		latestActionIssuedAt = previous
		actionEpochMu.Unlock()
	})

	oldPort := action{StatusType: "rule", RuleID: 51, Op: "apply", ForwardType: "gost", SourcePort: 10001, Protocol: "tcp", IssuedAt: 100}
	newPort := oldPort
	newPort.SourcePort = 10002
	newPort.IssuedAt = 200
	if isOlderAction(oldPort, true) || isOlderAction(newPort, true) {
		t.Fatal("current rule assignments must be accepted")
	}
	if !isOlderAction(oldPort, false) {
		t.Fatal("old rule port assignment must be discarded")
	}
}

func TestActionStalenessKeepsTCPAndUDPPortLanesIndependent(t *testing.T) {
	actionEpochMu.Lock()
	previous := latestActionIssuedAt
	latestActionIssuedAt = map[string]int64{}
	actionEpochMu.Unlock()
	t.Cleanup(func() {
		actionEpochMu.Lock()
		latestActionIssuedAt = previous
		actionEpochMu.Unlock()
	})

	tcp := action{StatusType: "rule", RuleID: 61, Op: "apply", ForwardType: "gost", SourcePort: 18080, Protocol: "tcp", IssuedAt: 100}
	udp := action{StatusType: "rule", RuleID: 62, Op: "apply", ForwardType: "gost", SourcePort: 18080, Protocol: "udp", IssuedAt: 200}
	if isOlderAction(tcp, true) || isOlderAction(udp, true) {
		t.Fatal("TCP and UDP rules sharing a port must remain independent")
	}
	if isOlderAction(tcp, false) {
		t.Fatal("a newer UDP action must not make the TCP action stale")
	}

	both := action{StatusType: "rule", RuleID: 63, Op: "apply", ForwardType: "gost", SourcePort: 18080, Protocol: "both", IssuedAt: 300}
	if isOlderAction(both, true) {
		t.Fatal("new combined-protocol action must be accepted")
	}
	if !isOlderAction(tcp, false) || !isOlderAction(udp, false) {
		t.Fatal("a combined-protocol action must supersede both port lanes")
	}
}

func TestRuntimeIngressCoalescesByRuntimeFamily(t *testing.T) {
	buffer := actionIngressBuffer{byKey: map[string]*actionIngressItem{}}
	oldSync := action{StatusType: "runtime", ForwardType: "gost-runtime-sync", IssuedAt: 100}
	newSync := oldSync
	newSync.IssuedAt = 200
	newSync.Commands = []string{"latest"}
	if _, replaced := buffer.push(actionJob{action: oldSync}); replaced != nil {
		t.Fatal("first runtime action unexpectedly replaced work")
	}
	depth, replaced := buffer.push(actionJob{action: newSync})
	if depth != 1 || replaced == nil || replaced.action.IssuedAt != oldSync.IssuedAt {
		t.Fatalf("runtime replacement depth=%d replaced=%+v", depth, replaced)
	}
	job, ok := buffer.pop()
	if !ok || job.action.IssuedAt != newSync.IssuedAt {
		t.Fatalf("latest runtime action was not retained: %+v", job.action)
	}
}

func TestTunnelActionStatusKeepsPortIdentity(t *testing.T) {
	resetActionStatusReportsForTest()
	t.Cleanup(resetActionStatusReportsForTest)

	cfg := Config{PanelURL: "https://panel.example.test", Token: "test"}
	oldPort := action{
		StatusType:  "tunnel",
		TunnelID:    35,
		SourcePort:  9999,
		ForwardType: "gost-tunnel",
	}
	newPort := oldPort
	newPort.SourcePort = 12845
	enqueueActionStatusReport(cfg, oldPort, false, "old listener failed")
	enqueueActionStatusReport(cfg, newPort, true, "")

	reports := takeActionStatusReports(actionStatusBatchSize)
	if len(reports) != 2 {
		t.Fatalf("status reports = %d, want 2", len(reports))
	}
	ports := map[int]bool{}
	for _, report := range reports {
		ports[report.payload.SourcePort] = true
	}
	if !ports[9999] || !ports[12845] {
		t.Fatalf("status reports lost a tunnel listener port: %+v", reports)
	}
}

func TestUrgentRefreshBypassesBusyHeartbeat(t *testing.T) {
	now := time.Now()
	lastFull := now.Add(-time.Second)
	if !shouldUseBusyHeartbeat(true, false, 1, lastFull, now) {
		t.Fatal("ordinary refresh during a recent action batch should use a keepalive")
	}
	if shouldUseBusyHeartbeat(true, true, 1, lastFull, now) {
		t.Fatal("urgent configuration refresh must use a full heartbeat")
	}
	if shouldUseBusyHeartbeat(true, false, 1, now.Add(-actionBacklogKeepaliveInterval-time.Millisecond), now) {
		t.Fatal("a full heartbeat must be forced when the keepalive window expires")
	}
}

func TestActionIngressCoalescesPendingUpdatesWithoutBlocking(t *testing.T) {
	buffer := actionIngressBuffer{byKey: map[string]*actionIngressItem{}}
	base := action{
		StatusType:  "rule",
		RuleID:      77,
		IssuedAt:    100,
		Op:          "apply",
		ForwardType: "gost",
		SourcePort:  18080,
		Protocol:    "tcp",
	}
	depth, replaced := buffer.push(actionJob{action: base})
	if depth != 1 || replaced != nil {
		t.Fatalf("first push depth=%d replaced=%v", depth, replaced != nil)
	}

	newer := base
	newer.IssuedAt = 200
	newer.TargetPort = 8081
	depth, replaced = buffer.push(actionJob{action: newer})
	if depth != 1 || replaced == nil || replaced.action.IssuedAt != base.IssuedAt {
		t.Fatalf("replacement depth=%d replaced=%+v", depth, replaced)
	}
	job, ok := buffer.pop()
	if !ok || job.action.IssuedAt != newer.IssuedAt || job.action.TargetPort != newer.TargetPort {
		t.Fatalf("latest pending action was not retained: ok=%v action=%+v", ok, job.action)
	}
	if buffer.len() != 0 {
		t.Fatalf("ingress depth=%d after pop", buffer.len())
	}

	started := time.Now()
	for i := 0; i < actionQueueCapacity+2000; i++ {
		a := base
		a.RuleID = 1000 + i
		a.SourcePort = 20000 + i
		a.IssuedAt = int64(1000 + i)
		buffer.push(actionJob{action: a})
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("non-blocking ingress push took %s", elapsed)
	}
	if got, want := buffer.len(), actionQueueCapacity+2000; got != want {
		t.Fatalf("ingress depth=%d want=%d", got, want)
	}
}

func TestRuntimeSyncGatesAreIndependentByRuntimeFamily(t *testing.T) {
	gostAction := action{StatusType: "rule", ForwardType: "gost"}
	nginxRuntime := action{StatusType: "runtime", ForwardType: "nginx-runtime-sync"}
	releaseGostRead := acquireSharedRuntimeSyncGate(gostAction)
	if releaseGostRead == nil {
		t.Fatal("gost action did not acquire its shared runtime gate")
	}

	nginxAcquired := make(chan func(), 1)
	go func() { nginxAcquired <- acquireSharedRuntimeSyncGate(nginxRuntime) }()
	select {
	case release := <-nginxAcquired:
		if release == nil {
			releaseGostRead()
			t.Fatal("nginx runtime action did not acquire its gate")
		}
		release()
	case <-time.After(250 * time.Millisecond):
		releaseGostRead()
		t.Fatal("nginx runtime sync was blocked by an unrelated gost action")
	}

	gostRuntime := action{StatusType: "runtime", ForwardType: "gost-runtime-sync"}
	gostAcquired := make(chan func(), 1)
	go func() { gostAcquired <- acquireSharedRuntimeSyncGate(gostRuntime) }()
	select {
	case release := <-gostAcquired:
		release()
		releaseGostRead()
		t.Fatal("gost runtime sync acquired its write gate while a gost action was active")
	case <-time.After(75 * time.Millisecond):
	}
	releaseGostRead()
	select {
	case release := <-gostAcquired:
		if release == nil {
			t.Fatal("gost runtime sync did not acquire its gate")
		}
		release()
	case <-time.After(time.Second):
		t.Fatal("gost runtime sync remained blocked after readers completed")
	}
}

func TestManagedRuntimeReadinessSignalBroadcastsToAllWaiters(t *testing.T) {
	const waiterCount = 32
	ready := make(chan struct{}, waiterCount)
	done := make(chan struct{}, waiterCount)
	for i := 0; i < waiterCount; i++ {
		go func() {
			signal := managedRuntimeListenReadySignal()
			ready <- struct{}{}
			<-signal
			done <- struct{}{}
		}()
	}
	for i := 0; i < waiterCount; i++ {
		<-ready
	}
	broadcastManagedRuntimeListenReady()
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	for i := 0; i < waiterCount; i++ {
		select {
		case <-done:
		case <-timer.C:
			t.Fatalf("readiness broadcast woke %d/%d waiters", i, waiterCount)
		}
	}
}

func TestDesiredActionRecordFlushRetainsNewerRevisionAndRetries(t *testing.T) {
	desiredActionRecordMu.Lock()
	previousRecords := desiredActionRecordsMem
	previousLoaded := desiredActionRecordsLoaded
	previousRevision := desiredActionRecordsRevision
	previousDirty := desiredActionRecordsDirty.Load()
	desiredActionRecordsMem = map[string]desiredActionRecord{}
	desiredActionRecordsLoaded = true
	desiredActionRecordsRevision = 0
	desiredActionRecordsDirty.Store(false)
	desiredActionRecordMu.Unlock()
	previousWriter := writeDesiredActionRecordsSnapshot
	t.Cleanup(func() {
		writeDesiredActionRecordsSnapshot = previousWriter
		desiredActionRecordMu.Lock()
		desiredActionRecordsMem = previousRecords
		desiredActionRecordsLoaded = previousLoaded
		desiredActionRecordsRevision = previousRevision
		desiredActionRecordsDirty.Store(previousDirty)
		desiredActionRecordMu.Unlock()
		for {
			select {
			case <-desiredActionFlushCh:
			default:
				return
			}
		}
	})

	desiredActionRecordMu.Lock()
	desiredActionRecordsMem["rule:1"] = desiredActionRecord{Signature: "first", Success: true}
	markDesiredActionRecordsDirtyLocked()
	desiredActionRecordMu.Unlock()

	writeDesiredActionRecordsSnapshot = func(snapshot map[string]desiredActionRecord) error {
		if snapshot["rule:1"].Signature != "first" {
			t.Fatalf("unexpected first snapshot: %+v", snapshot)
		}
		desiredActionRecordMu.Lock()
		desiredActionRecordsMem["rule:2"] = desiredActionRecord{Signature: "newer", Success: true}
		markDesiredActionRecordsDirtyLocked()
		desiredActionRecordMu.Unlock()
		return nil
	}
	flushDesiredActionRecordsOnce()
	if !desiredActionRecordsDirty.Load() {
		t.Fatal("flush cleared dirty state despite a newer in-memory revision")
	}

	writeAttempts := 0
	writeDesiredActionRecordsSnapshot = func(snapshot map[string]desiredActionRecord) error {
		writeAttempts++
		if writeAttempts == 1 {
			return fmt.Errorf("temporary disk failure")
		}
		if snapshot["rule:2"].Signature != "newer" {
			t.Fatalf("newer record missing from retry snapshot: %+v", snapshot)
		}
		return nil
	}
	flushDesiredActionRecordsOnce()
	if !desiredActionRecordsDirty.Load() {
		t.Fatal("failed flush must remain dirty for retry")
	}
	flushDesiredActionRecordsOnce()
	if desiredActionRecordsDirty.Load() {
		t.Fatal("successful retry did not clear dirty state")
	}
}

func TestAgentStress3000RuleHeartbeat(t *testing.T) {
	if os.Getenv("FORWARDX_AGENT_STRESS") != "1" {
		t.Skip("set FORWARDX_AGENT_STRESS=1 to run the 3000-rule Agent stress test")
	}

	resetAgentStressState()
	stressWorkersOnce.Do(func() {
		actionWorker()
	})

	ruleCount := 3000
	if configured, err := strconv.Atoi(strings.TrimSpace(os.Getenv("FORWARDX_AGENT_STRESS_RULES"))); err == nil && configured >= 1 && configured <= 20000 {
		ruleCount = configured
	}
	assertManagedRuntimeLogRegression(t, ruleCount)
	assertActionStatusBurstDoesNotBlock(t, ruleCount)

	token := "stress-token"
	actions := buildStressActions(ruleCount)
	for index := range actions {
		if actions[index].ForwardType == "stress-mock" {
			actions[index].ForwardType = "guard"
		}
	}
	var heartbeatRequests atomic.Int64
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/sync" {
			http.NotFound(w, r)
			return
		}
		var env envelope
		if err := json.NewDecoder(r.Body).Decode(&env); err != nil {
			t.Errorf("decode request envelope: %v", err)
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		plain, err := decrypt(env, token)
		if err != nil {
			t.Errorf("decrypt request envelope: %v", err)
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		var req struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal(plain, &req); err != nil {
			t.Errorf("decode request payload: %v", err)
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if req.Path != "/api/agent/heartbeat" {
			t.Errorf("unexpected sync path: %s", req.Path)
			http.Error(w, "unexpected path", http.StatusBadRequest)
			return
		}
		heartbeatRequests.Add(1)
		// The supplied logs contain sustained 300ms+ panel latency. Keep that
		// latency in the stress path so action dispatch is tested after a slow pull.
		time.Sleep(300 * time.Millisecond)
		respEnv, err := encrypt(heartbeatResp{
			Actions:        actions,
			NextInterval:   30,
			CompactReports: true,
		}, token)
		if err != nil {
			t.Errorf("encrypt response: %v", err)
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(respEnv)
	}))
	defer panel.Close()

	var before runtime.MemStats
	runtime.ReadMemStats(&before)
	started := time.Now()
	// Hold only the GOST runtime gate so workers cannot consume guard actions.
	// This forces the bounded worker channel to fill and verifies heartbeat/SSE
	// producers hand the overflow to the coalescing ingress without blocking.
	sharedGostRuntimeSyncGate.Lock()
	heartbeatStarted := time.Now()
	nextInterval, err := heartbeat(Config{PanelURL: panel.URL, Token: token, Interval: 30})
	heartbeatElapsed := time.Since(heartbeatStarted)
	blockedBacklog := len(actionQueue) + actionIngress.len()
	sharedGostRuntimeSyncGate.Unlock()
	if err != nil {
		t.Fatalf("heartbeat failed: %v", err)
	}
	if nextInterval != 30 {
		t.Fatalf("nextInterval = %d, want 30", nextInterval)
	}
	if ruleCount > actionQueueCapacity && blockedBacklog < actionQueueCapacity {
		t.Fatalf("worker queue did not saturate during blocked-worker test: backlog=%d capacity=%d", blockedBacklog, actionQueueCapacity)
	}
	maxPending, err := waitForStressActionsDrained(30 * time.Second)
	if err != nil {
		t.Fatal(err)
	}
	elapsed := time.Since(started)
	var after runtime.MemStats
	runtime.ReadMemStats(&after)

	if got := heartbeatRequests.Load(); got != 1 {
		t.Fatalf("heartbeat request count = %d, want 1", got)
	}
	if pending := atomic.LoadInt64(&actionPendingCount); pending != 0 {
		t.Fatalf("pending actions left = %d", pending)
	}
	if queued := len(actionQueue); queued != 0 {
		t.Fatalf("queued actions left = %d", queued)
	}
	if protected := countProtectedActionPorts(); protected != 0 {
		t.Fatalf("protected action ports left = %d", protected)
	}

	t.Logf("stress rules=%d enqueueHeartbeat=%s blockedBacklog=%d elapsed=%s maxPending=%d queueCapacity=%d workers=%d heapDelta=%dKB",
		ruleCount,
		heartbeatElapsed.Round(time.Millisecond),
		blockedBacklog,
		elapsed.Round(time.Millisecond),
		maxPending,
		actionQueueCapacity,
		actionWorkerConcurrency,
		int64(after.Alloc-before.Alloc)/1024,
	)
}

func assertManagedRuntimeLogRegression(t *testing.T, ruleCount int) {
	t.Helper()
	const basePort = 10000

	// Reproduce the exact owner spelling emitted by Linux ss in the supplied
	// logs. Linux truncates forwardx-runtime to forwardx-runtim, which used to
	// make every TCP+UDP listener wait about 13 seconds and report a false error.
	var ssOutput strings.Builder
	services := make([]map[string]any, 0, ruleCount*2)
	for i := 0; i < ruleCount; i++ {
		port := basePort + i
		pid := 2250000 + i
		fmt.Fprintf(&ssOutput, "udp UNCONN 0 0 *:%d *:* users:((\"forwardx-runtim\",pid=%d,fd=8))\n", port, pid)
		fmt.Fprintf(&ssOutput, "tcp LISTEN 0 4096 *:%d *:* users:((\"forwardx-runtim\",pid=%d,fd=7))\n", port, pid)
		services = append(services,
			map[string]any{"addr": fmt.Sprintf(":%d", port), "listener": map[string]any{"type": "tcp"}},
			map[string]any{"addr": fmt.Sprintf(":%d", port), "listener": map[string]any{"type": "udp"}},
		)
	}

	snapshot := &runtimeListenSnapshot{
		tcpPorts: map[int][]string{},
		udpPorts: map[int][]string{},
	}
	started := time.Now()
	snapshot.parseSSListenOutput(ssOutput.String())
	for i := 0; i < ruleCount; i++ {
		port := basePort + i
		if !runtimeListenPortReady(snapshot, port, "both", []string{"gost", "forwardx-runt"}) {
			t.Fatalf("log regression: truncated forwardx-runtime owner rejected for port %d", port)
		}
	}
	listenerCheckElapsed := time.Since(started)

	// The second failure in the logs stopped the shared forwardx-runtime after
	// seeing an occupied port. Verify ownership against a realistically large
	// runtime config, including the two reported ports 10002 and 10007.
	rawConfig, err := json.Marshal(map[string]any{"services": services})
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(t.TempDir(), "gost.json")
	if err := os.WriteFile(configPath, rawConfig, 0600); err != nil {
		t.Fatal(err)
	}
	for _, port := range []int{10002, 10007, basePort + ruleCount - 1} {
		if !sharedManagedRuntimeOwnsPort(configPath, port) {
			t.Fatalf("log regression: shared runtime ownership missing for port %d", port)
		}
	}
	if sharedManagedRuntimeOwnsPort(configPath, basePort+ruleCount) {
		t.Fatalf("unexpected shared runtime ownership for unconfigured port %d", basePort+ruleCount)
	}

	t.Logf("log regression listeners=%d protocols=%d owner=forwardx-runtim check=%s sharedRuntimePorts=verified",
		ruleCount,
		ruleCount*2,
		listenerCheckElapsed.Round(time.Millisecond),
	)
}

func assertActionStatusBurstDoesNotBlock(t *testing.T, ruleCount int) {
	t.Helper()
	resetActionStatusReportsForTest()
	defer resetActionStatusReportsForTest()

	var requests atomic.Int64
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		time.Sleep(300 * time.Millisecond)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer panel.Close()

	cfg := Config{PanelURL: panel.URL}
	started := time.Now()
	for i := 0; i < ruleCount; i++ {
		a := action{
			StatusType:  "rule",
			RuleID:      i + 1,
			SourcePort:  10000 + i,
			ForwardType: "gost",
			Protocol:    "both",
		}
		reportActionStatus(cfg, a, false, "managed runtime listener not ready after apply")
		reportActionStatus(cfg, a, true, "")
	}
	queueElapsed := time.Since(started)
	if queueElapsed > 2*time.Second {
		t.Fatalf("queueing %d repeated rule statuses blocked for %s", ruleCount, queueElapsed)
	}
	if requests.Load() != 0 {
		t.Fatalf("status burst made %d synchronous panel requests", requests.Load())
	}
	if pending := pendingActionStatusReportCount(); pending != ruleCount {
		t.Fatalf("coalesced status count = %d, want %d", pending, ruleCount)
	}

	total := 0
	batches := 0
	for {
		reports := takeActionStatusReports(actionStatusBatchSize)
		if len(reports) == 0 {
			break
		}
		batches++
		total += len(reports)
		if len(reports) > actionStatusBatchSize {
			t.Fatalf("status batch size = %d, max %d", len(reports), actionStatusBatchSize)
		}
		for _, report := range reports {
			if !report.payload.IsRunning || report.payload.Message != "" {
				t.Fatalf("latest recovered status was not retained: %+v", report.payload)
			}
		}
	}
	wantBatches := (ruleCount + actionStatusBatchSize - 1) / actionStatusBatchSize
	if total != ruleCount || batches != wantBatches {
		t.Fatalf("status batches = %d/%d reports = %d/%d", batches, wantBatches, total, ruleCount)
	}

	t.Logf("log regression statuses=%d repeatedUpdates=%d queued=%s batches=%d panelLatency=300ms synchronousRequests=0",
		ruleCount,
		ruleCount*2,
		queueElapsed.Round(time.Millisecond),
		batches,
	)
}

// TestRestoreActionStatusReportsPerf 验证 restoreActionStatusReports 在大批量
// 失败重试下的时间复杂度为 O(N) 而非原先的 O(N²)。
// 每次 restoreActionStatusReports(100条) 在 3000 条现有队列头部插入，
// 原先实现每轮产生 ~100×3000 = 300,000 次内存拷贝；修复后只需 1 次。
func TestRestoreActionStatusReportsPerf(t *testing.T) {
	resetActionStatusReportsForTest()
	t.Cleanup(resetActionStatusReportsForTest)

	const queueDepth = 3000 // 现有队列长度（模拟积压状态）
	const batchSize = 100   // 每次重试恢复的报告数
	const iterations = 20   // 重复失败+恢复的次数

	cfg := Config{PanelURL: "https://panel.example.test", Token: "test"}

	// 预填充 queueDepth 条已有状态报告
	for i := 0; i < queueDepth; i++ {
		a := action{StatusType: "rule", RuleID: i + 1, SourcePort: 10000 + i, ForwardType: "gost"}
		enqueueActionStatusReport(cfg, a, true, "")
	}

	// 构造一批需要恢复的报告（使用不同 key 避免与现有队列重叠）
	failedReports := make([]actionStatusReport, batchSize)
	for i := range failedReports {
		key := fmt.Sprintf("rule:%d:0:%d:gost-failed", queueDepth+i+1, 20000+i)
		failedReports[i] = actionStatusReport{
			key: key,
			cfg: cfg,
			payload: actionStatusPayload{
				StatusType:  "rule",
				RuleID:      queueDepth + i + 1,
				SourcePort:  20000 + i,
				ForwardType: "gost",
				IsRunning:   false,
			},
		}
	}

	started := time.Now()
	for i := 0; i < iterations; i++ {
		// 每次重新加入（先从 map 中清除，以允许重复 restore）
		actionStatusReportsMu.Lock()
		for _, r := range failedReports {
			delete(actionStatusReports, r.key)
		}
		actionStatusReportsMu.Unlock()
		restoreActionStatusReports(failedReports)
	}
	elapsed := time.Since(started)

	// O(N²) 实现在此场景约需 >1s；O(N) 实现应在 10ms 以内。
	const maxAllowed = 200 * time.Millisecond
	if elapsed > maxAllowed {
		t.Fatalf("restoreActionStatusReports x%d iterations took %s (limit %s); likely O(N²) regression",
			iterations, elapsed.Round(time.Millisecond), maxAllowed)
	}
	t.Logf("restoreActionStatusReports perf: queueDepth=%d batchSize=%d iterations=%d elapsed=%s",
		queueDepth, batchSize, iterations, elapsed.Round(time.Millisecond))
}

func resetAgentStressState() {
	actionIngress.reset()
	for {
		select {
		case <-actionIngressWakeCh:
			continue
		default:
			goto ingressDrained
		}
	}

ingressDrained:
	actionQueue = make(chan actionJob, actionQueueCapacity)
	atomic.StoreInt64(&actionPendingCount, 0)

	queuedActionMu.Lock()
	queuedActionKeys = map[string]int64{}
	queuedActionMu.Unlock()

	actionEpochMu.Lock()
	latestActionIssuedAt = map[string]int64{}
	actionEpochMu.Unlock()

	protectedActionPortMu.Lock()
	protectedActionPorts = map[string]int{}
	protectedActionPortMu.Unlock()

	rememberDesiredRunningRules(nil)

	actionSerialMu.Lock()
	actionSerialLocks = map[string]*actionSerialLock{}
	actionSerialMu.Unlock()

	// 清空 desiredActionRecords 内存缓存，防止跨测试用例残留。
	desiredActionRecordMu.Lock()
	desiredActionRecordsMem = map[string]desiredActionRecord{}
	desiredActionRecordsLoaded = true
	desiredActionRecordsRevision = 0
	desiredActionRecordsDirty.Store(false)
	desiredActionRecordMu.Unlock()

	agentReportLogMu.Lock()
	agentReportLogAt = map[string]time.Time{}
	agentReportLogMu.Unlock()

	publicIPMu.Lock()
	publicIPv4Cache = "198.51.100.10"
	publicIPv6Cache = "2001:db8::10"
	publicIPCheckedAt = time.Now()
	publicIPMu.Unlock()

	lastTrafficCollectAt = time.Now()
	nextTrafficCollectInterval = time.Hour
	lastTCPingAt = time.Now()
	heartbeatStaticReport = heartbeatStaticSnapshot{ReportedAt: time.Now(), Initialized: true}
	heartbeatStateMu.Lock()
	heartbeatStateCache = heartbeatStateSnapshot{}
	heartbeatStateSignatures = map[string]string{}
	heartbeatStateMu.Unlock()

	dnsWatchMu.Lock()
	dnsWatchSnapshot = map[string][]string{}
	dnsWatchCandidates = map[string]dnsWatchCandidate{}
	dnsWatchRetiredSnapshots = map[string]dnsWatchRetiredSnapshot{}
	pendingDNSChanges = nil
	dnsWatchMu.Unlock()
}

func buildStressActions(count int) []action {
	reportStatus := false
	baseIssuedAt := time.Now().UnixMilli()
	actions := make([]action, 0, count)
	for i := 0; i < count; i++ {
		port := 20000 + i
		if i%97 == 0 {
			port = 21000 + (i % 25)
		}
		a := action{
			StatusType:   "rule",
			RuleID:       i + 1,
			IssuedAt:     baseIssuedAt + int64(i),
			Op:           "apply",
			ForwardType:  "stress-mock",
			SourcePort:   port,
			TargetIP:     fmt.Sprintf("10.%d.%d.%d", (i/65536)%255, (i/256)%255, i%255),
			TargetPort:   10000 + (i % 1000),
			Protocol:     "tcp",
			ReportStatus: &reportStatus,
		}
		switch {
		case i%223 == 0 && i > 0:
			a.SourcePort = 20000 + (i - 1)
			a.IssuedAt = baseIssuedAt - int64(i)
		case i%211 == 0:
			a.ForwardType = ""
		case i%199 == 0:
			a.RuleID = 0
		case i%191 == 0:
			a.StatusType = ""
		case i%181 == 0:
			a.Op = "unknown-op"
		case i%173 == 0:
			a.Op = "remove"
		case i%163 == 0:
			a.TargetPort = 0
		case i%149 == 0:
			a.TargetIP = ""
		case i%137 == 0:
			a.Protocol = ""
		case i%131 == 0:
			a.SourcePort = 70000 + i
		case i%127 == 0:
			a.SourcePort = -i
		case i%113 == 0:
			a.SourcePort = 0
		}
		actions = append(actions, a)
	}
	return actions
}

func waitForStressActionsDrained(timeout time.Duration) (int64, error) {
	deadline := time.Now().Add(timeout)
	var maxPending int64
	for {
		pending := atomic.LoadInt64(&actionPendingCount)
		if pending > maxPending {
			maxPending = pending
		}
		if pending == 0 && len(actionQueue) == 0 && actionIngress.len() == 0 {
			return maxPending, nil
		}
		if time.Now().After(deadline) {
			return maxPending, fmt.Errorf("timed out waiting for actions to drain: pending=%d queued=%d ingress=%d protectedPorts=%d", pending, len(actionQueue), actionIngress.len(), countProtectedActionPorts())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func countProtectedActionPorts() int {
	protectedActionPortMu.Lock()
	defer protectedActionPortMu.Unlock()
	return len(protectedActionPorts)
}
