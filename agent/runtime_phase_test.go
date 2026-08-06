package main

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPrepareDesiredActionJobsAddsSharedRuntimePhase(t *testing.T) {
	portDone := make(chan struct{})
	pluginDone := make(chan struct{})
	nginxDone := make(chan struct{})
	gostDone := make(chan struct{})
	jobs := []actionJob{
		{action: action{StatusType: "rule", ForwardType: "nginx", SourcePort: 9911}, done: portDone},
		{action: action{StatusType: "runtime", ForwardType: "plugin-sync:test"}, done: pluginDone},
		{action: action{StatusType: "runtime", ForwardType: "nginx-runtime-sync"}, done: nginxDone},
		{action: action{StatusType: "runtime", ForwardType: "gost-runtime-sync"}, done: gostDone},
	}

	prepared := prepareDesiredActionJobs(jobs)
	if len(prepared) != 4 {
		t.Fatalf("prepared jobs = %d, want 4", len(prepared))
	}
	if !isSharedRuntimeSyncAction(prepared[0].action) || !isSharedRuntimeSyncAction(prepared[1].action) {
		t.Fatalf("shared runtime jobs were not placed first: %#v", prepared)
	}
	var pluginJob actionJob
	var portJob actionJob
	for _, job := range prepared[2:] {
		if job.action.ForwardType == "plugin-sync:test" {
			pluginJob = job
		} else if job.action.ForwardType == "nginx" {
			portJob = job
		}
	}
	if len(pluginJob.prerequisites) != 0 {
		t.Fatalf("unrelated plugin prerequisites = %d, want 0", len(pluginJob.prerequisites))
	}
	if len(portJob.prerequisites) != 1 {
		t.Fatalf("port prerequisites = %d, want 1", len(portJob.prerequisites))
	}
	if len(portJob.resultPrereqs) != 1 {
		t.Fatalf("port result prerequisites = %d, want 1", len(portJob.resultPrereqs))
	}
	var nginxResult *actionJobResult
	var gostResult *actionJobResult
	for _, job := range prepared[:2] {
		switch job.action.ForwardType {
		case "nginx-runtime-sync":
			nginxResult = job.result
		case "gost-runtime-sync":
			gostResult = job.result
		}
	}
	if nginxResult == nil || gostResult == nil {
		t.Fatal("shared runtime result handles were not prepared")
	}

	released := make(chan struct{})
	go func() {
		waitForActionPrerequisites(portJob)
		close(released)
	}()
	gostResult.complete(false)
	close(gostDone)
	select {
	case <-released:
		t.Fatal("port job was released before its nginx runtime completed")
	case <-time.After(20 * time.Millisecond):
	}
	nginxResult.complete(true)
	close(nginxDone)
	select {
	case <-released:
	case <-time.After(time.Second):
		t.Fatal("port job did not resume after shared runtimes completed")
	}
}

func TestSharedRuntimeActionRequiredByCurrentAndPreviousOwners(t *testing.T) {
	nginxRuntime := action{StatusType: "runtime", ForwardType: "nginx-runtime-sync"}
	gostRuntime := action{StatusType: "runtime", ForwardType: "gost-runtime-sync"}
	forwardXV1 := action{Op: "apply", StatusType: "rule", ForwardType: "forwardx", SourcePort: 15991}
	realm := action{Op: "apply", StatusType: "rule", ForwardType: "realm", SourcePort: 15992}

	tests := []struct {
		name      string
		runtime   action
		dependent action
		oldOwner  string
		required  bool
	}{
		{name: "nginx to forwardx v1", runtime: nginxRuntime, dependent: forwardXV1, oldOwner: "nginx", required: true},
		{name: "nginx transition ignores gost", runtime: gostRuntime, dependent: forwardXV1, oldOwner: "nginx", required: false},
		{name: "gost to realm", runtime: gostRuntime, dependent: realm, oldOwner: "gost-tunnel", required: true},
		{name: "gost transition ignores nginx", runtime: nginxRuntime, dependent: realm, oldOwner: "gost", required: false},
		{name: "nginx target keeps existing direction", runtime: nginxRuntime, dependent: action{Op: "apply", StatusType: "rule", ForwardType: "nginx", SourcePort: 15993}, oldOwner: "realm", required: true},
		{name: "gost target keeps existing direction", runtime: gostRuntime, dependent: action{Op: "apply", StatusType: "rule", ForwardType: "gost", SourcePort: 15994}, oldOwner: "socat", required: true},
		{name: "nginx-backed guard follows nginx", runtime: nginxRuntime, dependent: action{Op: "apply", StatusType: "rule", ForwardType: "guard", RuntimeBackendForwardType: "nginx", SourcePort: 15995}, oldOwner: "realm", required: true},
		{name: "nginx-backed guard ignores gost", runtime: gostRuntime, dependent: action{Op: "apply", StatusType: "rule", ForwardType: "guard", RuntimeBackendForwardType: "nginx", SourcePort: 15995}, oldOwner: "realm", required: false},
		{name: "gost-backed guard follows gost", runtime: gostRuntime, dependent: action{Op: "apply", StatusType: "rule", ForwardType: "guard", RuntimeBackendForwardType: "gost", SourcePort: 15996}, oldOwner: "realm", required: true},
		{name: "kernel guard has no shared runtime", runtime: gostRuntime, dependent: action{Op: "apply", StatusType: "rule", ForwardType: "guard", SourcePort: 15997}, oldOwner: "realm", required: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := sharedRuntimeActionRequiredBy(test.runtime, test.dependent, test.oldOwner); got != test.required {
				t.Fatalf("required=%v, want %v", got, test.required)
			}
		})
	}
}

