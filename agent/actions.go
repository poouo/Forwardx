package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

const desiredActionFailureRetryInterval = 5 * time.Minute

func enqueueAction(cfg Config, a action) <-chan struct{} {
	done := make(chan struct{})
	if isOlderAction(a, true) {
		close(done)
		return done
	}
	if key := actionQueueKey(a); key != "" && a.IssuedAt > 0 {
		queuedActionMu.Lock()
		existing := queuedActionKeys[key]
		if existing == a.IssuedAt {
			queuedActionMu.Unlock()
			logActionDuplicateSkip(a, key)
			close(done)
			return done
		}
		queuedActionKeys[key] = a.IssuedAt
		queuedActionMu.Unlock()
	}
	atomic.AddInt64(&actionPendingCount, 1)
	enqueueActionJob(actionJob{cfg: cfg, action: a, done: done})
	return done
}

func desiredStateActions(state *desiredState) []action {
	if state == nil {
		return nil
	}
	return state.Actions
}

func syncDesiredState(cfg Config, state *desiredState) []<-chan struct{} {
	if state == nil {
		return nil
	}
	records := readDesiredActionRecords()
	done := make([]<-chan struct{}, 0, len(state.Actions))
	seen := map[string]bool{}
	pendingJobs := make([]actionJob, 0, len(state.Actions))
	adoptedStatusReports := make([]action, 0)
	for _, a := range state.Actions {
		if a.IssuedAt <= 0 {
			a.IssuedAt = state.IssuedAt
		}
		key := desiredActionKey(a)
		if key == "" {
			doneCh := make(chan struct{})
			pendingJobs = append(pendingJobs, actionJob{cfg: cfg, action: a, done: doneCh})
			done = append(done, doneCh)
			continue
		}
		signature := desiredActionSignature(a)
		seen[key] = true
		if record, ok := records[key]; ok && record.Signature == signature {
			if record.Success {
				continue
			}
			if time.Since(time.Unix(record.UpdatedAt, 0)) < desiredActionFailureRetryInterval {
				continue
			}
		}
		if canAdoptDesiredAction(a) {
			records[key] = desiredActionRecord{Signature: signature, Success: true, UpdatedAt: time.Now().Unix()}
			if shouldReportDesiredAdoptionStatus(a) {
				writeState(a)
				adoptedStatusReports = append(adoptedStatusReports, a)
			}
			continue
		}
		doneCh := make(chan struct{})
		if isOlderAction(a, true) {
			close(doneCh)
			continue
		}
		if queueKey := actionQueueKey(a); queueKey != "" && a.IssuedAt > 0 {
			queuedActionMu.Lock()
			existing := queuedActionKeys[queueKey]
			if existing == a.IssuedAt {
				queuedActionMu.Unlock()
				logActionDuplicateSkip(a, queueKey)
				close(doneCh)
				continue
			}
			queuedActionKeys[queueKey] = a.IssuedAt
			queuedActionMu.Unlock()
		}
		pendingJobs = append(pendingJobs, actionJob{
			cfg:              cfg,
			action:           a,
			done:             doneCh,
			desiredKey:       key,
			desiredSignature: signature,
		})
		done = append(done, doneCh)
	}
	for key := range records {
		if !seen[key] {
			delete(records, key)
		}
	}
	writeDesiredActionRecords(records)
	if len(adoptedStatusReports) > 0 {
		go reportAdoptedDesiredActions(cfg, adoptedStatusReports)
	}
	for _, job := range pendingJobs {
		if isOlderAction(job.action, true) {
			if job.done != nil {
				close(job.done)
			}
			continue
		}
		if job.desiredKey == "" {
			if queueKey := actionQueueKey(job.action); queueKey != "" && job.action.IssuedAt > 0 {
				queuedActionMu.Lock()
				existing := queuedActionKeys[queueKey]
				if existing == job.action.IssuedAt {
					queuedActionMu.Unlock()
					logActionDuplicateSkip(job.action, queueKey)
					if job.done != nil {
						close(job.done)
					}
					continue
				}
				queuedActionKeys[queueKey] = job.action.IssuedAt
				queuedActionMu.Unlock()
			}
		}
		atomic.AddInt64(&actionPendingCount, 1)
		enqueueActionJob(job)
	}
	return done
}

func reportAdoptedDesiredActions(cfg Config, actions []action) {
	for _, a := range actions {
		reportActionStatus(cfg, a, true, "local runtime already matches desired state")
		time.Sleep(10 * time.Millisecond)
	}
}

