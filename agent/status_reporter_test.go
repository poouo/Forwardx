package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestActionStatusBatchUnsupportedByOlderPanelTunnel(t *testing.T) {
	if !actionStatusBatchUnsupported(fmt.Errorf("400 Bad Request: Invalid encrypted request")) {
		t.Fatal("older panel encrypted tunnel rejection should trigger single-status fallback")
	}
}

func resetActionStatusReportsForTest() {
	actionStatusReportsMu.Lock()
	actionStatusReports = map[string]actionStatusReport{}
	actionStatusReportOrder = nil
	actionStatusReportsMu.Unlock()
	for {
		select {
		case <-actionStatusReporterWake:
		default:
			return
		}
	}
}

func TestActionStatusReportsCoalesceLatestRuleState(t *testing.T) {
	resetActionStatusReportsForTest()
	a := action{StatusType: "rule", RuleID: 42, SourcePort: 10042, ForwardType: "gost"}
	enqueueActionStatusReport(Config{}, a, false, "starting")
	enqueueActionStatusReport(Config{}, a, true, "")

	reports := takeActionStatusReports(actionStatusBatchSize)
	if len(reports) != 1 {
		t.Fatalf("reports = %d, want 1", len(reports))
	}
	if !reports[0].payload.IsRunning || reports[0].payload.Message != "" {
		t.Fatalf("latest rule status was not retained: %+v", reports[0].payload)
	}
}

func TestActionStatusReportsSplitAtBatchSize(t *testing.T) {
	resetActionStatusReportsForTest()
	var requests atomic.Int64
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		time.Sleep(300 * time.Millisecond)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer panel.Close()

	started := time.Now()
	for i := 1; i <= 500; i++ {
		reportActionStatus(Config{PanelURL: panel.URL}, action{StatusType: "rule", RuleID: i}, true, "")
	}
	if elapsed := time.Since(started); elapsed > 250*time.Millisecond {
		t.Fatalf("queueing 500 statuses blocked actions for %s", elapsed)
	}
	if requests.Load() != 0 {
		t.Fatalf("status reporting performed synchronous HTTP requests")
	}
	if got := len(takeActionStatusReports(actionStatusBatchSize)); got != actionStatusBatchSize {
		t.Fatalf("first batch = %d, want %d", got, actionStatusBatchSize)
	}
	if got := len(takeActionStatusReports(actionStatusBatchSize)); got != actionStatusBatchSize {
		t.Fatalf("second batch = %d, want %d", got, actionStatusBatchSize)
	}
	if got := len(takeActionStatusReports(actionStatusBatchSize)); got != 100 {
		t.Fatalf("third batch = %d, want 100", got)
	}
}

func TestActionStatusRequeueKeepsNewerState(t *testing.T) {
	resetActionStatusReportsForTest()
	a := action{StatusType: "rule", RuleID: 7}
	enqueueActionStatusReport(Config{}, a, false, "old")
	old := takeActionStatusReports(1)
	enqueueActionStatusReport(Config{}, a, true, "new")
	requeueActionStatusReports(old)

	reports := takeActionStatusReports(1)
	if len(reports) != 1 || !reports[0].payload.IsRunning || reports[0].payload.Message != "new" {
		t.Fatalf("newer queued state was overwritten: %+v", reports)
	}
}

func TestSendActionStatusBatchUsesSingleDelayedRequest(t *testing.T) {
	const token = "status-batch-token"
	var requests atomic.Int64
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		var env envelope
		if err := json.NewDecoder(r.Body).Decode(&env); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		plain, err := decrypt(env, token)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		var request struct {
			Path    string `json:"path"`
			Payload struct {
				Statuses []actionStatusPayload `json:"statuses"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(plain, &request); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if request.Path != "/api/agent/rule-status-batch" || len(request.Payload.Statuses) != actionStatusBatchSize {
			http.Error(w, "unexpected batch payload", http.StatusBadRequest)
			return
		}
		time.Sleep(300 * time.Millisecond)
		response, err := encrypt(map[string]any{"success": true}, token)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(response)
	}))
	defer panel.Close()

	reports := make([]queuedActionStatusReport, 0, actionStatusBatchSize)
	for i := 1; i <= actionStatusBatchSize; i++ {
		payload := actionStatusPayload{RuleID: i, StatusType: "rule", IsRunning: true}
		reports = append(reports, queuedActionStatusReport{
			cfg:     Config{PanelURL: panel.URL, Token: token},
			key:     actionStatusReportKey(payload),
			payload: payload,
		})
	}
	started := time.Now()
	if err := sendActionStatusReports(reports); err != nil {
		t.Fatalf("sendActionStatusReports() error = %v", err)
	}
	elapsed := time.Since(started)
	if requests.Load() != 1 {
		t.Fatalf("batch requests = %d, want 1", requests.Load())
	}
	if elapsed < 250*time.Millisecond || elapsed > 2*time.Second {
		t.Fatalf("delayed batch duration = %s, want about 300ms", elapsed)
	}
}
