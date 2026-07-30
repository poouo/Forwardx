package main

import (
	"reflect"
	"testing"
)

func TestTransitionFXPSelectorKeepsSiblingsRunningWithoutAnotherAction(t *testing.T) {
	testCases := []struct {
		name             string
		transportVersion string
	}{
		{name: "v1", transportVersion: "v1"},
		{name: "v2", transportVersion: forwardXWireGuardVersion},
	}

	for index, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			target := testV1EntrySpec(120+index, 5000+index*10, 53000+index*10)
			target.TransportVersion = testCase.transportVersion
			sibling := testV1EntrySpec(target.TunnelID, target.RuleID+1, target.ListenPort+1)
			sibling.TransportVersion = testCase.transportVersion
			targetGroup, ok := buildSharedFXPEntryGroup([]fxpSpec{target, sibling}, target.TunnelID, testCase.transportVersion)
			if !ok {
				t.Fatal("target entry group is invalid")
			}
			unrelated := testV1EntrySpec(target.TunnelID+100, target.RuleID+100, target.ListenPort+100)
			unrelated.TransportVersion = testCase.transportVersion
			unrelatedGroup, ok := buildSharedFXPEntryGroup([]fxpSpec{unrelated}, unrelated.TunnelID, testCase.transportVersion)
			if !ok {
				t.Fatal("unrelated entry group is invalid")
			}

			selector := fxpRuntimeSelector{role: "entry", tunnelID: target.TunnelID, ruleID: target.RuleID, listenPort: target.ListenPort, protocol: target.Protocol}
			started := make([]fxpSpec, 0)
			stopped := make([]fxpSpec, 0)
			if !transitionFXPSelectorLocked(
				selector,
				[]fxpSpec{targetGroup, unrelatedGroup},
				func(spec fxpSpec, _ *actionMessage) bool {
					started = append(started, spec)
					return true
				},
				func(spec fxpSpec) bool {
					stopped = append(stopped, spec)
					return true
				},
				newActionMessage(),
			) {
				t.Fatal("entry group handoff failed")
			}
			if len(stopped) != 0 {
				t.Fatalf("multi-member group was stopped instead of rebuilt: %#v", stopped)
			}
			if len(started) != 1 {
				t.Fatalf("replacement starts=%d, want one", len(started))
			}
			replacement := started[0]
			if len(replacement.Entries) != 1 || !fxpEntryGroupContains(replacement, sibling) || fxpEntryGroupContains(replacement, target) {
				t.Fatalf("replacement did not keep exactly the sibling: %#v", replacement.Entries)
			}
			if replacement.TunnelID != targetGroup.TunnelID || replacement.TransportVersion != targetGroup.TransportVersion {
				t.Fatalf("replacement changed group identity: %#v", replacement)
			}
		})
	}
}

func TestTransitionFXPSelectorPropagatesLastMemberStopFailure(t *testing.T) {
	target := testV1EntrySpec(129, 5901, 53901)
	group, ok := buildSharedFXPEntryGroup([]fxpSpec{target}, target.TunnelID, target.TransportVersion)
	if !ok {
		t.Fatal("entry group is invalid")
	}
	selector := fxpRuntimeSelector{role: "entry", tunnelID: target.TunnelID, ruleID: target.RuleID, listenPort: target.ListenPort, protocol: target.Protocol}
	startCalls := 0
	stopCalls := 0
	if transitionFXPSelectorLocked(
		selector,
		[]fxpSpec{group},
		func(spec fxpSpec, _ *actionMessage) bool {
			startCalls++
			return fxpServerSignature(spec) == fxpServerSignature(group)
		},
		func(fxpSpec) bool {
			stopCalls++
			return false
		},
		newActionMessage(),
	) {
		t.Fatal("failed last-member stop was reported as successful")
	}
	if stopCalls != 1 || startCalls != 1 {
		t.Fatalf("stop calls=%d rollback starts=%d, want 1/1", stopCalls, startCalls)
	}
}

