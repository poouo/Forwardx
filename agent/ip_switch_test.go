package main

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func sampleIPSwitchTask() ipSwitchTask {
	return ipSwitchTask{TaskID: "12345678-1234-4234-8234-123456789012", ServiceID: 1, ExpiresAt: 1060, Request: ipSwitchRequest{
		URL: "http://10.0.0.1/api/changeip?token=secret", Method: "GET", SuccessMode: "http", TimeoutSeconds: 5,
	}}
}
func TestIPSwitchDestinations(t *testing.T) {
	for _, ip := range []string{"10.0.0.1", "172.16.0.1", "192.168.1.1", "fd00::1", "8.8.8.8", "2606:4700:4700::1111"} {
		if !allowedIPSwitchIP(net.ParseIP(ip)) {
			t.Errorf("vendor address rejected: %s", ip)
		}
	}
	for _, ip := range []string{"127.0.0.1", "::1", "169.254.169.254", "fe80::1", "0.0.0.0", "::", "224.0.0.1", "100.100.100.200", "::ffff:127.0.0.1"} {
		if allowedIPSwitchIP(net.ParseIP(ip)) {
			t.Errorf("restricted address accepted: %s", ip)
		}
	}
	for _, address := range []string{"file:///tmp/config", "http://127.0.0.1/x", "https://user:pass@example.com/x", "http://10.0.0.1/x#secret"} {
		r := sampleIPSwitchTask().Request
		r.URL = address
		if validateIPSwitchRequest(r) {
			t.Errorf("invalid URL accepted: %s", address)
		}
	}
	client := newIPSwitchClient(time.Second)
	defer client.CloseIdleConnections()
	if client.Transport.(*http.Transport).Proxy != nil {
		t.Fatal("must not inherit system proxy")
	}
	response, err := client.Get("http://localhost:1/test")
	if response != nil {
		response.Body.Close()
	}
	if err == nil {
		t.Fatal("DNS-resolved loopback must be blocked")
	}
}
func TestIPSwitchDurableSingleExecution(t *testing.T) {
	dir := t.TempDir()
	task := sampleIPSwitchTask()
	claims, calls := 0, 0
	claim := func() bool { claims++; return true }
	execute := func(task ipSwitchTask) ipSwitchResult {
		calls++
		return ipSwitchResult{TaskID: task.TaskID, Outcome: "accepted", Reason: "ok"}
	}
	first := runIPSwitchTask(task, dir, func() int64 { return 1000 }, claim, execute)
	second := runIPSwitchTask(task, dir, func() int64 { return 1001 }, claim, execute)
	if first.Outcome != "accepted" || second.Reason != "duplicate" || claims != 1 || calls != 1 {
		t.Fatalf("replayed action: %v %v %d %d", first, second, claims, calls)
	}
	body, err := os.ReadFile(filepath.Join(dir, task.TaskID))
	if err != nil || len(body) != 0 {
		t.Fatal("marker must exist and contain no credentials")
	}
	// A lost claim response must not trigger vendor requests or a later retry.
	dir = t.TempDir()
	denied := runIPSwitchTask(task, dir, func() int64 { return 1000 }, func() bool { return false }, execute)
	retry := runIPSwitchTask(task, dir, func() int64 { return 1000 }, claim, execute)
	if denied.Reason != "claim_denied" || retry.Reason != "duplicate" || calls != 1 {
		t.Fatal("claim failure retried")
	}
	if runIPSwitchTask(task, t.TempDir(), func() int64 { return 2000 }, claim, execute).Reason != "expired" {
		t.Fatal("expired action ran")
	}
	task.TaskID = "../escape"
	if runIPSwitchTask(task, t.TempDir(), func() int64 { return 1000 }, claim, execute).Reason != "invalid_request" {
		t.Fatal("invalid task ID accepted")
	}
}

type ipSwitchRoundTrip func(*http.Request) (*http.Response, error)

func (f ipSwitchRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func mockIPSwitchClient(status int, body string) *http.Client {
	return &http.Client{Transport: ipSwitchRoundTrip(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})}
}
func TestIPSwitchResponseValidation(t *testing.T) {
	task := sampleIPSwitchTask()
	if result := executeIPSwitchRequest(task, mockIPSwitchClient(204, "")); result.Outcome != "accepted" {
		t.Fatal(result)
	}
	task.Request.SuccessMode, task.Request.SuccessPath, task.Request.SuccessValue = "json", "data.success", true
	for _, tc := range []struct {
		status                int
		body, outcome, reason string
	}{
		{200, `{"data":{"success":true}}`, "verified", "ok"},
		{200, `{"data":{"success":"true"}}`, "uncertain", "success_mismatch"},
		{200, `{"data":{"success":false}}`, "uncertain", "success_mismatch"},
		{200, `{"data":{}}`, "uncertain", "success_mismatch"},
		{200, "not json", "uncertain", "invalid_response"},
		{200, strings.Repeat("x", 65537), "uncertain", "invalid_response"},
		{500, "secret-echo", "uncertain", "http_status"},
		{302, "secret-echo", "uncertain", "http_status"},
	} {
		result := executeIPSwitchRequest(task, mockIPSwitchClient(tc.status, tc.body))
		if result.Outcome != tc.outcome || result.Reason != tc.reason {
			t.Fatalf("unexpected result: %+v", result)
		}
		encoded, _ := json.Marshal(result)
		if strings.Contains(string(encoded), "secret") {
			t.Fatal("provider content leaked")
		}
	}
	task.Request.IPPath = "data.ip"
	result := executeIPSwitchRequest(task, mockIPSwitchClient(200, `{"data":{"success":true,"ip":"10.0.0.1"}}`))
	if result.Reason != "invalid_ip" || result.NewIP != "" {
		t.Fatal("private IP returned to panel")
	}
	result = executeIPSwitchRequest(task, mockIPSwitchClient(200, `{"data":{"success":true,"ip":"8.8.4.4"}}`))
	if result.NewIP != "8.8.4.4" || result.Outcome != "verified" {
		t.Fatal(result)
	}
	result = executeIPSwitchRequest(task, &http.Client{Transport: ipSwitchRoundTrip(func(*http.Request) (*http.Response, error) { return nil, errors.New("http://10.0.0.1/?token=secret") })})
	encoded, _ := json.Marshal(result)
	if strings.Contains(string(encoded), "secret") || result.Reason != "request_failed" {
		t.Fatal("raw network error leaked")
	}
}
func TestIPSwitchNoRedirectsOrUnboundedWait(t *testing.T) {
	redirected := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "/paid", http.StatusFound)
			return
		}
		redirected = true
		w.WriteHeader(200)
	}))
	defer server.Close()
	client := newIPSwitchClient(50 * time.Millisecond)
	// Inject only the test dialer; retain real redirect/timeout policies.
	client.Transport.(*http.Transport).DialContext = (&net.Dialer{}).DialContext
	defer client.CloseIdleConnections()
	task := sampleIPSwitchTask()
	task.Request.URL = server.URL + "/redirect"
	if executeIPSwitchRequest(task, client).Reason != "http_status" || redirected {
		t.Fatal("followed redirect")
	}
	client.Transport = ipSwitchRoundTrip(func(r *http.Request) (*http.Response, error) { <-r.Context().Done(); return nil, r.Context().Err() })
	started := time.Now()
	if executeIPSwitchRequest(task, client).Reason != "request_failed" || time.Since(started) > time.Second {
		t.Fatal("request did not time out")
	}
}
