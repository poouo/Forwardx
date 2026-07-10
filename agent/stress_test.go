package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
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

func TestAgentStress3000RuleHeartbeat(t *testing.T) {
	if os.Getenv("FORWARDX_AGENT_STRESS") != "1" {
		t.Skip("set FORWARDX_AGENT_STRESS=1 to run the 3000-rule Agent stress test")
	}

	resetAgentStressState()
	stressWorkersOnce.Do(func() {
		actionWorker()
	})

	const ruleCount = 3000
	token := "stress-token"
	actions := buildStressActions(ruleCount)
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
	nextInterval, err := heartbeat(Config{PanelURL: panel.URL, Token: token, Interval: 30})
	if err != nil {
		t.Fatalf("heartbeat failed: %v", err)
	}
	if nextInterval != 30 {
		t.Fatalf("nextInterval = %d, want 30", nextInterval)
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

	t.Logf("stress rules=%d elapsed=%s maxPending=%d queueCapacity=%d workers=%d heapDelta=%dKB",
		ruleCount,
		elapsed.Round(time.Millisecond),
		maxPending,
		actionQueueCapacity,
		actionWorkerConcurrency,
		int64(after.Alloc-before.Alloc)/1024,
	)
}

func resetAgentStressState() {
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
		if pending == 0 && len(actionQueue) == 0 {
			return maxPending, nil
		}
		if time.Now().After(deadline) {
			return maxPending, fmt.Errorf("timed out waiting for actions to drain: pending=%d queued=%d protectedPorts=%d", pending, len(actionQueue), countProtectedActionPorts())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func countProtectedActionPorts() int {
	protectedActionPortMu.Lock()
	defer protectedActionPortMu.Unlock()
	return len(protectedActionPorts)
}
