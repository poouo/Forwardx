package main

import (
	"testing"
	"time"
)

func ingressTestAction(id int, issuedAt int64) actionJob {
	return actionJob{action: action{Op: "apply", RuleID: id, SourcePort: id + 10000, ForwardType: "gost", Protocol: "tcp", IssuedAt: issuedAt}}
}

func TestActionIngressRepeatedUpdatesDoNotRetainInactiveItems(t *testing.T) {
	var buffer actionIngressBuffer
	buffer.push(ingressTestAction(1, 1))
	buffer.push(ingressTestAction(2, 1))
	for issuedAt := int64(2); issuedAt <= 100_000; issuedAt++ {
		depth, old := buffer.push(ingressTestAction(1, issuedAt))
		if depth != 2 || old == nil || buffer.items.Len() != 2 || len(buffer.byKey) != 2 {
			t.Fatalf("superseded action retained at generation %d: depth=%d nodes=%d keys=%d", issuedAt, depth, buffer.items.Len(), len(buffer.byKey))
		}
	}
	first, _ := buffer.pop()
	second, _ := buffer.pop()
	if first.action.RuleID != 2 || second.action.RuleID != 1 || second.action.IssuedAt != 100_000 {
		t.Fatal("replacement must retain latest generation at the tail of arrival order")
	}
	if buffer.items.Len() != 0 || len(buffer.byKey) != 0 {
		t.Fatal("drained ingress retained nodes or keys")
	}
}

func TestActionIngressBoundsIndependentAndUnkeyedActions(t *testing.T) {
	for _, keyed := range []bool{false, true} {
		t.Run(map[bool]string{false: "unkeyed", true: "keyed"}[keyed], func(t *testing.T) {
			var buffer actionIngressBuffer
			for id := 1; id <= actionIngressCapacity; id++ {
				job := actionJob{}
				if keyed {
					job = ingressTestAction(id, 1)
				}
				buffer.push(job)
			}
			finished := make(chan struct{})
			go func() {
				job := actionJob{}
				if keyed {
					job = ingressTestAction(actionIngressCapacity+1, 2)
				}
				buffer.push(job)
				close(finished)
			}()
			t.Cleanup(func() {
				buffer.reset()
				select {
				case <-finished:
				case <-time.After(time.Second):
					t.Error("waiting producer did not wake during cleanup")
				}
			})
			select {
			case <-finished:
				t.Fatal("full ingress admitted an independent action beyond its limit")
			case <-time.After(20 * time.Millisecond):
			}
			if buffer.len() != actionIngressCapacity {
				t.Fatalf("full ingress depth=%d", buffer.len())
			}
			if keyed {
				// Updating an existing identity must still work at capacity.
				depth, old := buffer.push(ingressTestAction(2, 10))
				if old == nil || depth != actionIngressCapacity {
					t.Fatal("coalescing stopped working at capacity")
				}
			}
			buffer.pop()
			select {
			case <-finished:
			case <-time.After(time.Second):
				t.Fatal("producer did not resume when a slot was freed")
			}
			if buffer.len() != actionIngressCapacity {
				t.Fatalf("resumed ingress depth=%d", buffer.len())
			}
		})
	}
}

func TestActionIngressResetWakesBlockedProducer(t *testing.T) {
	var buffer actionIngressBuffer
	for id := 1; id <= actionIngressCapacity; id++ {
		buffer.push(ingressTestAction(id, 1))
	}
	finished := make(chan struct{})
	go func() {
		buffer.push(ingressTestAction(actionIngressCapacity+1, 2))
		close(finished)
	}()
	if jobs := buffer.reset(); len(jobs) != actionIngressCapacity {
		t.Fatalf("reset returned %d jobs", len(jobs))
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("reset did not release producer backpressure")
	}
	if buffer.len() != 1 {
		t.Fatal("waiting action was lost after reset")
	}
}

func TestActionIngressDoesNotReplaceNewerPendingGeneration(t *testing.T) {
	var buffer actionIngressBuffer
	buffer.push(ingressTestAction(1, 20))
	depth, obsolete := buffer.push(ingressTestAction(1, 10))
	if depth != 1 || obsolete == nil || obsolete.action.IssuedAt != 10 {
		t.Fatal("obsolete generation was not returned for completion")
	}
	job, _ := buffer.pop()
	if job.action.IssuedAt != 20 {
		t.Fatal("older arrival replaced newer queued state")
	}
}
