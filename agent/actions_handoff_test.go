package main

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
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

func TestQueuedOwnerSnapshotSurvivesSpeculativeTargetMarkers(t *testing.T) {
	ruleAction := action{Op: "apply", StatusType: "rule", RuleID: 81, TunnelID: 18, ForwardType: "realm", Protocol: "tcp", SourcePort: 65431}
	rulePrevious := &localActionRuntimeSnapshot{
		valid: true, ruleID: 80, tunnelID: 17, forwardType: "forwardx", protocol: "tcp", hasProtocol: true,
	}
	if !shouldUsePreviousRuleRuntime(ruleAction, 81, "realm", 18, "tcp", true, rulePrevious, false) {
		t.Fatal("unready target marker hid the queued rule owner")
	}
	if shouldUsePreviousRuleRuntime(ruleAction, 81, "realm", 18, "tcp", true, rulePrevious, true) {
		t.Fatal("ready target runtime was replaced by a stale queued rule owner")
	}

	tunnelAction := action{Op: "apply", StatusType: "tunnel", TunnelID: 28, ForwardType: "nginx-tunnel", SourcePort: 65432}
	tunnelPrevious := &localActionRuntimeSnapshot{valid: true, tunnel: true, tunnelID: 27, forwardType: "forwardx-tunnel"}
	if !shouldUsePreviousTunnelRuntime(tunnelAction, 28, "nginx-tunnel", tunnelPrevious, false) {
		t.Fatal("unready target marker hid the queued tunnel owner")
	}
	if shouldUsePreviousTunnelRuntime(tunnelAction, 28, "nginx-tunnel", tunnelPrevious, true) {
		t.Fatal("ready target tunnel was replaced by a stale queued owner")
	}
}

func TestFailedHandoffResultBlocksSharedRuntimePrerequisite(t *testing.T) {
	result := newActionJobResult()
	result.complete(false)
	job := actionJob{
		action:        action{StatusType: "runtime", ForwardType: "nginx-runtime-sync"},
		resultPrereqs: []*actionJobResult{result},
	}
	if waitForActionPrerequisites(job) {
		t.Fatal("shared runtime prerequisite accepted a failed handoff")
	}
}

func TestSuccessfulHandoffResultReleasesSharedRuntimePrerequisite(t *testing.T) {
	result := newActionJobResult()
	result.complete(true)
	job := actionJob{
		action:        action{StatusType: "runtime", ForwardType: "nginx-runtime-sync"},
		resultPrereqs: []*actionJobResult{result},
	}
	if !waitForActionPrerequisites(job) {
		t.Fatal("shared runtime prerequisite rejected a successful handoff")
	}
}

func TestFailedSharedRuntimeResultBlocksDependentPerPortAction(t *testing.T) {
	jobs := []actionJob{
		{action: action{StatusType: "runtime", ForwardType: "nginx-runtime-sync"}},
		{action: action{Op: "apply", StatusType: "rule", RuleID: 18, SourcePort: 15018, Protocol: "tcp", ForwardType: "nginx"}},
	}
	prepared := prepareDesiredActionJobs(jobs)
	if len(prepared) != 2 || prepared[0].result == nil || len(prepared[1].resultPrereqs) != 1 {
		t.Fatalf("shared runtime result dependency was not prepared: %#v", prepared)
	}
	prepared[0].result.complete(false)
	if waitForActionPrerequisites(prepared[1]) {
		t.Fatal("dependent per-port action accepted a failed shared runtime sync")
	}
}

func TestSuccessfulSharedRuntimeResultReleasesDependentPerPortAction(t *testing.T) {
	jobs := []actionJob{
		{action: action{StatusType: "runtime", ForwardType: "nginx-runtime-sync"}},
		{action: action{Op: "apply", StatusType: "rule", RuleID: 19, SourcePort: 15019, Protocol: "tcp", ForwardType: "nginx"}},
	}
	prepared := prepareDesiredActionJobs(jobs)
	prepared[0].result.complete(true)
	if !waitForActionPrerequisites(prepared[1]) {
		t.Fatal("dependent per-port action rejected a successful shared runtime sync")
	}
}

