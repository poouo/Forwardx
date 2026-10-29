package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"syscall"
	"time"
)

type ipSwitchRequest struct {
	URL            string            `json:"url"`
	Method         string            `json:"method"`
	Headers        map[string]string `json:"headers"`
	Body           string            `json:"body"`
	SuccessMode    string            `json:"successMode"`
	SuccessPath    string            `json:"successPath"`
	SuccessValue   any               `json:"successValue"`
	IPPath         string            `json:"ipPath"`
	TimeoutSeconds int               `json:"timeoutSeconds"`
}
type ipSwitchTask struct {
	TaskID    string          `json:"taskId"`
	ServiceID int             `json:"serviceId"`
	ExpiresAt int64           `json:"expiresAt"`
	Request   ipSwitchRequest `json:"request"`
}
type ipSwitchResult struct {
	TaskID     string `json:"taskId"`
	Outcome    string `json:"outcome"`
	Reason     string `json:"reason"`
	HTTPStatus int    `json:"httpStatus,omitempty"`
	NewIP      string `json:"newIp,omitempty"`
}

var ipSwitchID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var ipSwitchHeader = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
var ipSwitchJSONPath = regexp.MustCompile(`^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$`)

// Never log raw errors: HTTP/DNS errors can contain merchant URLs and keys.
type ipSwitchTransportError struct {
	reason string
	cause  error
}

func (e *ipSwitchTransportError) Error() string { return e.reason }
func (e *ipSwitchTransportError) Unwrap() error { return e.cause }

func ipSwitchErrorCategory(err error) string {
	if err == nil {
		return "none"
	}
	var transportErr *ipSwitchTransportError
	if errors.As(err, &transportErr) {
		return transportErr.reason
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		if dnsErr.Timeout() {
			return "dns_timeout"
		}
		return "dns_failed"
	}
	var certErr *tls.CertificateVerificationError
	if errors.As(err, &certErr) {
		return "tls_certificate_invalid"
	}
	var tlsErr tls.RecordHeaderError
	if errors.As(err, &tlsErr) {
		return "tls_protocol_error"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	if errors.Is(err, context.Canceled) {
		return "canceled"
	}
	for _, item := range []struct {
		err  error
		code string
	}{
		{syscall.ECONNREFUSED, "connection_refused"},
		{syscall.ECONNRESET, "connection_reset"},
		{syscall.ENETUNREACH, "network_unreachable"},
		{syscall.EHOSTUNREACH, "network_unreachable"},
		{syscall.ENOSPC, "disk_full"},
		{syscall.EROFS, "read_only_filesystem"},
	} {
		if errors.Is(err, item.err) {
			return item.code
		}
	}
	if errors.Is(err, os.ErrPermission) {
		return "permission_denied"
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "timeout"
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) && opErr.Op == "dial" {
		return "connect_failed"
	}
	return "request_failed"
}

func logIPSwitchTask(task ipSwitchTask, format string, args ...any) {
	id, serviceID := task.TaskID, task.ServiceID
	if !ipSwitchID.MatchString(id) {
		id = "invalid"
	}
	if serviceID <= 0 {
		serviceID = 0
	}
	logf("IP switch task=%s service=%d "+format, append([]any{id, serviceID}, args...)...)
}

func ipSwitchResponseFormat(contentType string) string {
	switch strings.ToLower(strings.TrimSpace(strings.SplitN(contentType, ";", 2)[0])) {
	case "application/json":
		return "json"
	case "text/html":
		return "html"
	case "text/plain":
		return "text"
	case "":
		return "unknown"
	default:
		return "other"
	}
}

// Explicitly configured RFC1918/ULA vendor management addresses are permitted.
// Loopback, metadata/link-local, CGNAT, multicast and unspecified addresses are not.
func allowedIPSwitchIP(ip net.IP) bool {
	if ip == nil || !ip.IsGlobalUnicast() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return false
	}
	if v4 := ip.To4(); v4 != nil {
		if v4[0] == 0 || v4[0] >= 224 || (v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127) || (v4[0] == 198 && (v4[1] == 18 || v4[1] == 19)) {
			return false
		}
	}
	return true
}
func validateIPSwitchRequest(r ipSwitchRequest) bool {
	u, err := url.Parse(r.URL)
	if err != nil || len(r.URL) > 4096 || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || u.Fragment != "" {
		return false
	}
	if ip := net.ParseIP(u.Hostname()); ip != nil && !allowedIPSwitchIP(ip) {
		return false
	}
	if r.Method != "GET" && r.Method != "POST" && r.Method != "PUT" {
		return false
	}
	if (r.Method == "GET" && r.Body != "") || len(r.Body) > 16384 || len(r.Headers) > 20 || r.TimeoutSeconds < 5 || r.TimeoutSeconds > 30 {
		return false
	}
	for key, value := range r.Headers {
		if !ipSwitchHeader.MatchString(key) || len(value) > 4096 || strings.ContainsAny(value, "\r\n") {
			return false
		}
		switch strings.ToLower(key) {
		case "host", "content-length", "connection", "transfer-encoding", "upgrade", "proxy-authorization", "proxy-connection", "trailer", "te":
			return false
		}
	}
	if r.IPPath != "" && (!ipSwitchJSONPath.MatchString(r.IPPath) || len(r.IPPath) > 160) {
		return false
	}
	if r.SuccessMode == "http" {
		return true
	}
	if r.SuccessMode != "json" || !ipSwitchJSONPath.MatchString(r.SuccessPath) || len(r.SuccessPath) > 160 {
		return false
	}
	switch r.SuccessValue.(type) {
	case string, bool, float64:
		return true
	}
	return false
}

