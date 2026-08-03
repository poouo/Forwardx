package main

import (
	"bytes"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func resetTrafficBatchesForTest() {
	trafficBatchMu.Lock()
	trafficBatches = map[trafficBatchKey]map[int]trafficBatchValue{}
	trafficPendingReports = map[trafficBatchKey]pendingTrafficBatch{}
	trafficBatchMu.Unlock()
	trafficDiagnostics.Lock()
	trafficDiagnostics.last = make(map[string]time.Time)
	trafficDiagnostics.Unlock()
}

func TestTrafficBatchRetainsFailedReportsAndAcknowledgesSuccess(t *testing.T) {
	resetTrafficBatchesForTest()
	var fail atomic.Bool
	fail.Store(true)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if fail.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	cfg := config{PanelURL: server.URL, Token: "traffic-test-token", RuleID: 42}
	enqueueTraffic(cfg, 100, 200, 1)
	enqueueTraffic(cfg, 7, 11, 2)
	flushTrafficBatches()
	snapshot := trafficBatchSnapshot()
	key := trafficBatchKey{panelURL: server.URL, token: cfg.Token, producerID: fxpTrafficProducerID(cfg)}
	if got := snapshot[key][42]; got.bytesIn != 107 || got.bytesOut != 211 || got.connections != 3 {
		t.Fatalf("failed report was not retained: %+v", got)
	}
	firstPending := trafficBatchPendingSnapshot()[key]
	flushTrafficBatches()
	retried := trafficBatchPendingSnapshot()[key]
	if retried.reportID == "" || retried.reportID != firstPending.reportID {
		t.Fatalf("failed report retry changed report id: %q -> %q", firstPending.reportID, retried.reportID)
	}
	if got := retried.byRule[42]; got.bytesIn != 107 || got.bytesOut != 211 || got.connections != 3 {
		t.Fatalf("failed retry duplicated or dropped traffic: %+v", got)
	}
	if got := trafficBatchSnapshot()[key][42]; got.bytesIn != 107 || got.bytesOut != 211 || got.connections != 3 {
		t.Fatalf("failed retry changed queued totals: %+v", got)
	}

	// Bytes arriving after a failed request must not expand that in-flight
	// request. The original report ID is retried first; new bytes form the next
	// report only after it is acknowledged.
	enqueueTraffic(cfg, 13, 17, 4)
	retrySnapshot := trafficBatchPendingSnapshot()[key]
	pending := retrySnapshot.byRule[42]
	if pending.bytesIn != 107 || pending.bytesOut != 211 || pending.connections != 3 {
		t.Fatalf("pending retry changed after new traffic: %+v", pending)
	}
	if retrySnapshot.reportID == "" {
		t.Fatal("pending retry has no report id")
	}

	fail.Store(false)
	flushTrafficBatches()
	remaining := trafficBatchSnapshot()[key][42]
	if remaining.bytesIn != 13 || remaining.bytesOut != 17 || remaining.connections != 4 {
		t.Fatalf("new traffic was not retained for the next report: %+v", remaining)
	}
	if len(trafficPendingReports) != 0 {
		t.Fatalf("acknowledged pending report was not cleared: %#v", trafficPendingReports)
	}
	flushTrafficBatches()
	if snapshot := trafficBatchSnapshot(); len(snapshot) != 0 {
		t.Fatalf("second successful report was not acknowledged: %#v", snapshot)
	}
}

func TestTrafficConfigurationDiagnosticsAreRateLimitedAndDoNotLeakToken(t *testing.T) {
	resetTrafficBatchesForTest()
	t.Cleanup(resetTrafficBatchesForTest)
	var output bytes.Buffer
	previousWriter := log.Writer()
	log.SetOutput(&output)
	t.Cleanup(func() { log.SetOutput(previousWriter) })

	const secret = "traffic-diagnostic-secret"
	cases := []config{
		{Role: "entry", TunnelID: 10, RuleID: 40, ListenPort: 10040, Token: secret},
		{Role: "entry", TunnelID: 11, RuleID: 41, ListenPort: 10041, PanelURL: "https://panel.example.test"},
		{Role: "entry", TunnelID: 12, ListenPort: 10042, PanelURL: "https://panel.example.test", Token: secret},
	}
	for _, cfg := range cases {
		enqueueTraffic(cfg, 1, 2, 3)
		enqueueTraffic(cfg, 1, 2, 3)
	}

	logs := output.String()
	for _, missing := range []string{"panelUrl", "token", "ruleId"} {
		if !strings.Contains(logs, "missing="+missing) {
			t.Fatalf("missing %s diagnostic in logs: %q", missing, logs)
		}
	}
	if got := strings.Count(logs, "traffic report skipped"); got != len(cases) {
		t.Fatalf("configuration diagnostics were not rate limited: count=%d logs=%q", got, logs)
	}
	if strings.Contains(logs, secret) {
		t.Fatalf("traffic diagnostic leaked token: %q", logs)
	}
	if snapshot := trafficBatchSnapshot(); len(snapshot) != 0 {
		t.Fatalf("invalid traffic configuration created a batch: %#v", snapshot)
	}
}

func TestTrafficReportFailureDiagnosticsAreRateLimitedAndRedacted(t *testing.T) {
	resetTrafficBatchesForTest()
	t.Cleanup(resetTrafficBatchesForTest)
	var output bytes.Buffer
	previousWriter := log.Writer()
	log.SetOutput(&output)
	t.Cleanup(func() { log.SetOutput(previousWriter) })

	const secret = "traffic-report-secret"
	if got := safeTrafficReportError(errors.New("request rejected token="+secret), secret); strings.Contains(got, secret) || !strings.Contains(got, "[redacted]") {
		t.Fatalf("traffic report error was not redacted: %q", got)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()

	cfg := config{PanelURL: server.URL, Token: secret, RuleID: 42}
	key := trafficBatchKey{panelURL: server.URL, token: cfg.Token, producerID: fxpTrafficProducerID(cfg)}
	enqueueTraffic(cfg, 13, 17, 2)
	flushTrafficBatches()
	first := trafficBatchPendingSnapshot()[key]
	flushTrafficBatches()
	second := trafficBatchPendingSnapshot()[key]

	if first.reportID == "" || second.reportID != first.reportID {
		t.Fatalf("failed status retry changed report id: %q -> %q", first.reportID, second.reportID)
	}
	if got := second.byRule[42]; got.bytesIn != 13 || got.bytesOut != 17 || got.connections != 2 {
		t.Fatalf("failed status retry changed pending traffic: %+v", got)
	}
	logs := output.String()
	if got := strings.Count(logs, "traffic batch report rejected"); got != 1 {
		t.Fatalf("report failure diagnostic was not rate limited: count=%d logs=%q", got, logs)
	}
	if !strings.Contains(logs, "firstRule=42") || !strings.Contains(logs, "status=503") {
		t.Fatalf("report failure diagnostic lacks context: %q", logs)
	}
	if strings.Contains(logs, secret) {
		t.Fatalf("report failure diagnostic leaked token: %q", logs)
	}
}

func TestTrafficRequestFailureRetainsBatchAndIsRateLimited(t *testing.T) {
	resetTrafficBatchesForTest()
	t.Cleanup(resetTrafficBatchesForTest)
	var output bytes.Buffer
	previousWriter := log.Writer()
	log.SetOutput(&output)
	t.Cleanup(func() { log.SetOutput(previousWriter) })

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Errorf("hijack traffic request: %v", err)
			return
		}
		_ = conn.Close()
	}))
	defer server.Close()

	const secret = "traffic-request-secret"
	cfg := config{PanelURL: server.URL, Token: secret, RuleID: 43}
	key := trafficBatchKey{panelURL: server.URL, token: cfg.Token, producerID: fxpTrafficProducerID(cfg)}
	enqueueTraffic(cfg, 19, 23, 4)
	flushTrafficBatches()
	first := trafficBatchPendingSnapshot()[key]
	flushTrafficBatches()
	second := trafficBatchPendingSnapshot()[key]

	if first.reportID == "" || second.reportID != first.reportID {
		t.Fatalf("request retry changed report id: %q -> %q", first.reportID, second.reportID)
	}
	if got := second.byRule[43]; got.bytesIn != 19 || got.bytesOut != 23 || got.connections != 4 {
		t.Fatalf("request retry changed pending traffic: %+v", got)
	}
	logs := output.String()
	if got := strings.Count(logs, "traffic batch report request failed"); got != 1 {
		t.Fatalf("request failure diagnostic was not rate limited: count=%d logs=%q", got, logs)
	}
	if !strings.Contains(logs, "firstRule=43") {
		t.Fatalf("request failure diagnostic lacks rule context: %q", logs)
	}
	if strings.Contains(logs, secret) {
		t.Fatalf("request failure diagnostic leaked token: %q", logs)
	}
}

