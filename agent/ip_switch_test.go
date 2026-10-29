package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
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
func TestIPSwitchLogsStartBeforeRequestWithoutCredentials(t *testing.T) {
	output, err := os.CreateTemp(t.TempDir(), "request-start-*.log")
	if err != nil {
		t.Fatal(err)
	}
	originalStdout := os.Stdout
	os.Stdout = output
	defer func() { os.Stdout = originalStdout; output.Close() }()
	task := sampleIPSwitchTask()
	task.Request.Method = "POST"
	task.Request.Headers = map[string]string{"Authorization": "header-secret"}
	task.Request.Body = "body-secret"
	want := "IP switch task=" + task.TaskID + " service=1 stage=request_started"
	client := &http.Client{Transport: ipSwitchRoundTrip(func(*http.Request) (*http.Response, error) {
		logged, err := os.ReadFile(output.Name())
		if err != nil || !strings.Contains(string(logged), want) {
			t.Fatalf("request started before its log: %q, %v", logged, err)
		}
		return nil, errors.New("network error containing url-secret")
	})}
	result := executeIPSwitchRequest(task, client)
	if result.Reason != "request_failed" {
		t.Fatal(result)
	}
	logged, err := os.ReadFile(output.Name())
	if err != nil || strings.Count(string(logged), want) != 1 {
		t.Fatalf("expected one request-start log: %q, %v", logged, err)
	}
	for _, secret := range []string{"10.0.0.1", "token=secret", "header-secret", "body-secret", "url-secret"} {
		if strings.Contains(string(logged), secret) {
			t.Fatalf("credential leaked in request-start log: %s", secret)
		}
	}
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

func captureIPSwitchLogs(t *testing.T, run func()) string {
	t.Helper()
	output, err := os.CreateTemp(t.TempDir(), "ip-switch-*.log")
	if err != nil {
		t.Fatal(err)
	}
	original := os.Stdout
	os.Stdout = output
	defer func() { os.Stdout = original; output.Close() }()
	run()
	logged, err := os.ReadFile(output.Name())
	if err != nil {
		t.Fatal(err)
	}
	text := string(logged)
	for _, secret := range []string{"token=secret", "header-secret", "body-secret", "error-secret", "response-secret", "private-secret-path"} {
		if strings.Contains(text, secret) {
			t.Fatalf("sensitive content leaked in logs: %s", secret)
		}
	}
	return text
}

func TestIPSwitchErrorCategoriesAreSafe(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want string
	}{
		{"dns", &net.DNSError{Err: "error-secret", Name: "error-secret"}, "dns_failed"},
		{"dns-timeout", &net.DNSError{IsTimeout: true}, "dns_timeout"},
		{"blocked", &ipSwitchTransportError{reason: "destination_blocked"}, "destination_blocked"},
		{"connect", &net.OpError{Op: "dial", Err: errors.New("error-secret")}, "connect_failed"},
		{"refused", &net.OpError{Op: "dial", Err: syscall.ECONNREFUSED}, "connection_refused"},
		{"reset", syscall.ECONNRESET, "connection_reset"},
		{"unreachable", syscall.ENETUNREACH, "network_unreachable"},
		{"timeout", context.DeadlineExceeded, "timeout"},
		{"canceled", context.Canceled, "canceled"},
		{"tls-cert", &tls.CertificateVerificationError{Err: errors.New("error-secret")}, "tls_certificate_invalid"},
		{"tls-protocol", tls.RecordHeaderError{Msg: "error-secret"}, "tls_protocol_error"},
		{"disk-full", syscall.ENOSPC, "disk_full"},
		{"read-only", syscall.EROFS, "read_only_filesystem"},
		{"permission", os.ErrPermission, "permission_denied"},
		{"unknown", errors.New("error-secret"), "request_failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			wrapped := &url.Error{Op: "Get", URL: "http://private-secret-path/?token=secret", Err: tc.err}
			if got := ipSwitchErrorCategory(wrapped); got != tc.want {
				t.Fatalf("category=%s want=%s", got, tc.want)
			}
			logged := captureIPSwitchLogs(t, func() {
				result := executeIPSwitchRequest(sampleIPSwitchTask(), &http.Client{Transport: ipSwitchRoundTrip(func(*http.Request) (*http.Response, error) {
					return nil, wrapped
				})})
				if result.Outcome != "uncertain" || result.Reason != "request_failed" {
					t.Fatal("diagnostics changed request outcome")
				}
			})
			if !strings.Contains(logged, "stage=request_finished") || !strings.Contains(logged, "diagnostic="+tc.want) {
				t.Fatalf("missing network diagnostic: %s", logged)
			}
		})
	}
}

