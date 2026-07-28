package main

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

const forwardGroupHealthDecisionTTL = 30 * time.Minute

type forwardGroupHealthDecisionState struct {
	stable     string
	pending    string
	pendingAt  time.Time
	lastSeenAt time.Time
}

type forwardGroupHealthDecisionGate struct {
	mu     sync.Mutex
	states map[string]forwardGroupHealthDecisionState
}

var agentForwardGroupHealthDecisions = newForwardGroupHealthDecisionGate()

func newForwardGroupHealthDecisionGate() *forwardGroupHealthDecisionGate {
	return &forwardGroupHealthDecisionGate{states: map[string]forwardGroupHealthDecisionState{}}
}

func normalizeForwardGroupHealthWindow(seconds int, fallback int) time.Duration {
	if seconds < 10 {
		seconds = fallback
	}
	if seconds < 10 {
		seconds = 10
	}
	return time.Duration(seconds) * time.Second
}

func (gate *forwardGroupHealthDecisionGate) observe(
	key string,
	timedOut bool,
	failoverSeconds int,
	recoverSeconds int,
	now time.Time,
) (string, bool) {
	key = strings.TrimSpace(key)
	if key == "" {
		return "unknown", true
	}
	desired := "healthy"
	window := normalizeForwardGroupHealthWindow(recoverSeconds, 120)
	if timedOut {
		desired = "unhealthy"
		window = normalizeForwardGroupHealthWindow(failoverSeconds, 60)
	}

	gate.mu.Lock()
	defer gate.mu.Unlock()
	for stateKey, state := range gate.states {
		if now.Sub(state.lastSeenAt) > forwardGroupHealthDecisionTTL {
			delete(gate.states, stateKey)
		}
	}

	state, exists := gate.states[key]
	if !exists {
		state = forwardGroupHealthDecisionState{lastSeenAt: now}
		if desired == "healthy" {
			state.stable = "healthy"
			gate.states[key] = state
			return state.stable, false
		}
		state.stable = "unknown"
		state.pending = desired
		state.pendingAt = now
		gate.states[key] = state
		return state.stable, true
	}
	state.lastSeenAt = now
	if state.stable == desired {
		state.pending = ""
		state.pendingAt = time.Time{}
		gate.states[key] = state
		return state.stable, false
	}
	if state.stable == "unknown" && desired == "healthy" {
		state.stable = "healthy"
		state.pending = ""
		state.pendingAt = time.Time{}
		gate.states[key] = state
		return state.stable, false
	}
	if state.pending != desired || state.pendingAt.IsZero() {
		state.pending = desired
		state.pendingAt = now
		gate.states[key] = state
		return state.stable, true
	}
	if now.Sub(state.pendingAt) >= window {
		state.stable = desired
		state.pending = ""
		state.pendingAt = time.Time{}
		gate.states[key] = state
		return state.stable, false
	}
	gate.states[key] = state
	return state.stable, true
}

func forwardGroupHealthDecisionKey(task tcpingTask) string {
	if task.GroupHealth != nil {
		return fmt.Sprintf(
			"forward-group:%d:member:%d:rule:%d:%s",
			task.GroupHealth.GroupID,
			task.GroupHealth.MemberID,
			task.RuleID,
			strings.TrimSpace(task.ProbeKey),
		)
	}
	if key := strings.TrimSpace(task.TopologyKey); key != "" {
		return key
	}
	return fmt.Sprintf("forward-group:%d:member:%d:%s", task.GroupID, task.MemberID, strings.TrimSpace(task.ProbeType))
}

func applyForwardGroupHealthDecision(task tcpingTask, reachable bool, payload map[string]any, now time.Time) {
	probeType := strings.ToLower(strings.TrimSpace(task.ProbeType))
	isForwardGroupProbe := task.Kind == "forwardGroup" && task.MemberID > 0 && (probeType == "china" || probeType == "entry")
	isManagedRuleProbe := task.Kind == "rule" && task.GroupHealth != nil && task.GroupHealth.GroupID > 0 && task.GroupHealth.MemberID > 0
	if !isForwardGroupProbe && !isManagedRuleProbe {
		return
	}
	failoverSeconds := task.FailoverSeconds
	recoverSeconds := task.RecoverSeconds
	if isManagedRuleProbe {
		failoverSeconds = task.GroupHealth.FailoverSeconds
		recoverSeconds = task.GroupHealth.RecoverSeconds
	}
	status, pending := agentForwardGroupHealthDecisions.observe(
		forwardGroupHealthDecisionKey(task),
		!reachable,
		failoverSeconds,
		recoverSeconds,
		now,
	)
	payload["healthStatus"] = status
	payload["healthPending"] = pending
}