func newIPSwitchClient(timeout time.Duration) *http.Client {
	transport := &http.Transport{
		Proxy: nil, DisableKeepAlives: true, TLSHandshakeTimeout: 5 * time.Second,
		MaxResponseHeaderBytes: 16384, ResponseHeaderTimeout: timeout,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(address)
			if err != nil {
				return nil, &ipSwitchTransportError{reason: "invalid_destination", cause: err}
			}
			records, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil || len(records) == 0 {
				reason := "dns_failed"
				var dnsErr *net.DNSError
				if errors.As(err, &dnsErr) && dnsErr.Timeout() {
					reason = "dns_timeout"
				}
				return nil, &ipSwitchTransportError{reason: reason, cause: err}
			}
			for _, record := range records {
				if record.Zone != "" || !allowedIPSwitchIP(record.IP) {
					return nil, &ipSwitchTransportError{reason: "destination_blocked"}
				}
			}
			// Pin the validated address: no second DNS lookup or environment proxy.
			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, net.JoinHostPort(records[0].IP.String(), port))
		},
	}
	return &http.Client{Transport: transport, Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}
func ipSwitchJSONValue(value any, path string) any {
	for _, key := range strings.Split(path, ".") {
		object, ok := value.(map[string]any)
		if !ok {
			return nil
		}
		value = object[key]
	}
	return value
}
func executeIPSwitchRequest(task ipSwitchTask, client *http.Client) (result ipSwitchResult) {
	started := time.Now()
	diagnostic, responseFormat := "none", "unknown"
	result = ipSwitchResult{TaskID: task.TaskID, Outcome: "uncertain", Reason: "request_failed"}
	defer func() {
		logIPSwitchTask(task, "stage=request_finished outcome=%s reason=%s status=%d diagnostic=%s responseFormat=%s durationMs=%d", result.Outcome, result.Reason, result.HTTPStatus, diagnostic, responseFormat, time.Since(started).Milliseconds())
	}()
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(task.Request.TimeoutSeconds)*time.Second)
	defer cancel()
	r := task.Request
	req, err := http.NewRequestWithContext(ctx, r.Method, r.URL, strings.NewReader(r.Body))
	if err != nil {
		result.Outcome, result.Reason = "not_executed", "invalid_request"
		diagnostic = "request_build_failed"
		return result
	}
	for key, value := range r.Headers {
		req.Header.Set(key, value)
	}
	// Log the attempt, not a successful connection; never include the URL,
	// headers or body because merchant credentials can appear in any of them.
	method, mode := r.Method, r.SuccessMode
	if method != "GET" && method != "POST" && method != "PUT" {
		method = "invalid"
	}
	if mode != "http" && mode != "json" {
		mode = "invalid"
	}
	trace := &httptrace.ClientTrace{
		TLSHandshakeDone: func(_ tls.ConnectionState, err error) {
			logIPSwitchTask(task, "stage=tls_finished error=%s", ipSwitchErrorCategory(err))
		},
		WroteRequest: func(info httptrace.WroteRequestInfo) {
			// This confirms the local HTTP write, not that the merchant executed it.
			logIPSwitchTask(task, "stage=request_written error=%s", ipSwitchErrorCategory(info.Err))
		},
	}
	req = req.WithContext(httptrace.WithClientTrace(req.Context(), trace))
	logIPSwitchTask(task, "stage=request_started method=%s successMode=%s timeoutSeconds=%d 开始请求换 IP 商家接口", method, mode, r.TimeoutSeconds)
	resp, err := client.Do(req)
	if err != nil {
		diagnostic = ipSwitchErrorCategory(err)
		return result // Never return raw error text: it can contain the API token.
	}
	defer resp.Body.Close()
	result.HTTPStatus = resp.StatusCode
	responseFormat = ipSwitchResponseFormat(resp.Header.Get("Content-Type"))
	logIPSwitchTask(task, "stage=response_received status=%d responseFormat=%s durationMs=%d", resp.StatusCode, responseFormat, time.Since(started).Milliseconds())
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		result.Reason = "http_status"
		diagnostic = "http_non_2xx"
		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			diagnostic = "redirect_not_followed"
		}
		return result
	}
	if r.SuccessMode == "http" && r.IPPath == "" {
		result.Outcome, result.Reason = "accepted", "ok"
		diagnostic = "http_accepted_not_verified"
		return result
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 65537))
	var data any
	if err != nil {
		result.Reason = "invalid_response"
		diagnostic = "response_read_" + ipSwitchErrorCategory(err)
		return result
	}
	if len(body) > 65536 {
		result.Reason = "invalid_response"
		diagnostic = "response_too_large"
		return result
	}
	if json.Unmarshal(body, &data) != nil {
		result.Reason = "invalid_response"
		diagnostic = "response_not_json"
		if ipSwitchResponseFormat(http.DetectContentType(body)) == "html" {
			responseFormat = "html"
		}
		return result
	}
	if r.SuccessMode == "json" && !reflect.DeepEqual(ipSwitchJSONValue(data, r.SuccessPath), r.SuccessValue) {
		result.Reason = "success_mismatch"
		diagnostic = "success_condition_mismatch"
		return result
	}
	if r.IPPath != "" {
		ipText, ok := ipSwitchJSONValue(data, r.IPPath).(string)
		ip := net.ParseIP(strings.TrimSpace(ipText))
		if !ok || !allowedIPSwitchIP(ip) || ip.IsPrivate() {
			result.Reason = "invalid_ip"
			diagnostic = "new_ip_invalid"
			return result
		}
		result.NewIP = ip.String()
	}
	result.Outcome, result.Reason = "verified", "ok"
	if r.SuccessMode == "http" {
		result.Outcome = "accepted"
	}
	return result
}