func TestPrepareDesiredActionJobsLinksOnlyRelevantPreviousOwnerRuntime(t *testing.T) {
	nginxDone := make(chan struct{})
	gostDone := make(chan struct{})
	entry := fxpSpec{Role: "entry", TransportVersion: "v1", TunnelID: 991, RuleID: 9911, ListenPort: 15995, Protocol: "tcp"}
	jobs := []actionJob{
		{action: action{StatusType: "runtime", ForwardType: "nginx-runtime-sync"}, done: nginxDone},
		{action: action{StatusType: "runtime", ForwardType: "gost-runtime-sync"}, done: gostDone},
		{action: action{Op: "apply", StatusType: "rule", RuleID: 9911, TunnelID: 991, ForwardType: "forwardx", SourcePort: 15995, Protocol: "tcp", Fxp: &entry}},
		{action: action{Op: "apply", StatusType: "rule", RuleID: 9912, ForwardType: "realm", SourcePort: 15996, Protocol: "tcp"}},
		{action: action{Op: "apply", StatusType: "rule", RuleID: 9913, ForwardType: "nginx", SourcePort: 15997, Protocol: "tcp"}},
	}
	prepared := prepareDesiredActionJobsWithOwnerResolver(jobs, func(a action) string {
		switch a.RuleID {
		case 9911:
			return "nginx"
		case 9912:
			return "gost"
		default:
			return "realm"
		}
	})

	var nginxResult *actionJobResult
	var gostResult *actionJobResult
	perRule := map[int]actionJob{}
	for _, job := range prepared {
		switch job.action.ForwardType {
		case "nginx-runtime-sync":
			nginxResult = job.result
		case "gost-runtime-sync":
			gostResult = job.result
		default:
			if job.action.RuleID > 0 && !job.action.HandoffOnly {
				perRule[job.action.RuleID] = job
			}
		}
	}
	if nginxResult == nil || gostResult == nil {
		t.Fatal("shared runtime jobs have no result handles")
	}
	requireOnlyRuntimeDependency(t, perRule[9911], nginxDone, nginxResult)
	requireOnlyRuntimeDependency(t, perRule[9912], gostDone, gostResult)
	requireOnlyRuntimeDependency(t, perRule[9913], nginxDone, nginxResult)

	nginxResult.complete(true)
	close(nginxDone)
	gostResult.complete(false)
	close(gostDone)
	if !waitForActionPrerequisites(perRule[9911]) {
		t.Fatal("Nginx to ForwardX V1 was blocked by an unrelated Gost runtime failure")
	}
	if waitForActionPrerequisites(perRule[9912]) {
		t.Fatal("Gost to Realm ignored its relevant Gost runtime failure")
	}
	if !waitForActionPrerequisites(perRule[9913]) {
		t.Fatal("Nginx target was blocked by an unrelated Gost runtime failure")
	}
}

func requireOnlyRuntimeDependency(t *testing.T, job actionJob, done <-chan struct{}, result *actionJobResult) {
	t.Helper()
	if len(job.prerequisites) != 1 || job.prerequisites[0] != done {
		t.Fatalf("done prerequisites=%d, want only selected runtime", len(job.prerequisites))
	}
	if len(job.resultPrereqs) != 1 || job.resultPrereqs[0] != result {
		t.Fatalf("result prerequisites=%d, want only selected runtime", len(job.resultPrereqs))
	}
}