func TestIPSwitchResponseDiagnostics(t *testing.T) {
	for _, tc := range []struct {
		name, mode, contentType, body, diagnostic, format, outcome string
		status                                                     int
	}{
		{"html-not-json", "json", "text/html; charset=utf-8", "<html>response-secret</html>", "response_not_json", "html", "uncertain", 200},
		{"html-sniffed", "json", "", "<!DOCTYPE html><html>response-secret</html>", "response_not_json", "html", "uncertain", 200},
		{"http-html-accepted", "http", "text/html", "<html>response-secret</html>", "http_accepted_not_verified", "html", "accepted", 200},
		{"redirect", "http", "text/html", "response-secret", "redirect_not_followed", "html", "uncertain", 302},
		{"http-error", "http", "text/plain", "response-secret", "http_non_2xx", "text", "uncertain", 403},
		{"mismatch", "json", "application/json", `{"success":false,"secret":"response-secret"}`, "success_condition_mismatch", "json", "uncertain", 200},
		{"oversize", "json", "application/json", strings.Repeat("x", 65537), "response_too_large", "json", "uncertain", 200},
		{"invalid-ip", "json", "application/json", `{"success":true,"ip":"127.0.0.1"}`, "new_ip_invalid", "json", "uncertain", 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			task := sampleIPSwitchTask()
			task.Request.SuccessMode = tc.mode
			task.Request.SuccessPath, task.Request.SuccessValue = "success", true
			if tc.name == "invalid-ip" {
				task.Request.IPPath = "ip"
			}
			logged := captureIPSwitchLogs(t, func() {
				client := &http.Client{Transport: ipSwitchRoundTrip(func(*http.Request) (*http.Response, error) {
					return &http.Response{StatusCode: tc.status, Header: http.Header{"Content-Type": []string{tc.contentType}}, Body: io.NopCloser(strings.NewReader(tc.body))}, nil
				})}
				if result := executeIPSwitchRequest(task, client); result.Outcome != tc.outcome {
					t.Fatal("diagnostics changed response outcome")
				}
			})
			for _, want := range []string{"stage=response_received", "stage=request_finished", "diagnostic=" + tc.diagnostic, "responseFormat=" + tc.format, "durationMs="} {
				if !strings.Contains(logged, want) {
					t.Fatalf("missing %s in %s", want, logged)
				}
			}
		})
	}
}

func TestIPSwitchPreflightDiagnosticsDoNotDispatchRequests(t *testing.T) {
	for _, name := range []string{"invalid", "expired", "clock-skew", "storage", "denied", "duplicate", "expired-after-claim"} {
		t.Run(name, func(t *testing.T) {
			task, directory, now, executeCalls := sampleIPSwitchTask(), t.TempDir(), int64(1000), 0
			diagnostic := ""
			claim := func() bool { return true }
			switch name {
			case "invalid":
				task.TaskID = "error-secret\nstage=request_started"
				diagnostic = "invalid_task_or_config"
			case "expired":
				now, diagnostic = 2000, "task_expired_or_clock_skew"
			case "clock-skew":
				now, diagnostic = 1, "task_expired_or_clock_skew"
			case "storage":
				directory = filepath.Join(directory, "private-secret-path")
				if err := os.WriteFile(directory, nil, 0600); err != nil {
					t.Fatal(err)
				}
				diagnostic = "state_directory_create_failed"
			case "denied":
				claim = func() bool { return false }
				diagnostic = "panel_claim_not_granted"
			case "duplicate":
				if err := os.WriteFile(filepath.Join(directory, task.TaskID), nil, 0600); err != nil {
					t.Fatal(err)
				}
				diagnostic = "duplicate_task_blocked"
			case "expired-after-claim":
				claim = func() bool { now = 2000; return true }
				diagnostic = "task_expired_after_claim"
			}
			logged := captureIPSwitchLogs(t, func() {
				runIPSwitchTask(task, directory, func() int64 { return now }, claim, func(ipSwitchTask) ipSwitchResult {
					executeCalls++
					return ipSwitchResult{}
				})
			})
			if executeCalls != 0 || strings.Contains(logged, "stage=request_started") || !strings.Contains(logged, "stage=execution_skipped") || !strings.Contains(logged, "diagnostic="+diagnostic) {
				t.Fatalf("incorrect preflight diagnostic: %s", logged)
			}
		})
	}
}