func TestWireGuardRuntimeResultOnlyGatesMatchingV2Actions(t *testing.T) {
	matching := testV2EntrySpec(201, 8201, 58201, "exit-a")
	otherTunnel := testV2EntrySpec(202, 8202, 58202, "exit-b")
	v1 := testV1EntrySpec(201, 8203, 58203)
	jobs := []actionJob{
		{action: action{Op: "apply", StatusType: "runtime", ForwardType: "forwardx-wireguard", TunnelID: 201}},
		{action: action{Op: "apply", StatusType: "rule", ForwardType: "forwardx", TunnelID: 201, Fxp: &matching}},
		{action: action{Op: "apply", StatusType: "rule", ForwardType: "forwardx", TunnelID: 202, Fxp: &otherTunnel}},
		{action: action{Op: "apply", StatusType: "rule", ForwardType: "forwardx", TunnelID: 201, Fxp: &v1}},
	}
	prepared := prepareDesiredActionJobs(jobs)
	if len(prepared) != len(jobs) || prepared[0].result == nil {
		t.Fatalf("WireGuard runtime phase was not prepared: %#v", prepared)
	}
	for _, job := range prepared[1:] {
		wantDependency := job.action.Fxp != nil &&
			normalizeFXPSpec(*job.action.Fxp).TransportVersion == forwardXWireGuardVersion &&
			job.action.TunnelID == 201
		if got := len(job.resultPrereqs) == 1; got != wantDependency {
			t.Fatalf("tunnel=%d transport=%s dependency=%v want=%v", job.action.TunnelID, job.action.Fxp.TransportVersion, got, wantDependency)
		}
	}
	prepared[0].result.complete(false)
	if waitForActionPrerequisites(prepared[1]) {
		t.Fatal("matching V2 action ran after its WireGuard runtime failed")
	}
}

func TestUnqueuedActionPublishesFailedResult(t *testing.T) {
	done := make(chan struct{})
	result := newActionJobResult()
	finishUnqueuedActionJob(actionJob{done: done, result: result})
	if result.wait() {
		t.Fatal("unqueued action published a successful result")
	}
	select {
	case <-done:
	default:
		t.Fatal("unqueued action did not close its completion channel")
	}
}

func TestHandoffResultCommitsOnlyAfterEverySharedRuntimeSucceeds(t *testing.T) {
	commits := 0
	rollbacks := 0
	result := newActionJobResult()
	result.addDependent()
	result.addDependent()
	result.setFinalizers(func() { commits++ }, func() { rollbacks++ })

	result.resolveDependent(true)
	if commits != 0 || rollbacks != 0 {
		t.Fatalf("handoff finalized early commits=%d rollbacks=%d", commits, rollbacks)
	}
	result.resolveDependent(true)
	if commits != 1 || rollbacks != 0 {
		t.Fatalf("handoff finalization commits=%d rollbacks=%d, want 1/0", commits, rollbacks)
	}
}

func TestHandoffResultRollsBackAfterAnySharedRuntimeFailure(t *testing.T) {
	commits := 0
	rollbacks := 0
	result := newActionJobResult()
	result.addDependent()
	result.addDependent()
	result.setFinalizers(func() { commits++ }, func() { rollbacks++ })

	result.resolveDependent(false)
	result.resolveDependent(true)
	if commits != 0 || rollbacks != 1 {
		t.Fatalf("handoff finalization commits=%d rollbacks=%d, want 0/1", commits, rollbacks)
	}
}

func TestStaleNonBatchHandoffFinalizationDoesNotRestoreOldRuntime(t *testing.T) {
	resetHandoffActionEpochForTest(t)
	older := action{
		Op:          "apply",
		StatusType:  "rule",
		RuleID:      970001,
		TunnelID:    9700,
		SourcePort:  57001,
		Protocol:    "tcp",
		ForwardType: "nginx",
		IssuedAt:    100,
	}
	if isOlderAction(older, true) {
		t.Fatal("initial handoff generation unexpectedly stale")
	}

	commits := 0
	rollbacks := 0
	state := &actionHandoffState{}
	state.setFinalizers(func() { commits++ }, func() { rollbacks++ })
	releaseBlocker := acquireActionSerialLocks(actionSerialKeys(older))
	if releaseBlocker == nil {
		t.Fatal("expected handoff serial lock")
	}
	blockerReleased := false
	t.Cleanup(func() {
		if !blockerReleased {
			releaseBlocker()
		}
	})

	finalized := make(chan bool, 1)
	go func() {
		finalized <- finalizeActionHandoffState(older, state, actionHandoffRollback)
	}()
	waitForActionSerialRefs(t, "port:57001", 2)

	newer := older
	newer.IssuedAt = 200
	newer.ForwardType = "gost"
	if isOlderAction(newer, true) {
		t.Fatal("new handoff generation unexpectedly stale")
	}
	releaseBlocker()
	blockerReleased = true

	select {
	case current := <-finalized:
		if current {
			t.Fatal("stale handoff finalization was accepted")
		}
	case <-time.After(time.Second):
		t.Fatal("stale handoff finalization did not resume")
	}
	state.runCommit()
	state.runRollback()
	if commits != 0 || rollbacks != 0 {
		t.Fatalf("stale handoff mutated runtime commits=%d rollbacks=%d", commits, rollbacks)
	}
}

