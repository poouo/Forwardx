package main

import (
	"context"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

type supportBundleRequest struct {
	TaskID string `json:"taskId"`
}

type supportCommandResult struct {
	Name       string `json:"name"`
	Output     string `json:"output"`
	Error      string `json:"error,omitempty"`
	DurationMS int64  `json:"durationMs"`
}

var supportSecretPattern = regexp.MustCompile(`(?i)((?:password|passwd|secret|token|private.?key|authorization)\s*[=:]\s*)[^\s,;]+`)

const (
	supportJournalOutputLimit = 48 * 1024
	supportCommandOutputLimit = 16 * 1024
	supportTotalOutputLimit   = 176 * 1024
	supportTruncationMarker   = "\n[TRUNCATED]"
)

func redactSupportOutput(value string) string {
	return supportSecretPattern.ReplaceAllString(value, "${1}[REDACTED]")
}

func truncateSupportOutput(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	if len(value) <= limit {
		return value
	}
	if limit <= len(supportTruncationMarker) {
		return supportTruncationMarker[:limit]
	}
	prefixEnd := limit - len(supportTruncationMarker)
	for prefixEnd > 0 && !utf8.ValidString(value[:prefixEnd]) {
		prefixEnd--
	}
	return value[:prefixEnd] + supportTruncationMarker
}

func runSupportCommand(name, command string, outputLimit int) supportCommandResult {
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	cmd, cleanup, _, err := shellCommand(ctx, command)
	if err != nil {
		return supportCommandResult{Name: name, Error: err.Error(), DurationMS: time.Since(started).Milliseconds()}
	}
	defer cleanup()
	output, runErr := cmd.CombinedOutput()
	result := supportCommandResult{Name: name, Output: truncateSupportOutput(redactSupportOutput(string(output)), outputLimit), DurationMS: time.Since(started).Milliseconds()}
	if ctx.Err() == context.DeadlineExceeded {
		result.Error = "timeout"
	} else if runErr != nil {
		result.Error = runErr.Error()
	}
	return result
}

func enforceSupportOutputTotalLimit(results []supportCommandResult, limit int) {
	remaining := limit
	for index := range results {
		results[index].Output = truncateSupportOutput(results[index].Output, remaining)
		remaining -= len(results[index].Output)
		if remaining < 0 {
			remaining = 0
		}
	}
}

func collectSupportDiagnostics() map[string]any {
	commands := []struct {
		name, command string
		outputLimit   int
	}{
		{"agent-journal-current-boot", "journalctl -u forwardx-agent -b -n 600 --no-pager 2>&1 || tail -n 600 /var/log/forwardx-agent/agent-go.log 2>&1", supportJournalOutputLimit},
		{"agent-journal-previous-boot", "journalctl -u forwardx-agent -b -1 -n 300 --no-pager 2>&1 || true", supportJournalOutputLimit},
		{"service-status", "systemctl status forwardx-agent forwardx-runtime forwardx-tunnel-runtime forwardx-nginx --no-pager -l 2>&1 || true", supportCommandOutputLimit},
		{"service-restarts", "systemctl show forwardx-agent forwardx-runtime forwardx-tunnel-runtime forwardx-nginx -p Id -p ActiveState -p SubState -p NRestarts -p ExecMainStartTimestamp 2>&1 || true", supportCommandOutputLimit},
		{"mimic", "for f in /etc/mimic/*.conf; do [ -f \"$f\" ] || continue; i=${f##*/}; i=${i%.conf}; echo \"### $i\"; mimic show \"$i\" 2>&1 || true; ip -details link show dev \"$i\" 2>&1 || true; tc filter show dev \"$i\" ingress 2>&1 || true; tc filter show dev \"$i\" egress 2>&1 || true; done", supportCommandOutputLimit},
		{"listeners", "ss -H -ltnup 2>&1 | head -n 2000", supportCommandOutputLimit},
		{"routes", "ip -4 route show 2>&1; ip -6 route show 2>&1", supportCommandOutputLimit},
		{"qdisc", "tc qdisc show 2>&1 || true", supportCommandOutputLimit},
		{"network-sysctl", "sysctl net.ipv4.ip_forward net.ipv6.conf.all.forwarding net.core.rmem_max net.core.wmem_max 2>&1 || true", supportCommandOutputLimit},
		{"nft-summary", "nft list ruleset 2>&1 | head -n 2500 || true", supportCommandOutputLimit},
	}
	results := make([]supportCommandResult, len(commands))
	semaphore := make(chan struct{}, 4)
	var wg sync.WaitGroup
	for index, item := range commands {
		wg.Add(1)
		go func(index int, name, command string, outputLimit int) {
			defer wg.Done()
			semaphore <- struct{}{}
			defer func() { <-semaphore }()
			results[index] = runSupportCommand(name, command, outputLimit)
		}(index, item.name, item.command, item.outputLimit)
	}
	wg.Wait()
	enforceSupportOutputTotalLimit(results, supportTotalOutputLimit)
	receivedRevision, appliedRevision, receivedHash, appliedHash := desiredRevisionSnapshot()
	return map[string]any{
		"agentVersion":         Version,
		"bootId":               agentBootID,
		"processId":            os.Getpid(),
		"processStartedAt":     agentProcessStartedAt.Format(time.RFC3339Nano),
		"lastReceivedRevision": receivedRevision,
		"lastAppliedRevision":  appliedRevision,
		"lastReceivedHash":     receivedHash,
		"lastAppliedHash":      appliedHash,
		"mimicEnvironment":     mimicRuntimeEnvironment(),
		"mimicRuntime":         mimicRuntimeDiagnostics(),
		"fxpEndpointEvents":    fxpEndpointEventsSnapshot(),
		"commands":             results,
	}
}

func collectAndReportSupportBundle(cfg Config, request supportBundleRequest) {
	taskID := strings.TrimSpace(request.TaskID)
	if taskID == "" {
		return
	}
	diagnostics := collectSupportDiagnostics()
	var response map[string]any
	if err := post(cfg, "/api/agent/support-bundle-result", map[string]any{
		"taskId":      taskID,
		"diagnostics": diagnostics,
	}, &response); err != nil {
		logf("support bundle report failed task=%s error=%v", taskID, err)
	}
}