func TestPrepareDesiredActionJobsOrdersOneWaySharedRuntimeTransition(t *testing.T) {
	gostDone := make(chan struct{})
	nginxDone := make(chan struct{})
	target := action{Op: "apply", StatusType: "rule", RuleID: 9961, ForwardType: "nginx", SourcePort: 15961, Protocol: "tcp"}
	prepared := prepareDesiredActionJobsWithOwnerResolver([]actionJob{
		{action: action{Op: "apply", StatusType: "runtime", ForwardType: "gost-runtime-sync"}, done: gostDone},
		{action: action{Op: "apply", StatusType: "runtime", ForwardType: "nginx-runtime-sync"}, done: nginxDone},
		{
			action: target,
			previousRuntime: localActionRuntimeSnapshot{
				valid:        true,
				ruleID:       target.RuleID,
				forwardType:  "gost",
				protocol:     "tcp",
				hasProtocol:  true,
				handoffState: &actionHandoffState{},
			},
		},
	}, nil)

	var gostJob actionJob
	var nginxJob actionJob
	var handoffResult *actionJobResult
	for _, job := range prepared {
		switch job.action.ForwardType {
		case "gost-runtime-sync":
			gostJob = job
		case "nginx-runtime-sync":
			nginxJob = job
		default:
			if job.action.HandoffOnly {
				handoffResult = job.result
			}
		}
	}
	if gostJob.result == nil || nginxJob.result == nil || handoffResult == nil {
		t.Fatal("prepared transition is missing runtime or handoff results")
	}
	if !actionJobHasDonePrerequisite(nginxJob, gostDone) || !actionJobHasResultPrerequisite(nginxJob, gostJob.result) {
		t.Fatal("new Nginx runtime does not wait for the old Gost runtime result")
	}
	if actionJobHasDonePrerequisite(gostJob, nginxDone) || actionJobHasResultPrerequisite(gostJob, nginxJob.result) {
		t.Fatal("old Gost runtime unexpectedly depends on the new Nginx runtime")
	}

	handoffResult.complete(true)
	released := make(chan bool, 1)
	go func() { released <- waitForActionPrerequisites(nginxJob) }()
	select {
	case <-released:
		t.Fatal("new Nginx runtime started before old Gost runtime completed")
	case <-time.After(20 * time.Millisecond):
	}
	gostJob.result.complete(true)
	close(gostDone)
	select {
	case ok := <-released:
		if !ok {
			t.Fatal("successful old Gost runtime blocked the new Nginx runtime")
		}
	case <-time.After(time.Second):
		t.Fatal("new Nginx runtime did not resume after old Gost runtime completed")
	}
}

func TestPrepareDesiredActionJobsAvoidsCycleForBidirectionalSharedRuntimeTransition(t *testing.T) {
	gostDone := make(chan struct{})
	nginxDone := make(chan struct{})
	prepared := prepareDesiredActionJobsWithOwnerResolver([]actionJob{
		{action: action{Op: "apply", StatusType: "runtime", ForwardType: "gost-runtime-sync"}, done: gostDone},
		{action: action{Op: "apply", StatusType: "runtime", ForwardType: "nginx-runtime-sync"}, done: nginxDone},
		{
			action:          action{Op: "apply", StatusType: "rule", RuleID: 9971, ForwardType: "nginx", SourcePort: 15971, Protocol: "tcp"},
			previousRuntime: localActionRuntimeSnapshot{valid: true, ruleID: 9971, forwardType: "gost", protocol: "tcp", hasProtocol: true, handoffState: &actionHandoffState{}},
		},
		{
			action:          action{Op: "apply", StatusType: "rule", RuleID: 9972, ForwardType: "gost", SourcePort: 15972, Protocol: "tcp"},
			previousRuntime: localActionRuntimeSnapshot{valid: true, ruleID: 9972, forwardType: "nginx", protocol: "tcp", hasProtocol: true, handoffState: &actionHandoffState{}},
		},
	}, nil)

	var gostJob actionJob
	var nginxJob actionJob
	var handoffResults []*actionJobResult
	for _, job := range prepared {
		switch job.action.ForwardType {
		case "gost-runtime-sync":
			gostJob = job
		case "nginx-runtime-sync":
			nginxJob = job
		default:
			if job.action.HandoffOnly {
				handoffResults = append(handoffResults, job.result)
			}
		}
	}
	if len(handoffResults) != 2 || gostJob.result == nil || nginxJob.result == nil {
		t.Fatalf("unexpected bidirectional transition jobs: handoffs=%d", len(handoffResults))
	}
	if actionJobHasDonePrerequisite(gostJob, nginxDone) || actionJobHasResultPrerequisite(gostJob, nginxJob.result) ||
		actionJobHasDonePrerequisite(nginxJob, gostDone) || actionJobHasResultPrerequisite(nginxJob, gostJob.result) {
		t.Fatal("bidirectional shared-runtime transition created a dependency cycle")
	}
	for _, result := range handoffResults {
		result.complete(true)
	}
	if !waitForActionPrerequisites(gostJob) || !waitForActionPrerequisites(nginxJob) {
		t.Fatal("stopped bidirectional owners did not release both runtime jobs")
	}
}