func TestTransitionFXPSelectorRestoresOriginalGroupWhenSiblingRebuildFails(t *testing.T) {
	target := testV1EntrySpec(129, 5902, 53902)
	sibling := testV1EntrySpec(target.TunnelID, 5903, 53903)
	group, ok := buildSharedFXPEntryGroup([]fxpSpec{target, sibling}, target.TunnelID, target.TransportVersion)
	if !ok {
		t.Fatal("entry group is invalid")
	}
	selector := fxpRuntimeSelector{role: "entry", tunnelID: target.TunnelID, ruleID: target.RuleID, listenPort: target.ListenPort, protocol: target.Protocol}
	starts := make([]fxpSpec, 0, 2)
	if transitionFXPSelectorLocked(
		selector,
		[]fxpSpec{group},
		func(spec fxpSpec, _ *actionMessage) bool {
			starts = append(starts, spec)
			return fxpServerSignature(spec) == fxpServerSignature(group)
		},
		func(fxpSpec) bool {
			t.Fatal("multi-member group was stopped")
			return false
		},
		newActionMessage(),
	) {
		t.Fatal("failed sibling rebuild was reported as successful")
	}
	if len(starts) != 2 || len(starts[0].Entries) != 1 || fxpServerSignature(starts[1]) != fxpServerSignature(group) {
		t.Fatalf("starts=%#v, want reduced group followed by original rollback", starts)
	}
}

func TestTransitionFXPSelectorKeepsUDPEntryOnSameNumericPort(t *testing.T) {
	const sharedPort = 53911
	tcpEntry := testV1EntrySpec(130, 5911, sharedPort)
	tcpEntry.Protocol = "tcp"
	udpEntry := testV1EntrySpec(tcpEntry.TunnelID, 5912, sharedPort)
	udpEntry.Protocol = "udp"
	udpEntry.UDPListenPort = sharedPort
	group, ok := buildSharedFXPEntryGroup([]fxpSpec{tcpEntry, udpEntry}, tcpEntry.TunnelID, tcpEntry.TransportVersion)
	if !ok {
		t.Fatal("mixed-protocol entry group is invalid")
	}
	selector := fxpRuntimeSelector{role: "entry", tunnelID: tcpEntry.TunnelID, ruleID: tcpEntry.RuleID, listenPort: sharedPort, protocol: "tcp"}
	var replacement fxpSpec
	if !transitionFXPSelectorLocked(
		selector,
		[]fxpSpec{group},
		func(spec fxpSpec, _ *actionMessage) bool {
			replacement = spec
			return true
		},
		func(fxpSpec) bool {
			t.Fatal("mixed-protocol group was stopped")
			return false
		},
		newActionMessage(),
	) {
		t.Fatal("mixed-protocol handoff failed")
	}
	if len(replacement.Entries) != 1 || !fxpEntryGroupContains(replacement, udpEntry) || fxpEntryGroupContains(replacement, tcpEntry) {
		t.Fatalf("TCP handoff did not retain the UDP sibling: %#v", replacement.Entries)
	}
}

func TestStopStaleForwardXRuleRuntimeRejectsUnrelatedOwners(t *testing.T) {
	entry := testV1EntrySpec(130, 6001, 54001)
	group, ok := buildSharedFXPEntryGroup([]fxpSpec{entry}, entry.TunnelID, entry.TransportVersion)
	if !ok {
		t.Fatal("entry group is invalid")
	}

	id := fxpServerID(group)
	withTestFXPServers(t, map[string]*fxpProcess{id: {spec: group}})
	for _, call := range []struct {
		forwardType string
		ruleID      int
		listenPort  int
	}{
		{forwardType: "nginx", ruleID: entry.RuleID, listenPort: entry.ListenPort},
		{forwardType: "forwardx", ruleID: 0, listenPort: entry.ListenPort},
		{forwardType: "forwardx", ruleID: entry.RuleID, listenPort: 0},
	} {
		if !stopStaleForwardXRuleRuntime(Config{}, call.forwardType, call.ruleID, entry.TunnelID, call.listenPort, entry.Protocol, newActionMessage()) {
			t.Fatal("invalid handoff selector failed")
		}
	}

	fxpMu.Lock()
	_, running := fxpServers[id]
	fxpMu.Unlock()
	if !running {
		t.Fatal("invalid or non-ForwardX handoff stopped an unrelated entry group")
	}
}

func TestStopFXPByListenPortMatchesSecondaryUDPListener(t *testing.T) {
	usePersistentRuntimeTestDirs(t)
	entry := testV2EntrySpec(131, 6101, 54101, "exit-v2")
	entry.Protocol = "udp"
	entry.UDPListenPort = 54102
	group, ok := buildSharedFXPEntryGroup([]fxpSpec{entry}, entry.TunnelID, entry.TransportVersion)
	if !ok {
		t.Fatal("UDP entry group is invalid")
	}
	if err := persistFXPSpec(group); err != nil {
		t.Fatalf("persist UDP entry group: %v", err)
	}

	id := fxpServerID(group)
	withTestFXPServers(t, map[string]*fxpProcess{id: {spec: group}})
	stopFXPByListenPort(entry.UDPListenPort)

	fxpMu.Lock()
	_, running := fxpServers[id]
	fxpMu.Unlock()
	if running {
		t.Fatalf("entry group owning UDP port %d is still running", entry.UDPListenPort)
	}
}