func TestStaleBatchParticipantCancelsFinalizationUnderUnionLocks(t *testing.T) {
	resetHandoffActionEpochForTest(t)
	first := action{
		Op:          "apply",
		StatusType:  "rule",
		RuleID:      970101,
		TunnelID:    9701,
		SourcePort:  57101,
		Protocol:    "tcp",
		ForwardType: "nginx",
		IssuedAt:    100,
	}
	second := first
	second.RuleID = 970102
	second.SourcePort = 57102
	if isOlderAction(first, true) || isOlderAction(second, true) {
		t.Fatal("initial batch generation unexpectedly stale")
	}

	batch := newActionHandoffBatch()
	batch.addParticipant(first)
	batch.addParticipant(second)
	firstState := &actionHandoffState{}
	secondState := &actionHandoffState{}
	firstState.attachBatch(batch)
	secondState.attachBatch(batch)
	finalizations := 0
	batch.finalizeForTest = func(bool, Config, []fxpSpec, []fxpRuntimeSelector) {
		finalizations++
	}
	firstState.runCommit()

	releaseBlocker := acquireActionSerialLocks(actionSerialKeys(first))
	if releaseBlocker == nil {
		t.Fatal("expected first participant serial lock")
	}
	blockerReleased := false
	t.Cleanup(func() {
		if !blockerReleased {
			releaseBlocker()
		}
	})
	resolved := make(chan struct{})
	go func() {
		secondState.runRollback()
		close(resolved)
	}()
	// The second participant triggered finalization, but the batch must also
	// wait for the first participant's keys before checking generations.
	waitForActionSerialRefs(t, "port:57101", 2)

	newer := first
	newer.IssuedAt = 200
	newer.ForwardType = "gost"
	if isOlderAction(newer, true) {
		t.Fatal("replacement batch generation unexpectedly stale")
	}
	releaseBlocker()
	blockerReleased = true
	select {
	case <-resolved:
	case <-time.After(time.Second):
		t.Fatal("batch finalization did not resume")
	}

	batch.mu.Lock()
	cancelled := batch.cancelled
	resolvedCount := batch.resolved
	batch.mu.Unlock()
	if !cancelled || resolvedCount != 2 {
		t.Fatalf("batch cancelled=%v resolved=%d, want true/2", cancelled, resolvedCount)
	}
	if finalizations != 0 {
		t.Fatalf("stale batch ran %d persistence/runtime finalizers", finalizations)
	}
}

func TestSuccessfulFXPTargetDoesNotRewriteItsNewPersistentGeneration(t *testing.T) {
	commits := 0
	rollbacks := 0
	state := &actionHandoffState{}
	state.setFinalizers(func() { commits++ }, func() { rollbacks++ })
	spec := testV1EntrySpec(301, 9301, 59301)
	resolveActionJobHandoff(actionJob{
		action:          action{Op: "apply", Fxp: &spec},
		previousRuntime: localActionRuntimeSnapshot{handoffState: state},
		resultReady:     true,
	}, true)
	state.runRollback()
	if commits != 0 || rollbacks != 0 {
		t.Fatalf("successful FXP target finalized the old snapshot commits=%d rollbacks=%d", commits, rollbacks)
	}
}

func TestAbandonedFXPTargetRollsBackAfterRuntimePrerequisite(t *testing.T) {
	rolledBack := make(chan struct{}, 1)
	state := &actionHandoffState{}
	state.setFinalizers(nil, func() { rolledBack <- struct{}{} })
	runtimeResult := newActionJobResult()
	spec := testV1EntrySpec(302, 9302, 59302)
	resolveActionJobHandoff(actionJob{
		action:          action{Op: "apply", Fxp: &spec},
		previousRuntime: localActionRuntimeSnapshot{handoffState: state},
		resultPrereqs:   []*actionJobResult{runtimeResult},
	}, false)

	select {
	case <-rolledBack:
		t.Fatal("abandoned target rolled back before its runtime prerequisite completed")
	case <-time.After(20 * time.Millisecond):
	}
	runtimeResult.complete(true)
	select {
	case <-rolledBack:
	case <-time.After(time.Second):
		t.Fatal("abandoned FXP target did not restore its previous runtime")
	}
}

