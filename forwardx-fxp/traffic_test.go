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
	key := trafficBatchKey{panelURL: server.URL, token: cfg.Token}
	if got := snapshot[key][42]; got.bytesIn != 107 || got.bytesOut != 211 {
		t.Fatalf("failed report was not retained: %+v", got)
	}

	fail.Store(false)
	flushTrafficBatches()
	if snapshot := trafficBatchSnapshot(); len(snapshot) != 0 {
		t.Fatalf("successful report was not acknowledged: %#v", snapshot)
	}
}