func TestStopStaleForwardXRuleRuntimeKeepsDisjointProtocolOwner(t *testing.T) {
	usePersistentRuntimeTestDirs(t)
	const sharedPort = 54111
	tcpEntry := testV1EntrySpec(151, 6301, sharedPort)
	tcpEntry.Protocol = "tcp"
	tcpGroup, ok := buildSharedFXPEntryGroup([]fxpSpec{tcpEntry}, tcpEntry.TunnelID, tcpEntry.TransportVersion)
	if !ok {
		t.Fatal("TCP entry group is invalid")
	}
	udpEntry := testV1EntrySpec(152, 6302, sharedPort)
	udpEntry.Protocol = "udp"
	udpEntry.UDPListenPort = sharedPort
	udpGroup, ok := buildSharedFXPEntryGroup([]fxpSpec{udpEntry}, udpEntry.TunnelID, udpEntry.TransportVersion)
	if !ok {
		t.Fatal("UDP entry group is invalid")
	}
	for _, group := range []fxpSpec{tcpGroup, udpGroup} {
		if err := persistFXPSpec(group); err != nil {
			t.Fatalf("persist entry group: %v", err)
		}
	}

	tcpID := fxpServerID(tcpGroup)
	udpID := fxpServerID(udpGroup)
	withTestFXPServers(t, map[string]*fxpProcess{
		tcpID: {spec: tcpGroup},
		udpID: {spec: udpGroup},
	})
	if !stopStaleForwardXRuleRuntime(Config{}, "forwardx", tcpEntry.RuleID, tcpEntry.TunnelID, sharedPort, "tcp", newActionMessage()) {
		t.Fatal("TCP handoff failed")
	}

	fxpMu.Lock()
	_, tcpRunning := fxpServers[tcpID]
	_, udpRunning := fxpServers[udpID]
	fxpMu.Unlock()
	if tcpRunning {
		t.Fatal("selected TCP entry group is still running")
	}
	if !udpRunning {
		t.Fatal("disjoint UDP entry group on the same numeric port was stopped")
	}
}

func TestForwardXTunnelHandoffCommitRemovesOnlyMatchingPersistentRuntime(t *testing.T) {
	usePersistentRuntimeTestDirs(t)
	const sharedPort = 54121
	exit := testV1TunnelExitSpec(153, sharedPort, "tcp")
	udpRelay := testV1TunnelRelaySpec(exit.TunnelID, sharedPort, "udp")
	for _, spec := range []fxpSpec{exit, udpRelay} {
		if err := persistFXPSpec(spec); err != nil {
			t.Fatalf("persist FXP tunnel runtime: %v", err)
		}
	}
	exitID := fxpServerID(exit)
	udpRelayID := fxpServerID(udpRelay)
	withTestFXPServers(t, map[string]*fxpProcess{
		exitID:     {spec: exit},
		udpRelayID: {spec: udpRelay},
	})

	state := &actionHandoffState{}
	if !stopStaleForwardXTunnelRuntimeWithRollback(
		Config{},
		"forwardx-tunnel",
		exit.TunnelID,
		sharedPort,
		"tcp",
		newActionMessage(),
		state,
	) {
		t.Fatal("transactional FXP tunnel handoff failed")
	}
	if !state.managesFXPPersistence() {
		t.Fatal("FXP tunnel handoff did not retain a recovery transaction")
	}
	fxpMu.Lock()
	_, exitRunning := fxpServers[exitID]
	_, udpRelayRunning := fxpServers[udpRelayID]
	fxpMu.Unlock()
	if exitRunning || !udpRelayRunning {
		t.Fatalf("post-handoff runtimes exit=%v udpRelay=%v, want false/true", exitRunning, udpRelayRunning)
	}

	target := action{Op: "apply", StatusType: "tunnel", TunnelID: exit.TunnelID, SourcePort: sharedPort, Protocol: "tcp", ForwardType: "gost-tunnel"}
	resolveActionJobHandoff(actionJob{
		action:          target,
		previousRuntime: localActionRuntimeSnapshot{handoffState: state},
		resultReady:     true,
	}, true)

	loaded := loadPersistedFXPSpecs()
	if matches := fxpSpecsMatchingSelector(fxpRuntimeSelector{tunnelID: exit.TunnelID, listenPort: sharedPort, protocol: "tcp"}, loaded); len(matches) != 0 {
		t.Fatalf("successful GOST tunnel handoff left the old TCP FXP snapshot: %#v", matches)
	}
	if matches := fxpSpecsMatchingSelector(fxpRuntimeSelector{tunnelID: udpRelay.TunnelID, listenPort: sharedPort, protocol: "udp"}, loaded); len(matches) != 1 || fxpServerID(matches[0]) != udpRelayID {
		t.Fatalf("successful TCP handoff removed the disjoint UDP FXP snapshot: %#v", matches)
	}
}