func runIPSwitchTask(task ipSwitchTask, directory string, now func() int64, claim func() bool, execute func(ipSwitchTask) ipSwitchResult) (result ipSwitchResult) {
	result = ipSwitchResult{TaskID: task.TaskID, Outcome: "not_executed", Reason: "invalid_request"}
	diagnostic, errorCategory, executing := "invalid_task_or_config", "none", false
	defer func() {
		if !executing {
			logIPSwitchTask(task, "stage=execution_skipped reason=%s diagnostic=%s error=%s 本次未请求商家接口", result.Reason, diagnostic, errorCategory)
		}
	}()
	if !ipSwitchID.MatchString(task.TaskID) || task.ServiceID <= 0 || !validateIPSwitchRequest(task.Request) {
		return result
	}
	if task.ExpiresAt <= now() || task.ExpiresAt > now()+120 {
		result.Reason = "expired"
		diagnostic = "task_expired_or_clock_skew"
		return result
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		result.Reason = "state_unavailable"
		diagnostic, errorCategory = "state_directory_create_failed", ipSwitchErrorCategory(err)
		return result
	}
	// Durable intent BEFORE claim/request. Duplicate deliveries and Agent restarts
	// must never repeat a potentially billable call. Marker contains no secrets.
	file, err := os.OpenFile(filepath.Join(directory, strings.ToLower(task.TaskID)), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		result.Reason = "state_unavailable"
		diagnostic, errorCategory = "intent_marker_create_failed", ipSwitchErrorCategory(err)
		if os.IsExist(err) {
			result.Outcome, result.Reason = "uncertain", "duplicate"
			diagnostic, errorCategory = "duplicate_task_blocked", "none"
		}
		return result
	}
	err = file.Sync()
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		result.Reason = "state_unavailable"
		diagnostic, errorCategory = "intent_marker_sync_failed", ipSwitchErrorCategory(errors.Join(err, closeErr))
		return result
	}
	if runtime.GOOS != "windows" {
		dir, err := os.Open(directory)
		if err != nil {
			result.Reason = "state_unavailable"
			diagnostic, errorCategory = "state_directory_open_failed", ipSwitchErrorCategory(err)
			return result
		}
		err = dir.Sync()
		dir.Close()
		if err != nil {
			result.Reason = "state_unavailable"
			diagnostic, errorCategory = "state_directory_sync_failed", ipSwitchErrorCategory(err)
			return result
		}
	}
	if !claim() {
		result.Reason = "claim_denied"
		diagnostic = "panel_claim_not_granted"
		return result
	}
	if task.ExpiresAt <= now() {
		result.Reason = "expired"
		diagnostic = "task_expired_after_claim"
		return result
	}
	executing = true
	return execute(task)
}
func handleIPSwitchTask(cfg Config, task ipSwitchTask) {
	started := time.Now()
	logIPSwitchTask(task, "stage=received ttlRemainingSeconds=%d 收到换 IP 任务", task.ExpiresAt-encryptedResponseNow(currentPanelURL(cfg)).Unix())
	result := runIPSwitchTask(task, filepath.Join(agentStateDir, "ip-switch-intents"), func() int64 { return encryptedResponseNow(currentPanelURL(cfg)).Unix() }, func() bool {
		var response struct {
			Allowed bool `json:"allowed"`
		}
		logIPSwitchTask(task, "stage=claim_started 开始执行前校验")
		err := post(cfg, "/api/agent/ip-switch-claim", map[string]any{"taskId": task.TaskID}, &response)
		logIPSwitchTask(task, "stage=claim_finished allowed=%t error=%s", err == nil && response.Allowed, ipSwitchErrorCategory(err))
		return err == nil && response.Allowed
	}, func(task ipSwitchTask) ipSwitchResult {
		client := newIPSwitchClient(time.Duration(task.Request.TimeoutSeconds) * time.Second)
		defer client.CloseIdleConnections()
		return executeIPSwitchRequest(task, client)
	})
	// Only fixed enums/IDs are logged; neither provider responses nor credentials.
	logIPSwitchTask(task, "outcome=%s reason=%s status=%d durationMs=%d", result.Outcome, result.Reason, result.HTTPStatus, time.Since(started).Milliseconds())
	reportIPSwitchResult(task, result, func(result ipSwitchResult, ack *ipSwitchReportAck) error {
		return post(cfg, "/api/agent/ip-switch-result", map[string]any{"result": result}, ack)
	})
}

type ipSwitchReportAck struct {
	Success bool `json:"success"`
}

func reportIPSwitchResult(task ipSwitchTask, result ipSwitchResult, report func(ipSwitchResult, *ipSwitchReportAck) error) {
	logIPSwitchTask(task, "stage=result_report_started 开始回传换 IP 结果")
	var ack ipSwitchReportAck
	if err := report(result, &ack); err != nil {
		logIPSwitchTask(task, "stage=result_report_failed error=%s 换 IP 结果回传失败，不会重复请求商家接口", ipSwitchErrorCategory(err))
	} else if !ack.Success {
		logIPSwitchTask(task, "stage=result_report_rejected 面板未接收该结果，请检查任务是否过期或已结束；不会重复请求商家接口")
	} else {
		logIPSwitchTask(task, "stage=result_reported 换 IP 结果已回传面板")
	}
}