func shouldReportDesiredAdoptionStatus(a action) bool {
	return strings.TrimSpace(a.StatusType) != "runtime" && shouldReportActionStatus(a)
}

func desiredActionKey(a action) string {
	statusType := strings.TrimSpace(a.StatusType)
	if statusType == "" {
		if a.RuleID > 0 {
			statusType = "rule"
		} else if a.TunnelID > 0 {
			statusType = "tunnel"
		}
	}
	if statusType == "runtime" {
		name := strings.TrimSpace(a.ForwardType)
		if name == "" {
			name = "runtime"
		}
		return "runtime:" + name
	}
	if statusType == "tunnel" && a.TunnelID > 0 {
		return fmt.Sprintf("tunnel:%d:%d:%s", a.TunnelID, a.SourcePort, a.ForwardType)
	}
	if a.RuleID > 0 {
		return fmt.Sprintf("rule:%d:%d:%s", a.RuleID, a.SourcePort, a.ForwardType)
	}
	if a.SourcePort > 0 {
		return fmt.Sprintf("port:%d:%s", a.SourcePort, a.ForwardType)
	}
	return ""
}

func desiredActionSignature(a action) string {
	return actionCommandSignature(a)
}

func canAdoptDesiredAction(a action) bool {
	if strings.TrimSpace(a.Op) != "apply" {
		return false
	}
	if strings.TrimSpace(a.StatusType) == "runtime" {
		return false
	}
	if a.SourcePort <= 0 {
		return false
	}
	port := fmt.Sprintf("%d", a.SourcePort)
	statusType := strings.TrimSpace(a.StatusType)
	if statusType == "tunnel" || (a.TunnelID > 0 && a.RuleID <= 0) {
		localTunnelID := readTunnelIDByPort(port)
		localForwardType := readTunnelForwardTypeByPort(port)
		return localTunnelID == a.TunnelID && desiredForwardTypeCompatible(localForwardType, a.ForwardType) && desiredActionLocalRuntimeReady(a)
	}
	localRuleID := readRuleIDByPort(port)
	localForwardType := readForwardTypeByPort(port)
	return localRuleID == a.RuleID && desiredForwardTypeCompatible(localForwardType, a.ForwardType) && desiredActionLocalRuntimeReady(a)
}

func desiredActionLocalRuntimeReady(a action) bool {
	if a.KnownRunning {
		return desiredKnownRunningActionReady(a)
	}
	checkedService := false
	if strings.TrimSpace(a.ServiceName) != "" {
		checkedService = true
		if !managedServiceActive(a.ServiceName) {
			return false
		}
	}
	if strings.TrimSpace(a.ServiceNameExtra) != "" {
		checkedService = true
		if !managedServiceActive(a.ServiceNameExtra) {
			return false
		}
	}
	if a.Fxp != nil {
		checkedService = true
		if !fxpMatchesRunning(a.Fxp) {
			return false
		}
		if a.ForwardType == "forwardx" || a.ForwardType == "forwardx-tunnel" {
			return true
		}
	}
	if a.Failover != nil && a.Failover.Enabled {
		return false
	}
	forwardType := strings.TrimSpace(a.ForwardType)
	if forwardType == "gost" || forwardType == "forwardx" || forwardType == "nginx-tunnel" || forwardType == "guard" {
		return desiredRuntimeServicesHealthy() && desiredRuntimeConfigUsesPort(a.SourcePort)
	}
	return checkedService
}

func desiredKnownRunningActionReady(a action) bool {
	if strings.TrimSpace(a.ServiceName) != "" && !managedServiceActive(a.ServiceName) {
		return false
	}
	if strings.TrimSpace(a.ServiceNameExtra) != "" && !managedServiceActive(a.ServiceNameExtra) {
		return false
	}
	if a.Fxp != nil && !fxpMatchesRunning(a.Fxp) {
		return false
	}
	if a.Failover != nil && a.Failover.Enabled {
		return false
	}
	if a.Fxp != nil && (a.ForwardType == "forwardx" || a.ForwardType == "forwardx-tunnel") {
		return true
	}
	switch strings.TrimSpace(a.ForwardType) {
	case "gost", "forwardx", "gost-tunnel", "nginx", "nginx-tunnel", "nginx-tunnel-exit", "guard":
		return desiredRuntimeServicesHealthy() && desiredRuntimeConfigUsesPort(a.SourcePort)
	default:
		return true
	}
}