func TestForwardXTunnelHandoffFailureRestoresPreviousRuntime(t *testing.T) {
	usePersistentRuntimeTestDirs(t)
	exit := testV1TunnelExitSpec(154, 54122, "tcp")
	if err := persistFXPSpec(exit); err != nil {
		t.Fatalf("persist FXP tunnel runtime: %v", err)
	}
	exitID := fxpServerID(exit)
	withTestFXPServers(t, map[string]*fxpProcess{
		exitID: {spec: exit},
	})

	previousRestore := restoreFXPHandoffOriginalsForHandoff
	restored := make([]fxpSpec, 0)
	restoreFXPHandoffOriginalsForHandoff = func(_ Config, originals []fxpSpec) {
		restored = append(restored, originals...)
		fxpMu.Lock()
		for _, original := range originals {
			fxpServers[fxpServerID(original)] = &fxpProcess{spec: original}
		}
		fxpMu.Unlock()
	}
	t.Cleanup(func() {
		restoreFXPHandoffOriginalsForHandoff = previousRestore
	})

	state := &actionHandoffState{}
	if !stopStaleForwardXTunnelRuntimeWithRollback(
		Config{},
		"forwardx-tunnel",
		exit.TunnelID,
		exit.ListenPort,
		exit.Protocol,
		newActionMessage(),
		state,
	) {
		t.Fatal("transactional FXP tunnel handoff failed")
	}
	fxpMu.Lock()
	_, runningBeforeRollback := fxpServers[exitID]
	fxpMu.Unlock()
	if runningBeforeRollback {
		t.Fatal("old FXP tunnel runtime was not stopped before GOST sync")
	}

	target := action{Op: "apply", StatusType: "tunnel", TunnelID: exit.TunnelID, SourcePort: exit.ListenPort, Protocol: exit.Protocol, ForwardType: "gost-tunnel"}
	resolveActionJobHandoff(actionJob{
		action:          target,
		previousRuntime: localActionRuntimeSnapshot{handoffState: state},
		resultReady:     true,
	}, false)

	if len(restored) != 1 || fxpServerID(restored[0]) != exitID {
		t.Fatalf("failed GOST tunnel handoff restored %#v, want %s", restored, exitID)
	}
	fxpMu.Lock()
	_, runningAfterRollback := fxpServers[exitID]
	fxpMu.Unlock()
	if !runningAfterRollback {
		t.Fatal("failed GOST tunnel handoff did not restore the old FXP runtime")
	}
	if matches := fxpSpecsMatchingSelector(fxpRuntimeSelector{tunnelID: exit.TunnelID, listenPort: exit.ListenPort, protocol: exit.Protocol}, loadPersistedFXPSpecs()); len(matches) != 1 {
		t.Fatalf("failed GOST tunnel handoff lost its recovery snapshot: %#v", matches)
	}
}

func TestFXPSpecsUsingListenPortPrefersCurrentRuntimeOverStaleSnapshot(t *testing.T) {
	currentEntry := testV1EntrySpec(132, 6201, 54201)
	currentGroup, ok := buildSharedFXPEntryGroup([]fxpSpec{currentEntry}, currentEntry.TunnelID, currentEntry.TransportVersion)
	if !ok {
		t.Fatal("current entry group is invalid")
	}
	staleEntry := testV1EntrySpec(currentEntry.TunnelID, 6202, 54202)
	staleGroup, ok := buildSharedFXPEntryGroup([]fxpSpec{currentEntry, staleEntry}, currentEntry.TunnelID, currentEntry.TransportVersion)
	if !ok {
		t.Fatal("stale entry group is invalid")
	}

	if specs := fxpSpecsUsingListenPort(staleEntry.ListenPort, []fxpSpec{currentGroup}, nil, []fxpSpec{staleGroup}); len(specs) != 0 {
		t.Fatalf("stale snapshot overrode current runtime generation: %#v", specs)
	}
	if specs := fxpSpecsUsingListenPort(staleEntry.ListenPort, nil, nil, []fxpSpec{staleGroup}); len(specs) != 1 || fxpServerID(specs[0]) != fxpServerID(staleGroup) {
		t.Fatalf("orphaned runtime was not discoverable from persistence: %#v", specs)
	}
}

