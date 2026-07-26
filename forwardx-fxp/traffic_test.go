package main

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func resetTrafficBatchesForTest() {
	trafficBatchMu.Lock()
	trafficBatches = map[trafficBatchKey]map[int]trafficBatchValue{}
	trafficPendingReports = map[trafficBatchKey]pendingTrafficBatch{}
	trafficBatchMu.Unlock()
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
	enqueueTraffic(cfg, 100, 200)
	enqueueTraffic(cfg, 7, 11)
	flushTrafficBatches()
	snapshot := trafficBatchSnapshot()
	key := trafficBatchKey{panelURL: server.URL, token: cfg.Token, producerID: fxpTrafficProducerID(cfg)}
	if got := snapshot[key][42]; got.bytesIn != 107 || got.bytesOut != 211 {
		t.Fatalf("failed report was not retained: %+v", got)
	}

	// Bytes arriving after a failed request must not expand that in-flight
	// request. The original report ID is retried first; new bytes form the next
	// report only after it is acknowledged.
	enqueueTraffic(cfg, 13, 17)
	retrySnapshot := trafficBatchPendingSnapshot()[key]
	pending := retrySnapshot.byRule[42]
	if pending.bytesIn != 107 || pending.bytesOut != 211 {
		t.Fatalf("pending retry changed after new traffic: %+v", pending)
	}
	if retrySnapshot.reportID == "" {
		t.Fatal("pending retry has no report id")
	}

	fail.Store(false)
	flushTrafficBatches()
	remaining := trafficBatchSnapshot()[key][42]
	if remaining.bytesIn != 13 || remaining.bytesOut != 17 {
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