func TestSharedRuntimeHandoffStopsOnlyProcessAndRestartsOnRollback(t *testing.T) {
	previousStop := stopManagedServiceProcessForHandoff
	previousRestart := restartManagedServiceProcessForHandoff
	var stopped []string
	var restarted []string
	stopManagedServiceProcessForHandoff = func(name string) bool {
		stopped = append(stopped, name)
		return true
	}
	restartManagedServiceProcessForHandoff = func(name string) {
		restarted = append(restarted, name)
	}
	t.Cleanup(func() {
		stopManagedServiceProcessForHandoff = previousStop
		restartManagedServiceProcessForHandoff = previousRestart
	})

	state := &actionHandoffState{}
	previous := &localActionRuntimeSnapshot{
		valid:        true,
		ruleID:       9981,
		forwardType:  "gost",
		protocol:     "tcp",
		hasProtocol:  true,
		handoffState: state,
	}
	target := action{Op: "apply", StatusType: "rule", RuleID: 9981, ForwardType: "nginx", SourcePort: 15981, Protocol: "tcp", HandoffOnly: true}
	if !stopPreviousSharedRuntimeForHandoff(target, previous, newActionMessage()) {
		t.Fatal("shared runtime handoff failed")
	}
	if len(stopped) != 1 || stopped[0] != runtimeServiceName {
		t.Fatalf("stopped services=%v, want only %s", stopped, runtimeServiceName)
	}
	if len(restarted) != 0 {
		t.Fatalf("old service restarted before rollback: %v", restarted)
	}
	state.runRollback()
	if len(restarted) != 1 || restarted[0] != runtimeServiceName {
		t.Fatalf("rollback restarted services=%v, want only %s", restarted, runtimeServiceName)
	}

	stopShell := managedServiceStopShell(nginxServiceName)
	for _, destructive := range []string{" disable ", "rm -f", "rc-update del", "update-rc.d -f", "chkconfig"} {
		if strings.Contains(stopShell, destructive) {
			t.Fatalf("process-only stop shell contains destructive service mutation %q: %s", destructive, stopShell)
		}
	}
}

func TestQueuedOwnerSnapshotSurvivesDesiredMarkerReplacement(t *testing.T) {
	a := action{
		Op:          "apply",
		StatusType:  "rule",
		RuleID:      9941,
		TunnelID:    994,
		ForwardType: "nginx-tunnel",
		SourcePort:  15998,
		Protocol:    "both",
	}
	previous := localActionRuntimeSnapshot{
		valid:       true,
		ruleID:      a.RuleID,
		tunnelID:    a.TunnelID,
		forwardType: "forwardx",
		protocol:    "both",
		hasProtocol: true,
	}
	if !shouldUsePreviousRuleRuntime(
		a,
		a.RuleID,
		a.ForwardType,
		a.TunnelID,
		a.Protocol,
		true,
		&previous,
		false,
	) {
		t.Fatal("queued ForwardX owner was lost after the marker changed to the desired Nginx owner")
	}
	if shouldUsePreviousRuleRuntime(
		a,
		a.RuleID,
		a.ForwardType,
		a.TunnelID,
		a.Protocol,
		true,
		&previous,
		true,
	) {
		t.Fatal("a healthy desired listener was replaced using a stale queued owner")
	}
}