func TestFXPSpecsUsingListenPortUsesNewestAvailableGroupGeneration(t *testing.T) {
	const targetPort = 54201

	oldLiveMember := testV1EntrySpec(140, 6201, targetPort)
	currentLiveMember := oldLiveMember
	currentLiveMember.ListenPort = 54202
	oldLiveGroup, ok := buildSharedFXPEntryGroup([]fxpSpec{oldLiveMember}, oldLiveMember.TunnelID, "v1")
	if !ok {
		t.Fatal("old live group is invalid")
	}
	currentLiveGroup, ok := buildSharedFXPEntryGroup([]fxpSpec{currentLiveMember}, currentLiveMember.TunnelID, "v1")
	if !ok {
		t.Fatal("current live group is invalid")
	}

	oldRuntimeMember := testV1EntrySpec(141, 6211, targetPort)
	currentRuntimeMember := oldRuntimeMember
	currentRuntimeMember.ListenPort = 54203
	oldRuntimeGroup, ok := buildSharedFXPEntryGroup([]fxpSpec{oldRuntimeMember}, oldRuntimeMember.TunnelID, "v1")
	if !ok {
		t.Fatal("old runtime group is invalid")
	}
	currentRuntimeGroup, ok := buildSharedFXPEntryGroup([]fxpSpec{currentRuntimeMember}, currentRuntimeMember.TunnelID, "v1")
	if !ok {
		t.Fatal("current runtime group is invalid")
	}

	v1RuntimeMember := testV1EntrySpec(142, 6221, targetPort)
	v1RuntimeGroup, ok := buildSharedFXPEntryGroup([]fxpSpec{v1RuntimeMember}, v1RuntimeMember.TunnelID, "v1")
	if !ok {
		t.Fatal("V1 runtime group is invalid")
	}
	v2PersistedMember := testV2EntrySpec(143, 6231, targetPort, "exit-v2")
	v2PersistedSibling := testV2EntrySpec(143, 6232, targetPort+10, "exit-v2-sibling")
	v2PersistedGroup, ok := buildSharedFXPEntryGroup(
		[]fxpSpec{v2PersistedMember, v2PersistedSibling},
		v2PersistedMember.TunnelID,
		forwardXWireGuardVersion,
	)
	if !ok {
		t.Fatal("V2 persisted group is invalid")
	}
	unrelated := testV1EntrySpec(144, 6241, targetPort+20)
	unrelatedGroup, ok := buildSharedFXPEntryGroup([]fxpSpec{unrelated}, unrelated.TunnelID, "v1")
	if !ok {
		t.Fatal("unrelated group is invalid")
	}

	got := fxpSpecsUsingListenPort(
		targetPort,
		[]fxpSpec{currentLiveGroup},
		[]fxpSpec{oldLiveGroup, currentRuntimeGroup, v1RuntimeGroup},
		[]fxpSpec{oldRuntimeGroup, v2PersistedGroup, unrelatedGroup},
	)
	gotIDs := make([]string, 0, len(got))
	for _, spec := range got {
		gotIDs = append(gotIDs, fxpServerID(spec))
	}
	wantIDs := []string{fxpServerID(v1RuntimeGroup), fxpServerID(v2PersistedGroup)}
	if !reflect.DeepEqual(gotIDs, wantIDs) {
		t.Fatalf("selected FXP groups=%v, want %v", gotIDs, wantIDs)
	}
}

func TestFXPSpecsUsingListenPortMatchesSecondaryUDPPortWithoutOtherGroups(t *testing.T) {
	udpEntry := testV2EntrySpec(145, 6251, 54301, "exit-v2")
	udpEntry.Protocol = "udp"
	udpEntry.UDPListenPort = 54302
	udpGroup, ok := buildSharedFXPEntryGroup([]fxpSpec{udpEntry}, udpEntry.TunnelID, udpEntry.TransportVersion)
	if !ok {
		t.Fatal("UDP group is invalid")
	}
	unrelated := testV2EntrySpec(146, 6261, 54303, "exit-v2-other")
	unrelatedGroup, ok := buildSharedFXPEntryGroup([]fxpSpec{unrelated}, unrelated.TunnelID, unrelated.TransportVersion)
	if !ok {
		t.Fatal("unrelated group is invalid")
	}

	got := fxpSpecsUsingListenPort(udpEntry.UDPListenPort, []fxpSpec{udpGroup, unrelatedGroup})
	if len(got) != 1 || fxpServerID(got[0]) != fxpServerID(udpGroup) {
		t.Fatalf("selected groups=%#v, want only UDP group %s", got, fxpServerID(udpGroup))
	}
}