func desiredRuntimeServicesHealthy() bool {
	services := requiredRuntimeServicesFromLocalConfig()
	if len(services) == 0 {
		return false
	}
	for _, name := range services {
		if !managedServiceActive(name) {
			return false
		}
	}
	return true
}

func desiredRuntimeConfigUsesPort(port int) bool {
	if port <= 0 {
		return false
	}
	for _, item := range managedRuntimeConfigs() {
		if managedRuntimeConfigUsesPort(item.path, port) {
			return true
		}
	}
	return false
}

func desiredForwardTypeCompatible(local string, desired string) bool {
	local = strings.TrimSpace(local)
	desired = strings.TrimSpace(desired)
	if local == "" || desired == "" {
		return false
	}
	if local == desired {
		return true
	}
	if local == "gost" && (desired == "forwardx" || desired == "nginx-tunnel") {
		return true
	}
	if local == "guard" && desired == "guard" {
		return true
	}
	return false
}

func readDesiredActionRecords() map[string]desiredActionRecord {
	records := map[string]desiredActionRecord{}
	raw, err := os.ReadFile(desiredStateRecordPath)
	if err != nil || len(raw) == 0 {
		return records
	}
	_ = json.Unmarshal(raw, &records)
	return records
}

func writeDesiredActionRecords(records map[string]desiredActionRecord) {
	_ = os.MkdirAll("/var/lib/forwardx-agent", 0755)
	raw, err := json.Marshal(records)
	if err != nil {
		return
	}
	_ = os.WriteFile(desiredStateRecordPath, raw, 0644)
}

func rememberDesiredActionResult(key string, signature string, ok bool) {
	records := readDesiredActionRecords()
	records[key] = desiredActionRecord{Signature: signature, Success: ok, UpdatedAt: time.Now().Unix()}
	writeDesiredActionRecords(records)
}

func enqueueActionJob(job actionJob) {
	if job.enqueuedAt.IsZero() {
		job.enqueuedAt = time.Now()
	}
	pending := atomic.LoadInt64(&actionPendingCount)
	if pending >= actionQueueBacklogLogThreshold && shouldLogAgentReport("action-queue-backlog", agentReportLogInterval) {
		logf("action queue backlog pendingActions=%d queued=%d capacity=%d next=%s", pending, len(actionQueue), actionQueueCapacity, actionLogSummary(job.action))
	}
	select {
	case actionQueue <- job:
	default:
		if shouldLogAgentReport("action-queue-saturated", agentReportLogInterval) {
			logf("action queue saturated pendingActions=%d capacity=%d; enqueueing asynchronously", atomic.LoadInt64(&actionPendingCount), actionQueueCapacity)
		}
		go func() {
			actionQueue <- job
		}()
	}
}

func actionWorker() {
	for job := range actionQueue {
		func() {
			if !job.enqueuedAt.IsZero() {
				waited := time.Since(job.enqueuedAt)
				if waited >= actionQueueSlowWaitThreshold && shouldLogAgentReport("action-queue-wait:"+actionDiagnosticKey(job.action), agentReportLogInterval) {
					logf("action queue wait slow waited=%s pendingActions=%d queued=%d %s", waited.Round(time.Millisecond), atomic.LoadInt64(&actionPendingCount), len(actionQueue), actionLogSummary(job.action))
				}
			}
			if job.done != nil {
				defer close(job.done)
			}
			defer func() {
				if atomic.AddInt64(&actionPendingCount, -1) == 0 {
					wakeHeartbeat()
				}
			}()
			defer releaseQueuedAction(job.action)
			if isOlderAction(job.action, false) {
				return
			}
			started := time.Now()
			ok := handleAction(job.cfg, job.action)
			elapsed := time.Since(started)
			if elapsed >= actionSlowHandleThreshold && shouldLogAgentReport("action-handle-slow:"+actionDiagnosticKey(job.action), agentReportLogInterval) {
				logf("action handle slow duration=%s ok=%v pendingActions=%d queued=%d %s", elapsed.Round(time.Millisecond), ok, atomic.LoadInt64(&actionPendingCount), len(actionQueue), actionLogSummary(job.action))
			}
			if !ok && shouldLogAgentReport("action-handle-failed:"+actionDiagnosticKey(job.action), agentReportLogInterval) {
				logf("action handle failed duration=%s pendingActions=%d queued=%d %s", elapsed.Round(time.Millisecond), atomic.LoadInt64(&actionPendingCount), len(actionQueue), actionLogSummary(job.action))
			}
			if job.desiredKey != "" && job.desiredSignature != "" {
				rememberDesiredActionResult(job.desiredKey, job.desiredSignature, ok)
			}
		}()
	}
}