func TestEqualTrafficBatchesUseDifferentReportIDs(t *testing.T) {
	resetTrafficBatchesForTest()
	cfg := config{PanelURL: "http://panel.invalid", Token: "traffic-test-token", RuleID: 42}
	key := trafficBatchKey{panelURL: cfg.PanelURL, token: cfg.Token, producerID: fxpTrafficProducerID(cfg)}
	enqueueTraffic(cfg, 100, 200)
	first := trafficBatchPendingSnapshot()[key]
	acknowledgeTrafficBatch(key, first.byRule)

	enqueueTraffic(cfg, 100, 200)
	second := trafficBatchPendingSnapshot()[key]
	if first.reportID == "" || second.reportID == "" || first.reportID == second.reportID {
		t.Fatalf("equal traffic batches must have distinct report ids: %q %q", first.reportID, second.reportID)
	}
}

func TestTrafficBatchKeepsConnectionOnlyDelta(t *testing.T) {
	resetTrafficBatchesForTest()
	t.Cleanup(resetTrafficBatchesForTest)
	cfg := config{PanelURL: "http://panel.invalid", Token: "traffic-test-token", RuleID: 42}
	key := trafficBatchKey{panelURL: cfg.PanelURL, token: cfg.Token, producerID: fxpTrafficProducerID(cfg)}

	// A connection can be established before its first payload arrives. The
	// report must still be queued instead of being dropped as an empty batch.
	enqueueTraffic(cfg, 0, 0, 1)
	pending := trafficBatchPendingSnapshot()[key]
	if got := pending.byRule[42]; got.connections != 1 || got.bytesIn != 0 || got.bytesOut != 0 {
		t.Fatalf("connection-only traffic was not retained: %+v", got)
	}
}