func TestFXPSpecsWithRunningProcessRejectsStaleSnapshots(t *testing.T) {
	runningEntry := testV1EntrySpec(147, 6271, 54311)
	runningGroup, ok := buildSharedFXPEntryGroup([]fxpSpec{runningEntry}, runningEntry.TunnelID, runningEntry.TransportVersion)
	if !ok {
		t.Fatal("running group is invalid")
	}
	staleEntry := testV1EntrySpec(148, 6272, 54312)
	staleGroup, ok := buildSharedFXPEntryGroup([]fxpSpec{staleEntry}, staleEntry.TunnelID, staleEntry.TransportVersion)
	if !ok {
		t.Fatal("stale group is invalid")
	}

	runningPath := fxpConfigPath(runningGroup)
	got := fxpSpecsWithRunningProcess([]fxpSpec{staleGroup, runningGroup}, func(path string) bool {
		return path == runningPath
	})
	if len(got) != 1 || fxpServerID(got[0]) != fxpServerID(runningGroup) {
		t.Fatalf("verified running snapshots=%#v, want only %s", got, fxpServerID(runningGroup))
	}
}

func TestCommitFXPHandoffPersistenceRemovesOnlySelectedGroupMember(t *testing.T) {
	usePersistentRuntimeTestDirs(t)
	removed := testV1EntrySpec(160, 6401, 54401)
	retained := testV1EntrySpec(removed.TunnelID, 6402, 54402)
	group, ok := buildSharedFXPEntryGroup([]fxpSpec{removed, retained}, removed.TunnelID, removed.TransportVersion)
	if !ok {
		t.Fatal("entry group is invalid")
	}
	if !persistFXPHandoffRecoverySnapshot([]fxpSpec{group}) {
		t.Fatal("could not persist handoff recovery snapshot")
	}

	commitFXPHandoffPersistence([]fxpSpec{group}, fxpRuntimeSelector{
		role:       "entry",
		tunnelID:   removed.TunnelID,
		ruleID:     removed.RuleID,
		listenPort: removed.ListenPort,
		protocol:   removed.Protocol,
	})
	loaded := loadPersistedFXPSpecs()
	retainedOnly := false
	if len(loaded) == 1 {
		if isFXPEntryGroup(loaded[0]) {
			retainedOnly = len(loaded[0].Entries) == 1 && fxpEntryGroupContains(loaded[0], retained) && !fxpEntryGroupContains(loaded[0], removed)
		} else {
			retainedOnly = fxpEntryIdentity(loaded[0]) == fxpEntryIdentity(retained)
		}
	}
	if !retainedOnly {
		t.Fatalf("handoff persistence commit=%#v, want only retained sibling", loaded)
	}
}

func TestFXPEntryGroupHandoffBatchCommitsFourMemberSwitch(t *testing.T) {
	usePersistentRuntimeTestDirs(t)
	group, selectors := testFourMemberFXPHandoffGroup(t, 160, 6401, 54401)
	batch, states := prepareTestFXPHandoffBatch(t, group, selectors, []int{0, 1, 2, 3})

	for index := 0; index < len(states)-1; index++ {
		states[index].runCommit()
	}
	if loaded := loadPersistedFXPSpecs(); len(loaded) != 4 {
		t.Fatalf("batch committed before every member resolved: %#v", loaded)
	}
	states[len(states)-1].runCommit()
	if loaded := loadPersistedFXPSpecs(); len(loaded) != 0 {
		t.Fatalf("successful four-member switch left stale FXP snapshots: %#v", loaded)
	}

	batch.mu.Lock()
	resolved := batch.resolved
	batch.mu.Unlock()
	if resolved != 4 {
		t.Fatalf("batch resolved=%d, want 4", resolved)
	}
}