func waitForActionBatch(done []<-chan struct{}, timeout time.Duration) {
	if len(done) == 0 {
		return
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for i, ch := range done {
		if ch == nil {
			continue
		}
		select {
		case <-ch:
		case <-timer.C:
			logf("selftest action wait timeout completed=%d total=%d timeout=%s", i, len(done), timeout)
			return
		}
	}
}

func logActionDuplicateSkip(a action, key string) {
	pending := atomic.LoadInt64(&actionPendingCount)
	if agentVerboseLogs {
		logf("action queue duplicate skip key=%s pendingActions=%d %s", key, pending, actionLogSummary(a))
		return
	}
	if pending >= actionQueueBacklogLogThreshold && shouldLogAgentReport("action-queue-duplicate:"+key, agentReportLogInterval) {
		logf("action queue duplicate skip key=%s pendingActions=%d queued=%d %s", key, pending, len(actionQueue), actionLogSummary(a))
	}
}

func actionLogSummary(a action) string {
	return fmt.Sprintf(
		"op=%s statusType=%s rule=%d tunnel=%d port=%d forwardType=%s protocol=%s issuedAt=%d",
		strings.TrimSpace(a.Op),
		strings.TrimSpace(a.StatusType),
		a.RuleID,
		a.TunnelID,
		a.SourcePort,
		strings.TrimSpace(a.ForwardType),
		strings.TrimSpace(a.Protocol),
		a.IssuedAt,
	)
}

func actionDiagnosticKey(a action) string {
	key := actionQueueKey(a)
	if key != "" {
		return key
	}
	statusType := strings.TrimSpace(a.StatusType)
	if statusType == "" {
		statusType = "unknown"
	}
	return fmt.Sprintf("%s:%s:%d:%d:%d", statusType, strings.TrimSpace(a.Op), a.RuleID, a.TunnelID, a.SourcePort)
}

func actionStaleKeys(a action) []string {
	keys := []string{}
	statusType := strings.TrimSpace(a.StatusType)
	if statusType == "" {
		if a.RuleID > 0 {
			statusType = "rule"
		} else if a.TunnelID > 0 {
			statusType = "tunnel"
		}
	}
	if statusType == "tunnel" && a.TunnelID > 0 {
		keys = append(keys, fmt.Sprintf("tunnel:%d:%d", a.TunnelID, a.SourcePort))
	}
	if a.RuleID > 0 {
		keys = append(keys, fmt.Sprintf("rule:%d:%d", a.RuleID, a.SourcePort))
	}
	if a.SourcePort > 0 {
		keys = append(keys, fmt.Sprintf("port:%d", a.SourcePort))
	}
	return keys
}

func isOlderAction(a action, remember bool) bool {
	if a.IssuedAt <= 0 {
		return false
	}
	keys := actionStaleKeys(a)
	if len(keys) == 0 {
		return false
	}
	actionEpochMu.Lock()
	latest := int64(0)
	for _, key := range keys {
		if ts := latestActionIssuedAt[key]; ts > latest {
			latest = ts
		}
	}
	if remember {
		for _, key := range keys {
			if a.IssuedAt > latestActionIssuedAt[key] {
				latestActionIssuedAt[key] = a.IssuedAt
			}
		}
		if a.IssuedAt > latest {
			latest = a.IssuedAt
		}
	}
	actionEpochMu.Unlock()
	if a.IssuedAt < latest {
		key := fmt.Sprintf("action-stale:%s", strings.Join(keys, ","))
		if shouldLogAgentReport(key, agentReportLogInterval) {
			logf("action stale drop op=%s statusType=%s rule=%d tunnel=%d port=%d issuedAt=%d latest=%d", a.Op, a.StatusType, a.RuleID, a.TunnelID, a.SourcePort, a.IssuedAt, latest)
		}
		return true
	}
	return false
}

func actionQueueKey(a action) string {
	keys := actionStaleKeys(a)
	if len(keys) == 0 {
		return ""
	}
	return strings.Join(keys, "|")
}

func releaseQueuedAction(a action) {
	key := actionQueueKey(a)
	if key == "" || a.IssuedAt <= 0 {
		return
	}
	queuedActionMu.Lock()
	if queuedActionKeys[key] == a.IssuedAt {
		delete(queuedActionKeys, key)
	}
	queuedActionMu.Unlock()
}
