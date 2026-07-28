package main

import (
	"testing"
	"time"
)

func TestForwardGroupHealthDecisionUsesAgentWindows(t *testing.T) {
	gate := newForwardGroupHealthDecisionGate()
	now := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)

	if status, pending := gate.observe("member-1", true, 60, 120, now); status != "unknown" || !pending {
		t.Fatalf("first timeout status=%s pending=%v", status, pending)
	}
	if status, pending := gate.observe("member-1", true, 60, 120, now.Add(59*time.Second)); status != "unknown" || !pending {
		t.Fatalf("early failure status=%s pending=%v", status, pending)
	}
	if status, pending := gate.observe("member-1", false, 60, 120, now.Add(60*time.Second)); status != "healthy" || pending {
		t.Fatalf("transient recovery status=%s pending=%v", status, pending)
	}

	if status, pending := gate.observe("member-1", true, 60, 120, now.Add(61*time.Second)); status != "healthy" || !pending {
		t.Fatalf("failure observation status=%s pending=%v", status, pending)
	}
	if status, pending := gate.observe("member-1", true, 60, 120, now.Add(121*time.Second)); status != "unhealthy" || pending {
		t.Fatalf("mature failure status=%s pending=%v", status, pending)
	}
	if status, pending := gate.observe("member-1", false, 60, 120, now.Add(122*time.Second)); status != "unhealthy" || !pending {
		t.Fatalf("recovery observation status=%s pending=%v", status, pending)
	}
	if status, pending := gate.observe("member-1", false, 60, 120, now.Add(242*time.Second)); status != "healthy" || pending {
		t.Fatalf("mature recovery status=%s pending=%v", status, pending)
	}
}

func TestApplyForwardGroupHealthDecisionCoversEntryAndManagedRules(t *testing.T) {
	previous := agentForwardGroupHealthDecisions
	agentForwardGroupHealthDecisions = newForwardGroupHealthDecisionGate()
	t.Cleanup(func() { agentForwardGroupHealthDecisions = previous })
	now := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)

	entryPayload := map[string]any{}
	applyForwardGroupHealthDecision(tcpingTask{
		Kind: "forwardGroup", GroupID: 7, MemberID: 8, ProbeType: "entry",
		TopologyKey: "group-7-member-8", FailoverSeconds: 10, RecoverSeconds: 20,
	}, true, entryPayload, now)
	if entryPayload["healthStatus"] != "healthy" || entryPayload["healthPending"] != false {
		t.Fatalf("entry payload=%#v", entryPayload)
	}

	rulePayload := map[string]any{}
	applyForwardGroupHealthDecision(tcpingTask{
		Kind: "rule", RuleID: 9, ProbeKey: "rule-9",
		GroupHealth: &forwardGroupHealthSpec{GroupID: 7, MemberID: 8, FailoverSeconds: 10, RecoverSeconds: 20},
	}, false, rulePayload, now)
	if rulePayload["healthStatus"] != "unknown" || rulePayload["healthPending"] != true {
		t.Fatalf("managed rule payload=%#v", rulePayload)
	}
}