func TestFXPEntryGroupHandoffBatchFailureRestoresCompleteFourMemberSnapshot(t *testing.T) {
	usePersistentRuntimeTestDirs(t)
	group, selectors := testFourMemberFXPHandoffGroup(t, 161, 6501, 54501)
	batch, states := prepareTestFXPHandoffBatch(t, group, selectors, []int{2, 0, 3, 1})
	finalizations := 0
	batch.finalizeForTest = func(success bool, _ Config, originals []fxpSpec, _ []fxpRuntimeSelector) {
		finalizations++
		if success {
			t.Fatal("failed batch finalized as success")
		}
		if len(originals) != 1 || len(normalizeFXPSpec(originals[0]).Entries) != 4 {
			t.Fatalf("rollback originals=%#v, want the complete four-member group", originals)
		}
		for _, original := range originals {
			if err := persistFXPSpec(original); err != nil {
				t.Fatalf("restore test snapshot: %v", err)
			}
		}
	}

	states[2].runCommit()
	states[0].runRollback()
	states[3].runCommit()
	if finalizations != 0 {
		t.Fatal("failed batch finalized before every member resolved")
	}
	states[1].runCommit()
	if finalizations != 1 {
		t.Fatalf("batch finalizations=%d, want 1", finalizations)
	}
	loaded := loadPersistedFXPSpecs()
	if len(loaded) != 4 {
		t.Fatalf("failed batch restored %d members, want 4: %#v", len(loaded), loaded)
	}
}

func TestFXPEntryGroupHandoffBatchOutOfOrderCompletionIsIdempotent(t *testing.T) {
	usePersistentRuntimeTestDirs(t)
	group, selectors := testFourMemberFXPHandoffGroup(t, 162, 6601, 54601)
	batch, states := prepareTestFXPHandoffBatch(t, group, selectors, []int{3, 1, 0, 2})
	finalizations := 0
	batch.finalizeForTest = func(success bool, _ Config, originals []fxpSpec, gotSelectors []fxpRuntimeSelector) {
		finalizations++
		if !success || len(originals) != 1 || len(gotSelectors) != 4 {
			t.Fatalf("out-of-order finalization success=%v originals=%d selectors=%d", success, len(originals), len(gotSelectors))
		}
		commitFXPHandoffBatchPersistence(originals, gotSelectors)
	}

	for _, index := range []int{1, 3, 0, 2} {
		states[index].runCommit()
		states[index].runRollback()
	}
	if finalizations != 1 {
		t.Fatalf("out-of-order batch finalizations=%d, want 1", finalizations)
	}
	if loaded := loadPersistedFXPSpecs(); len(loaded) != 0 {
		t.Fatalf("out-of-order successful batch left snapshots: %#v", loaded)
	}
}

func TestFXPHandoffBatchCommitRemovesSelectorWithoutLiveOriginal(t *testing.T) {
	usePersistentRuntimeTestDirs(t)
	removed := testV1EntrySpec(165, 6801, 54801)
	retained := testV1EntrySpec(removed.TunnelID, 6802, 54802)
	group, ok := buildSharedFXPEntryGroup([]fxpSpec{removed, retained}, removed.TunnelID, removed.TransportVersion)
	if !ok {
		t.Fatal("entry group is invalid")
	}
	if err := persistFXPSpec(group); err != nil {
		t.Fatalf("persist stale group: %v", err)
	}

	commitFXPHandoffBatchPersistence(nil, []fxpRuntimeSelector{{
		role:       "entry",
		tunnelID:   removed.TunnelID,
		ruleID:     removed.RuleID,
		listenPort: removed.ListenPort,
		protocol:   removed.Protocol,
	}})
	loaded := loadPersistedFXPSpecs()
	if len(loaded) != 1 || fxpEntryIdentity(loaded[0]) != fxpEntryIdentity(retained) {
		t.Fatalf("batch commit without live original=%#v, want retained sibling", loaded)
	}
}

func TestManagedFXPHandoffDefersGenericPersistenceCleanup(t *testing.T) {
	usePersistentRuntimeTestDirs(t)
	removed := testV1EntrySpec(166, 6901, 54901)
	retained := testV1EntrySpec(removed.TunnelID, 6902, 54902)
	group, ok := buildSharedFXPEntryGroup([]fxpSpec{removed, retained}, removed.TunnelID, removed.TransportVersion)
	if !ok {
		t.Fatal("entry group is invalid")
	}
	if err := persistFXPSpec(group); err != nil {
		t.Fatalf("persist recovery group: %v", err)
	}

	state := &actionHandoffState{}
	state.attachBatch(newActionHandoffBatch())
	cleanupSupersededFXPPersistence(action{
		Op:         "apply",
		SourcePort: removed.ListenPort,
		Protocol:   removed.Protocol,
	}, &localActionRuntimeSnapshot{handoffState: state})
	if loaded := loadPersistedFXPSpecs(); len(loaded) != 2 {
		t.Fatalf("managed handoff removed recovery snapshot early: %#v", loaded)
	}

	cleanupSupersededFXPPersistence(action{
		Op:         "apply",
		SourcePort: removed.ListenPort,
		Protocol:   removed.Protocol,
	}, nil)
	loaded := loadPersistedFXPSpecs()
	if len(loaded) != 1 || fxpEntryIdentity(loaded[0]) != fxpEntryIdentity(retained) {
		t.Fatalf("unmanaged cleanup=%#v, want retained sibling", loaded)
	}
}