func TestPrepareDesiredActionsSharesFourMemberFXPEntryHandoffBatch(t *testing.T) {
	const tunnelID = 303
	jobs := []actionJob{{
		action: action{Op: "apply", StatusType: "runtime", ForwardType: "nginx-runtime-sync"},
	}}
	for index := 0; index < 4; index++ {
		ruleID := 9401 + index
		port := 59401 + index
		jobs = append(jobs, actionJob{
			action: action{
				Op:          "apply",
				StatusType:  "rule",
				RuleID:      ruleID,
				TunnelID:    tunnelID,
				SourcePort:  port,
				Protocol:    "both",
				ForwardType: "nginx",
			},
			previousRuntime: localActionRuntimeSnapshot{
				valid:        true,
				ruleID:       ruleID,
				tunnelID:     tunnelID,
				forwardType:  "forwardx",
				protocol:     "both",
				hasProtocol:  true,
				handoffState: &actionHandoffState{},
			},
		})
	}

	prepared := prepareDesiredActionJobsWithOwnerResolver(jobs, nil)
	if len(prepared) != 9 {
		t.Fatalf("prepared jobs=%d, want 4 handoffs + runtime + 4 targets", len(prepared))
	}
	var batch *actionHandoffBatch
	for index := 0; index < 4; index++ {
		job := prepared[index]
		if !job.action.HandoffOnly {
			t.Fatalf("job %d is not a handoff: %#v", index, job.action)
		}
		current := job.previousRuntime.handoffState.handoffBatch()
		if current == nil {
			t.Fatalf("handoff %d has no shared batch", index)
		}
		if batch == nil {
			batch = current
		} else if current != batch {
			t.Fatalf("handoff %d uses a different batch", index)
		}
	}
	batch.mu.Lock()
	participants := batch.participants
	guardActions := append([]action(nil), batch.guardActions...)
	batch.mu.Unlock()
	if participants != 4 {
		t.Fatalf("batch participants=%d, want 4", participants)
	}
	if len(guardActions) != 4 {
		t.Fatalf("batch guard actions=%d, want 4", len(guardActions))
	}
	for index, guard := range guardActions {
		if guard.RuleID != 9401+index || guard.SourcePort != 59401+index {
			t.Fatalf("batch guard %d=%#v", index, guard)
		}
	}
}

func TestSharedRuntimeSuccessWaitsForConcreteTargetHandoffResult(t *testing.T) {
	for _, testCase := range []struct {
		name     string
		targetOK bool
	}{
		{name: "success", targetOK: true},
		{name: "failure", targetOK: false},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			const tunnelID = 304
			target := action{
				Op:          "apply",
				StatusType:  "rule",
				RuleID:      9501,
				TunnelID:    tunnelID,
				SourcePort:  59501,
				Protocol:    "both",
				ForwardType: "nginx",
			}
			jobs := []actionJob{
				{action: action{Op: "apply", StatusType: "runtime", ForwardType: "nginx-runtime-sync"}},
				{
					action: target,
					previousRuntime: localActionRuntimeSnapshot{
						valid:        true,
						ruleID:       target.RuleID,
						tunnelID:     tunnelID,
						forwardType:  "forwardx",
						protocol:     "both",
						hasProtocol:  true,
						handoffState: &actionHandoffState{},
					},
				},
			}
			prepared := prepareDesiredActionJobsWithOwnerResolver(jobs, nil)
			if len(prepared) != 3 || !prepared[0].action.HandoffOnly {
				t.Fatalf("unexpected prepared jobs: %#v", prepared)
			}
			batch := prepared[0].previousRuntime.handoffState.handoffBatch()
			if batch == nil {
				t.Fatal("target handoff has no batch")
			}
			finalized := make(chan bool, 1)
			batch.finalizeForTest = func(success bool, _ Config, _ []fxpSpec, _ []fxpRuntimeSelector) {
				finalized <- success
			}

			prepared[0].result.complete(true)
			resolveActionJobPrerequisites(prepared[1], true)
			select {
			case <-finalized:
				t.Fatal("shared runtime success finalized handoff before the target")
			default:
			}

			targetJob := prepared[2]
			targetJob.resultReady = true
			resolveActionJobHandoff(targetJob, testCase.targetOK)
			select {
			case success := <-finalized:
				if success != testCase.targetOK {
					t.Fatalf("handoff success=%v, want %v", success, testCase.targetOK)
				}
			case <-time.After(time.Second):
				t.Fatal("target result did not finalize handoff")
			}
		})
	}
}

func resetHandoffActionEpochForTest(t *testing.T) {
	t.Helper()
	actionEpochMu.Lock()
	previous := latestActionIssuedAt
	latestActionIssuedAt = map[string]int64{}
	actionEpochMu.Unlock()
	t.Cleanup(func() {
		actionEpochMu.Lock()
		latestActionIssuedAt = previous
		actionEpochMu.Unlock()
	})
}

func waitForActionSerialRefs(t *testing.T, key string, want int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		actionSerialMu.Lock()
		lock := actionSerialLocks[key]
		refs := 0
		if lock != nil {
			refs = lock.refs
		}
		actionSerialMu.Unlock()
		if refs >= want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("serial lock %s did not reach %d references", key, want)
}
