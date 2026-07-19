package main

import (
	"fmt"
	"strings"
	"sync"
	"testing"
)

func TestRuleActionNeedsPreRuntimeHandoff(t *testing.T) {
	desired := action{Op: "apply", RuleID: 8, TunnelID: 20, ForwardType: "gost-tunnel", Protocol: "both", SourcePort: 12000}
	if ruleActionNeedsPreRuntimeHandoff(desired, 8, "gost-tunnel", 20, "both", true) {
		t.Fatal("matching local runtime must not be cleaned before shared runtime sync")
	}
	if !ruleActionNeedsPreRuntimeHandoff(desired, 8, "iptables", 0, "both", true) {
		t.Fatal("forward type transition must clean the old listener before shared runtime sync")
	}
	if !ruleActionNeedsPreRuntimeHandoff(desired, 8, "gost-tunnel", 19, "both", true) {
		t.Fatal("tunnel transition on the same port must perform a runtime handoff")
	}
	if !ruleActionNeedsPreRuntimeHandoff(desired, 8, "gost-tunnel", 20, "tcp", true) {
		t.Fatal("protocol transition on the same port must perform a runtime handoff")
	}
}

func TestActionIngressAcceptsIndependentActionsConcurrently(t *testing.T) {
	buffer := actionIngressBuffer{byKey: map[string]*actionIngressItem{}}
	const workers = 32
	const perWorker = 64
	var group sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		group.Add(1)
		go func(worker int) {
			defer group.Done()
			for index := 0; index < perWorker; index++ {
				id := worker*perWorker + index + 1
				buffer.push(actionJob{action: action{Op: "apply", RuleID: id, SourcePort: 10000 + id, Protocol: "tcp", ForwardType: "gost", IssuedAt: int64(id)}})
			}
		}(worker)
	}
	group.Wait()
	if got, want := buffer.len(), workers*perWorker; got != want {
		t.Fatalf("concurrent ingress count=%d want=%d", got, want)
	}
	seen := map[string]bool{}
	for {
		job, ok := buffer.pop()
		if !ok {
			break
		}
		key := fmt.Sprintf("%d", job.action.RuleID)
		if seen[key] {
			t.Fatalf("duplicate action %s", key)
		}
		seen[key] = true
	}
	if len(seen) != workers*perWorker {
		t.Fatalf("popped=%d want=%d", len(seen), workers*perWorker)
	}
}

func TestTunnelActionNeedsPreRuntimeHandoff(t *testing.T) {
	desired := action{Op: "apply", TunnelID: 15, ForwardType: "nginx-tunnel", SourcePort: 13000}
	if tunnelActionNeedsPreRuntimeHandoff(desired, 15, "nginx-tunnel") {
		t.Fatal("matching tunnel runtime must not be handed off")
	}
	if !tunnelActionNeedsPreRuntimeHandoff(desired, 14, "gost-tunnel") {
		t.Fatal("reassigned tunnel port must be handed off")
	}
}

func TestHandoffActionUsesIndependentQueueIdentity(t *testing.T) {
	base := action{Op: "apply", RuleID: 3, SourcePort: 14000, Protocol: "tcp", ForwardType: "gost", IssuedAt: 10}
	handoff := base
	handoff.HandoffOnly = true
	if actionQueueKey(base) == actionQueueKey(handoff) || !strings.HasPrefix(actionQueueKey(handoff), "handoff:") {
		t.Fatal("handoff cleanup must not replace the actual apply action in the ingress queue")
	}
}