func TestFXPTransitionRollbackKeepsTransactionalRestoreOutOfPersistence(t *testing.T) {
	previous := testV1EntrySpec(163, 6701, 54701)
	conflict := testV1EntrySpec(164, 6702, 54702)
	persistence := make([]bool, 0, 2)
	restoreFXPTransitionLockedWithStarter(
		Config{},
		fxpSpec{},
		false,
		&previous,
		[]fxpSpec{conflict},
		nil,
		false,
		func(_ Config, _ fxpSpec, _ *actionMessage, enabled bool) bool {
			persistence = append(persistence, enabled)
			return true
		},
	)
	if len(persistence) != 2 {
		t.Fatalf("transaction rollback restores=%d, want 2", len(persistence))
	}
	for index, enabled := range persistence {
		if enabled {
			t.Fatalf("transaction rollback restore %d overwrote the full recovery snapshot", index)
		}
	}
}

func testV1TunnelExitSpec(tunnelID int, listenPort int, protocol string) fxpSpec {
	return normalizeFXPSpec(fxpSpec{
		Role:             "exit",
		TransportVersion: "v1",
		TunnelID:         tunnelID,
		ListenPort:       listenPort,
		Protocol:         protocol,
		Key:              "tunnel-handoff-exit-key",
	})
}

func testV1TunnelRelaySpec(tunnelID int, listenPort int, protocol string) fxpSpec {
	return normalizeFXPSpec(fxpSpec{
		Role:             "relay",
		TransportVersion: "v1",
		TunnelID:         tunnelID,
		ListenPort:       listenPort,
		Protocol:         protocol,
		RelayExitHost:    "198.51.100.20",
		RelayExitPort:    24001,
		RelayKey:         "tunnel-handoff-relay-key",
		Key:              "tunnel-handoff-relay-listen-key",
	})
}

func testFourMemberFXPHandoffGroup(t *testing.T, tunnelID int, firstRuleID int, firstPort int) (fxpSpec, []fxpRuntimeSelector) {
	t.Helper()
	entries := make([]fxpSpec, 0, 4)
	selectors := make([]fxpRuntimeSelector, 0, 4)
	for index := 0; index < 4; index++ {
		entry := testV1EntrySpec(tunnelID, firstRuleID+index, firstPort+index)
		entries = append(entries, entry)
		selectors = append(selectors, fxpRuntimeSelector{
			role:       "entry",
			tunnelID:   tunnelID,
			ruleID:     entry.RuleID,
			listenPort: entry.ListenPort,
			protocol:   entry.Protocol,
		})
	}
	group, ok := buildSharedFXPEntryGroup(entries, tunnelID, "v1")
	if !ok {
		t.Fatal("four-member FXP entry group is invalid")
	}
	return group, selectors
}

func prepareTestFXPHandoffBatch(t *testing.T, group fxpSpec, selectors []fxpRuntimeSelector, transitionOrder []int) (*actionHandoffBatch, []*actionHandoffState) {
	t.Helper()
	batch := newActionHandoffBatch()
	states := make([]*actionHandoffState, len(selectors))
	for index := range states {
		states[index] = &actionHandoffState{}
		batch.addParticipant()
		states[index].attachBatch(batch)
	}
	current := group
	for _, index := range transitionOrder {
		if index < 0 || index >= len(selectors) {
			t.Fatalf("invalid transition index %d", index)
		}
		if !batch.prepareFXPTransition(Config{}, []fxpSpec{current}, selectors[index]) {
			t.Fatalf("prepare handoff transition %d", index)
		}
		next, removed := fxpEntryGroupWithoutSelector(current, selectors[index])
		if !removed {
			t.Fatalf("selector %d did not remove its group member", index)
		}
		current = next
	}
	return batch, states
}

func withTestFXPServers(t *testing.T, servers map[string]*fxpProcess) {
	t.Helper()
	fxpMu.Lock()
	previous := fxpServers
	fxpServers = servers
	fxpMu.Unlock()
	t.Cleanup(func() {
		fxpMu.Lock()
		fxpServers = previous
		fxpMu.Unlock()
	})
}