func TestTrafficReporterCountsSessionOnceWithoutChangingBytes(t *testing.T) {
	resetTrafficBatchesForTest()
	t.Cleanup(resetTrafficBatchesForTest)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()

	cfg := config{PanelURL: server.URL, Token: "traffic-test-token", RuleID: 42}
	key := trafficBatchKey{panelURL: server.URL, token: cfg.Token, producerID: fxpTrafficProducerID(cfg)}
	counter := &trafficCounter{}
	counter.in.Store(123)
	counter.out.Store(456)
	counter.connections.Store(1)
	stopReporting := startTrafficReporter(cfg, counter)
	stopReporting()
	stopReporting()

	got := trafficBatchSnapshot()[key][42]
	if got.bytesIn != 123 || got.bytesOut != 456 || got.connections != 1 {
		t.Fatalf("session report changed byte totals or duplicated the connection: %+v", got)
	}
}

func TestFXPTrafficProducerIDIsStablePerRuntime(t *testing.T) {
	base := config{
		PanelURL: "https://panel.example.test/", Token: "token-a", Role: "entry",
		TunnelID: 7, RuleID: 42, ListenPort: 22022,
	}
	first := fxpTrafficProducerID(base)
	base.PanelURL = "https://panel.example.test"
	if second := fxpTrafficProducerID(base); first != second {
		t.Fatalf("normalized runtime producer changed: %q %q", first, second)
	}
	base.RuleID++
	if other := fxpTrafficProducerID(base); first == other {
		t.Fatalf("different FXP runtimes share producer id %q", first)
	}
}

func TestStopTrafficReporterDoesNotWaitForPanel(t *testing.T) {
	resetTrafficBatchesForTest()
	requestStarted := make(chan struct{})
	releaseRequest := make(chan struct{})
	var startedOnce sync.Once
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		startedOnce.Do(func() { close(requestStarted) })
		<-releaseRequest
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()

	counter := &trafficCounter{}
	counter.in.Store(123)
	counter.out.Store(456)
	stopReporting := startTrafficReporter(config{
		PanelURL: server.URL,
		Token:    "traffic-test-token",
		RuleID:   42,
	}, counter)
	stopReturned := make(chan struct{})
	go func() {
		stopReporting()
		close(stopReturned)
	}()

	select {
	case <-stopReturned:
	case <-time.After(250 * time.Millisecond):
		close(releaseRequest)
		<-stopReturned
		t.Fatal("stopping traffic reporter waited for the panel request")
	}
	select {
	case <-requestStarted:
	case <-time.After(2 * time.Second):
		close(releaseRequest)
		t.Fatal("stopping traffic reporter did not wake the batch worker")
	}
	close(releaseRequest)
	trafficBatchFlushMu.Lock()
	trafficBatchFlushMu.Unlock()
}
