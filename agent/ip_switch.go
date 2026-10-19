package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"
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
				return nil, errors.New("invalid_destination")
			}
			records, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil || len(records) == 0 {
				return nil, errors.New("dns_failed")
			}
			for _, record := range records {
				if record.Zone != "" || !allowedIPSwitchIP(record.IP) {
					return nil, errors.New("destination_blocked")
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
func executeIPSwitchRequest(task ipSwitchTask, client *http.Client) ipSwitchResult {
	result := ipSwitchResult{TaskID: task.TaskID, Outcome: "uncertain", Reason: "request_failed"}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(task.Request.TimeoutSeconds)*time.Second)
	defer cancel()
	r := task.Request
	req, err := http.NewRequestWithContext(ctx, r.Method, r.URL, strings.NewReader(r.Body))
	if err != nil {
		result.Outcome, result.Reason = "not_executed", "invalid_request"
		return result
	}
	for key, value := range r.Headers {
		req.Header.Set(key, value)
	}
	resp, err := client.Do(req)
	if err != nil {
		return result // Never return raw error text: it can contain the API token.
	}
	defer resp.Body.Close()
	result.HTTPStatus = resp.StatusCode
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		result.Reason = "http_status"
		return result
	}
	if r.SuccessMode == "http" && r.IPPath == "" {
		result.Outcome, result.Reason = "accepted", "ok"
		return result
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 65537))
	var data any
	if err != nil || len(body) > 65536 || json.Unmarshal(body, &data) != nil {
		result.Reason = "invalid_response"
		return result
	}
	if r.SuccessMode == "json" && !reflect.DeepEqual(ipSwitchJSONValue(data, r.SuccessPath), r.SuccessValue) {
		result.Reason = "success_mismatch"
		return result
	}
	if r.IPPath != "" {
		ipText, ok := ipSwitchJSONValue(data, r.IPPath).(string)
		ip := net.ParseIP(strings.TrimSpace(ipText))
		if !ok || !allowedIPSwitchIP(ip) || ip.IsPrivate() {
			result.Reason = "invalid_ip"
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

func runIPSwitchTask(task ipSwitchTask, directory string, now func() int64, claim func() bool, execute func(ipSwitchTask) ipSwitchResult) ipSwitchResult {
	result := ipSwitchResult{TaskID: task.TaskID, Outcome: "not_executed", Reason: "invalid_request"}
	if !ipSwitchID.MatchString(task.TaskID) || task.ServiceID <= 0 || !validateIPSwitchRequest(task.Request) {
		return result
	}
	if task.ExpiresAt <= now() || task.ExpiresAt > now()+120 {
		result.Reason = "expired"
		return result
	}
	if os.MkdirAll(directory, 0700) != nil {
		result.Reason = "state_unavailable"
		return result
	}
	// Durable intent BEFORE claim/request. Duplicate deliveries and Agent restarts
	// must never repeat a potentially billable call. Marker contains no secrets.
	file, err := os.OpenFile(filepath.Join(directory, strings.ToLower(task.TaskID)), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		result.Reason = "state_unavailable"
		if os.IsExist(err) {
			result.Outcome, result.Reason = "uncertain", "duplicate"
		}
		return result
	}
	err = file.Sync()
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		result.Reason = "state_unavailable"
		return result
	}
	if runtime.GOOS != "windows" {
		dir, err := os.Open(directory)
		if err != nil {
			result.Reason = "state_unavailable"
			return result
		}
		err = dir.Sync()
		dir.Close()
		if err != nil {
			result.Reason = "state_unavailable"
			return result
		}
	}
	if !claim() {
		result.Reason = "claim_denied"
		return result
	}
	if task.ExpiresAt <= now() {
		result.Reason = "expired"
		return result
	}
	return execute(task)
}
func handleIPSwitchTask(cfg Config, task ipSwitchTask) {
	result := runIPSwitchTask(task, filepath.Join(agentStateDir, "ip-switch-intents"), func() int64 { return encryptedResponseNow(currentPanelURL(cfg)).Unix() }, func() bool {
		var response struct {
			Allowed bool `json:"allowed"`
		}
		return post(cfg, "/api/agent/ip-switch-claim", map[string]any{"taskId": task.TaskID}, &response) == nil && response.Allowed
	}, func(task ipSwitchTask) ipSwitchResult {
		client := newIPSwitchClient(time.Duration(task.Request.TimeoutSeconds) * time.Second)
		defer client.CloseIdleConnections()
		return executeIPSwitchRequest(task, client)
	})
	// Only fixed enums/IDs are logged; neither provider responses nor credentials.
	logf("IP switch task=%s service=%d outcome=%s reason=%s status=%d", task.TaskID, task.ServiceID, result.Outcome, result.Reason, result.HTTPStatus)
	if post(cfg, "/api/agent/ip-switch-result", map[string]any{"result": result}, &map[string]any{}) != nil {
		logf("IP switch result report failed task=%s", task.TaskID)
	}
}
