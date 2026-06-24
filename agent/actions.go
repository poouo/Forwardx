package main

import (
	"fmt"
	"strings"
	"sync/atomic"
	"time"
)

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
			close(done)
			return done
		}
		queuedActionKeys[key] = a.IssuedAt
		queuedActionMu.Unlock()
	}
	atomic.AddInt64(&actionPendingCount, 1)
	actionQueue <- actionJob{cfg: cfg, action: a, done: done}
	return done
}

func actionWorker() {
	for job := range actionQueue {
		func() {
			if job.done != nil {
				defer close(job.done)
			}
			defer atomic.AddInt64(&actionPendingCount, -1)
			defer releaseQueuedAction(job.action)
			if isOlderAction(job.action, false) {
				return
			}
			handleAction(job.cfg, job.action)
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