func TestIPSwitchResultReportDiagnostics(t *testing.T) {
	for _, name := range []string{"accepted", "rejected", "failed"} {
		t.Run(name, func(t *testing.T) {
			calls := 0
			logged := captureIPSwitchLogs(t, func() {
				reportIPSwitchResult(sampleIPSwitchTask(), ipSwitchResult{Outcome: "accepted", Reason: "ok"}, func(_ ipSwitchResult, ack *ipSwitchReportAck) error {
					calls++
					ack.Success = name == "accepted"
					if name == "failed" {
						return &url.Error{URL: "http://private-secret-path/", Err: context.DeadlineExceeded}
					}
					return nil
				})
			})
			stage := map[string]string{"accepted": "result_reported", "rejected": "result_report_rejected", "failed": "result_report_failed"}[name]
			if calls != 1 || !strings.Contains(logged, "stage="+stage) || strings.Contains(logged, "stage=request_started") {
				t.Fatalf("incorrect reporting diagnostic: %s", logged)
			}
		})
	}
}

func TestIPSwitchRealHTTPWriteDiagnostic(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/html")
		_, _ = io.WriteString(w, "<html>response-secret</html>")
	}))
	defer server.Close()
	task := sampleIPSwitchTask()
	task.Request.URL = server.URL + "/private-secret-path?token=secret"
	logged := captureIPSwitchLogs(t, func() {
		if result := executeIPSwitchRequest(task, server.Client()); result.Outcome != "accepted" {
			t.Fatal(result)
		}
	})
	for _, stage := range []string{"stage=request_started", "stage=request_written error=none", "stage=response_received", "stage=request_finished"} {
		if !strings.Contains(logged, stage) {
			t.Fatalf("missing HTTP stage %s: %s", stage, logged)
		}
	}
}

func TestIPSwitchRealTLSDiagnostics(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	for _, trusted := range []bool{true, false} {
		task := sampleIPSwitchTask()
		task.Request.URL = server.URL + "/private-secret-path?token=secret"
		client := server.Client()
		want := "stage=tls_finished error=none"
		if !trusted {
			client = &http.Client{Transport: &http.Transport{}}
			want = "stage=tls_finished error=tls_certificate_invalid"
		}
		logged := captureIPSwitchLogs(t, func() {
			result := executeIPSwitchRequest(task, client)
			if (result.Outcome == "accepted") != trusted {
				t.Fatal("unexpected TLS request result")
			}
		})
		client.CloseIdleConnections()
		if !strings.Contains(logged, want) {
			t.Fatalf("missing TLS diagnostic: %s", logged)
		}
	}
}

type ipSwitchFailedBody struct{}

func (ipSwitchFailedBody) Read([]byte) (int, error) { return 0, context.DeadlineExceeded }

func TestIPSwitchReadAndBuildFailureDiagnostics(t *testing.T) {
	task := sampleIPSwitchTask()
	task.Request.SuccessMode = "json"
	client := &http.Client{Transport: ipSwitchRoundTrip(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(ipSwitchFailedBody{})}, nil
	})}
	logged := captureIPSwitchLogs(t, func() {
		if result := executeIPSwitchRequest(task, client); result.Reason != "invalid_response" {
			t.Fatal(result)
		}
	})
	if !strings.Contains(logged, "diagnostic=response_read_timeout") {
		t.Fatalf("missing body read failure diagnostic: %s", logged)
	}
	task.Request.URL = "://private-secret-path"
	logged = captureIPSwitchLogs(t, func() {
		if result := executeIPSwitchRequest(task, client); result.Outcome != "not_executed" {
			t.Fatal(result)
		}
	})
	if strings.Contains(logged, "stage=request_started") || !strings.Contains(logged, "diagnostic=request_build_failed") {
		t.Fatalf("incorrect request build diagnostic: %s", logged)
	}
}