func TestForcedRuntimeSyncCannotBeAdoptedFromOldSuccessRecord(t *testing.T) {
	forced := action{StatusType: "runtime", ForwardType: "nginx-runtime-sync", ForceRuntimeSync: true}
	if desiredActionRecordConsistent(forced, nil) {
		t.Fatal("forced runtime reconciliation was treated as already consistent")
	}
	ordinary := action{StatusType: "runtime", ForwardType: "nginx-runtime-sync"}
	if !desiredActionRecordConsistent(ordinary, nil) {
		t.Fatal("ordinary runtime action lost its idempotent record behavior")
	}
	missingManagedConfig := action{
		Op:          "apply",
		StatusType:  "runtime",
		ForwardType: "gost-runtime-sync",
		ManagedConfigs: []managedConfigSpec{{
			Path:        filepath.Join(t.TempDir(), "missing.json"),
			ServiceName: runtimeServiceName,
		}},
	}
	if desiredActionRecordConsistent(missingManagedConfig, nil) {
		t.Fatal("runtime action adopted an old success record after its managed config disappeared")
	}
}

func TestWireGuardIdentityReplacementForcesV2Dependents(t *testing.T) {
	const tunnelID = 99201
	privateKey, publicKey := testWireGuardKeyPair(t)
	replacementPrivateKey, _ := testWireGuardKeyPair(t)
	current := wireGuardSpec{
		TunnelID:   tunnelID,
		PrivateKey: privateKey,
		PublicKey:  publicKey,
		Address:    "100.120.0.1",
		MTU:        1380,
	}
	normalized, err := normalizeWireGuardSpec(current)
	if err != nil {
		t.Fatal(err)
	}
	runtime := newTestWireGuardRuntimeState(tunnelID)
	runtime.spec = normalized
	runtime.signature = wireGuardSpecSignature(normalized)
	setTestWireGuardRuntime(t, tunnelID, runtime)
	t.Cleanup(runtime.close)

	replacement := current
	replacement.PrivateKey = replacementPrivateKey
	runtimeAction := action{
		Op:          "apply",
		StatusType:  "runtime",
		ForwardType: "forwardx-wireguard",
		TunnelID:    tunnelID,
		WireGuard:   &replacement,
	}
	replacements := desiredWireGuardReplacementTunnels([]action{runtimeAction})
	if !replacements[tunnelID] {
		t.Fatal("WireGuard private-key replacement was not detected")
	}

	v2 := testV2EntrySpec(tunnelID, 7201, 57201, "exit")
	v2Action := action{Op: "apply", StatusType: "rule", ForwardType: "forwardx", TunnelID: tunnelID, Fxp: &v2}
	if !desiredActionNeedsWireGuardReplacementReapply(v2Action, replacements) {
		t.Fatal("V2 FXP action could still be skipped by an old success record or runtime adoption")
	}

	v1 := v2
	v1.TransportVersion = "v1"
	v1Action := v2Action
	v1Action.Fxp = &v1
	if desiredActionNeedsWireGuardReplacementReapply(v1Action, replacements) {
		t.Fatal("V1 FXP action was coupled to a WireGuard replacement")
	}

	otherTunnel := v2
	otherTunnel.TunnelID++
	otherAction := v2Action
	otherAction.TunnelID = otherTunnel.TunnelID
	otherAction.Fxp = &otherTunnel
	if desiredActionNeedsWireGuardReplacementReapply(otherAction, replacements) {
		t.Fatal("an unrelated tunnel was forced to restart")
	}
}

func TestWireGuardNonIdentityUpdateKeepsV2Runtime(t *testing.T) {
	const tunnelID = 99202
	privateKey, publicKey := testWireGuardKeyPair(t)
	current := wireGuardSpec{
		TunnelID:   tunnelID,
		PrivateKey: privateKey,
		PublicKey:  publicKey,
		Address:    "100.121.0.1",
		ListenPort: 52001,
		MTU:        1380,
	}
	normalized, err := normalizeWireGuardSpec(current)
	if err != nil {
		t.Fatal(err)
	}
	runtime := newTestWireGuardRuntimeState(tunnelID)
	runtime.spec = normalized
	runtime.signature = wireGuardSpecSignature(normalized)
	setTestWireGuardRuntime(t, tunnelID, runtime)
	t.Cleanup(runtime.close)

	updated := current
	updated.ListenPort++
	a := action{Op: "apply", StatusType: "runtime", ForwardType: "forwardx-wireguard", TunnelID: tunnelID, WireGuard: &updated}
	if replacements := desiredWireGuardReplacementTunnels([]action{a}); replacements[tunnelID] {
		t.Fatal("an in-place WireGuard listen-port update was treated as an identity replacement")
	}
}
