package main

import (
	"fmt"
	"testing"
)

func testV1EntrySpec(tunnelID, ruleID, port int) fxpSpec {
	return fxpSpec{
		Role:             "entry",
		TransportVersion: "v1",
		TunnelID:         tunnelID,
		RuleID:           ruleID,
		ListenPort:       port,
		Protocol:         "both",
		ExitHost:         "198.51.100.10",
		ExitPort:         24000,
		TargetIP:         "203.0.113.10",
		TargetPort:       25565,
		Key:              "entry-group-test-key",
	}
}

func testV2EntrySpec(tunnelID, ruleID, port int, peerID string) fxpSpec {
	spec := testV1EntrySpec(tunnelID, ruleID, port)
	spec.TransportVersion = forwardXWireGuardVersion
	spec.ExitPeerID = peerID
	return spec
}

func requireFXPEntryGroupMembers(t *testing.T, group fxpSpec, want ...fxpSpec) {
	t.Helper()
	if len(group.Entries) != len(want) {
		t.Fatalf("group entries=%d, want %d: %#v", len(group.Entries), len(want), group.Entries)
	}
	for _, expected := range want {
		if !fxpEntryGroupContains(group, expected) {
			t.Fatalf("group does not contain tunnel=%d rule=%d port=%d version=%s: %#v", expected.TunnelID, expected.RuleID, expected.ListenPort, expected.TransportVersion, group.Entries)
		}
	}
}

func TestPersistedFXPRestorePlanGroupsManyEntriesByTunnelAndTransport(t *testing.T) {
	const entryCount = 512
	specs := make([]fxpSpec, 0, entryCount+2)
	for index := 0; index < entryCount; index++ {
		specs = append(specs, testV1EntrySpec(71, 1000+index, 30000+index))
	}
	specs = append(specs,
		fxpSpec{Role: "exit", TransportVersion: "v1", TunnelID: 71, ListenPort: 24000, Protocol: "both", Key: "exit-key"},
		fxpSpec{Role: "entry", TransportVersion: "v2", TunnelID: 72, RuleID: 9000, ListenPort: 42000, Protocol: "tcp", Key: "v2-key"},
	)

	planned := planPersistedFXPRestoreSpecs(specs)
	if len(planned) != 3 {
		t.Fatalf("restore runtimes=%d, want V1 and V2 entry groups plus one standalone exit", len(planned))
	}
	groupSizes := map[string]int{}
	for _, spec := range planned {
		if isFXPEntryGroup(spec) {
			groupSizes[fxpEntryGroupKey(spec.TransportVersion, spec.TunnelID)] = len(spec.Entries)
		}
	}
	if groupSizes[fxpEntryGroupKey("v1", 71)] != entryCount || groupSizes[fxpEntryGroupKey("v2", 72)] != 1 {
		t.Fatalf("unexpected grouped restore plan: %#v", groupSizes)
	}
	var group *fxpSpec
	for index := range planned {
		if isFXPEntryGroup(planned[index]) {
			group = &planned[index]
			break
		}
	}
	if group == nil || group.TunnelID != 71 || len(group.Entries) != entryCount {
		t.Fatalf("unexpected V1 entry group: %#v", group)
	}
	if got := fxpServerID(*group); got != fxpEntryGroupServerID("v1", 71) {
		t.Fatalf("group server ID=%q", got)
	}
	if got := fxpConfigPath(group.Entries[entryCount-1]); got != fxpConfigPath(*group) {
		t.Fatalf("entry config path=%q, group config path=%q", got, fxpConfigPath(*group))
	}
}

func TestDesiredStateStagesV2EntriesInOneTransportSpecificGroup(t *testing.T) {
	usePersistentRuntimeTestDirs(t)

	actions := make([]action, 0, 256)
	for index := 0; index < 256; index++ {
		spec := testV1EntrySpec(82, 3000+index, 44000+index)
		spec.TransportVersion = "v2"
		spec.ExitPeerID = "900"
		actions = append(actions, action{
			Op: "apply", StatusType: "rule", ForwardType: "forwardx",
			TunnelID: spec.TunnelID, RuleID: spec.RuleID, SourcePort: spec.ListenPort,
			Protocol: spec.Protocol, Fxp: &spec,
		})
	}

	attachDesiredSharedFXPEntryGroups(actions)
	group := actions[len(actions)-1].FXPEntryGroup
	if group == nil || group.TransportVersion != "v2" || len(group.Entries) != len(actions) {
		t.Fatalf("unexpected V2 entry group: %#v", group)
	}
	if got := fxpConfigPath(*group); got != "/run/forwardx-agent/fxp-entry-group-v2-82.json" {
		t.Fatalf("V2 group config path=%q", got)
	}
}

func TestDesiredV2EntryGroupAttachmentRemainsLocalToItsBatch(t *testing.T) {
	usePersistentRuntimeTestDirs(t)

	first := testV2EntrySpec(85, 3401, 45401, "exit-a")
	second := testV2EntrySpec(85, 3402, 45402, "exit-b")
	firstBatch := []action{
		{Op: "apply", Fxp: &first},
		{Op: "apply", Fxp: &second},
	}
	attachDesiredSharedFXPEntryGroups(firstBatch)
	if firstBatch[0].FXPEntryGroup == nil || firstBatch[1].FXPEntryGroup == nil {
		t.Fatal("first V2 batch has no attached group")
	}
	requireFXPEntryGroupMembers(t, *firstBatch[0].FXPEntryGroup, first, second)

	replacement := second
	replacement.ListenPort = 45412
	secondBatch := []action{{Op: "apply", Fxp: &replacement}}
	attachDesiredSharedFXPEntryGroups(secondBatch)
	if secondBatch[0].FXPEntryGroup == nil {
		t.Fatal("second V2 batch has no attached group")
	}
	requireFXPEntryGroupMembers(t, *secondBatch[0].FXPEntryGroup, replacement)

	// A later desired-state batch must not overwrite a group already carried by
	// an action queued from an earlier batch.
	requireFXPEntryGroupMembers(t, *firstBatch[0].FXPEntryGroup, first, second)
}

func TestDesiredEntryGroupDropsMemberReplacedByNonFXPAction(t *testing.T) {
	usePersistentRuntimeTestDirs(t)
	first := testV1EntrySpec(86, 3501, 45501)
	second := testV1EntrySpec(86, 3502, 45502)
	initial, ok := buildSharedFXPEntryGroup([]fxpSpec{first, second}, first.TunnelID, first.TransportVersion)
	if !ok {
		t.Fatal("initial entry group is invalid")
	}
	if err := persistFXPSpec(initial); err != nil {
		t.Fatal(err)
	}

	actions := []action{
		{Op: "apply", StatusType: "rule", ForwardType: "nginx", TunnelID: first.TunnelID, RuleID: first.RuleID, SourcePort: first.ListenPort, Protocol: first.Protocol},
		{Op: "apply", StatusType: "rule", ForwardType: "forwardx", TunnelID: second.TunnelID, RuleID: second.RuleID, SourcePort: second.ListenPort, Protocol: second.Protocol, Fxp: &second},
	}
	attachDesiredSharedFXPEntryGroups(actions)
	if actions[1].FXPEntryGroup == nil {
		t.Fatal("remaining ForwardX action has no desired entry group")
	}
	requireFXPEntryGroupMembers(t, *actions[1].FXPEntryGroup, second)
	if fxpEntryGroupContains(*actions[1].FXPEntryGroup, first) {
		t.Fatal("desired entry group retained the member replaced by Nginx")
	}
}

func TestDesiredV2EntryGroupLifecycleAddUpdateAndRemove(t *testing.T) {
	usePersistentRuntimeTestDirs(t)

	first := testV2EntrySpec(83, 3101, 45101, "exit-a")
	second := testV2EntrySpec(83, 3102, 45102, "exit-b")
	initial, ok := buildSharedFXPEntryGroup([]fxpSpec{first}, first.TunnelID, first.TransportVersion)
	if !ok {
		t.Fatal("initial V2 entry group is invalid")
	}
	if err := persistFXPSpec(initial); err != nil {
		t.Fatal(err)
	}

	addActions := []action{{Op: "apply", Fxp: &second}}
	attachDesiredSharedFXPEntryGroups(addActions)
	if addActions[0].FXPEntryGroup == nil {
		t.Fatal("V2 add did not stage a shared entry group")
	}
	added := *addActions[0].FXPEntryGroup
	requireFXPEntryGroupMembers(t, added, first, second)
	if added.TransportVersion != forwardXWireGuardVersion {
		t.Fatalf("added group transport=%q, want %q", added.TransportVersion, forwardXWireGuardVersion)
	}
	if err := persistFXPSpec(added); err != nil {
		t.Fatal(err)
	}

	updatedSecond := second
	updatedSecond.ListenPort = 45112
	updatedSecond.ExitPeerID = "exit-b-new"
	updatedSecond.ExitPort = 24112
	updateActions := []action{{Op: "apply", Fxp: &updatedSecond}}
	attachDesiredSharedFXPEntryGroups(updateActions)
	if updateActions[0].FXPEntryGroup == nil {
		t.Fatal("V2 update did not stage a shared entry group")
	}
	updated := *updateActions[0].FXPEntryGroup
	requireFXPEntryGroupMembers(t, updated, first, updatedSecond)
	if fxpEntryGroupContains(updated, second) {
		t.Fatalf("V2 update retained the old rule incarnation: %#v", updated.Entries)
	}
	if err := persistFXPSpec(updated); err != nil {
		t.Fatal(err)
	}

	removeActions := []action{{Op: "remove", Fxp: &first}}
	attachDesiredSharedFXPEntryGroups(removeActions)
	if removeActions[0].FXPEntryGroup == nil {
		t.Fatal("V2 member removal did not retain the remaining group")
	}
	remaining := *removeActions[0].FXPEntryGroup
	requireFXPEntryGroupMembers(t, remaining, updatedSecond)
}

func TestRemovingLastV2EntryStopsOnlyV2GroupRuntime(t *testing.T) {
	usePersistentRuntimeTestDirs(t)

	const tunnelID = 84
	v2Entry := testV2EntrySpec(tunnelID, 3201, 45201, "exit-v2")
	v1Entry := testV1EntrySpec(tunnelID, 3202, 45202)
	v2Group, ok := buildSharedFXPEntryGroup([]fxpSpec{v2Entry}, tunnelID, forwardXWireGuardVersion)
	if !ok {
		t.Fatal("V2 entry group is invalid")
	}
	v1Group, ok := buildSharedFXPEntryGroup([]fxpSpec{v1Entry}, tunnelID, "v1")
	if !ok {
		t.Fatal("V1 entry group is invalid")
	}
	if err := persistFXPSpec(v2Group); err != nil {
		t.Fatal(err)
	}

	removeActions := []action{{Op: "remove", Fxp: &v2Entry}}
	attachDesiredSharedFXPEntryGroups(removeActions)
	if removeActions[0].FXPEntryGroup == nil || len(removeActions[0].FXPEntryGroup.Entries) != 0 {
		t.Fatalf("last V2 removal attached an invalid final group: %#v", removeActions[0].FXPEntryGroup)
	}
	v2ID := fxpServerID(v2Group)
	v1ID := fxpServerID(v1Group)
	fxpMu.Lock()
	previousV2 := fxpServers[v2ID]
	previousV1 := fxpServers[v1ID]
	fxpServers[v2ID] = &fxpProcess{spec: v2Group}
	fxpServers[v1ID] = &fxpProcess{spec: v1Group}
	fxpMu.Unlock()
	t.Cleanup(func() {
		fxpMu.Lock()
		if previousV2 == nil {
			delete(fxpServers, v2ID)
		} else {
			fxpServers[v2ID] = previousV2
		}
		if previousV1 == nil {
			delete(fxpServers, v1ID)
		} else {
			fxpServers[v1ID] = previousV1
		}
		fxpMu.Unlock()
	})

	if !stopFXP(v2Entry, removeActions[0].FXPEntryGroup, nil) {
		t.Fatal("last V2 member removal failed")
	}

	fxpMu.Lock()
	_, v2Running := fxpServers[v2ID]
	_, v1Running := fxpServers[v1ID]
	fxpMu.Unlock()
	if v2Running {
		t.Fatal("last V2 member removal left the V2 entry-group runtime running")
	}
	if !v1Running {
		t.Fatal("last V2 member removal stopped the V1 entry-group runtime")
	}
	if loaded := loadPersistedFXPSpecs(); len(loaded) != 0 {
		t.Fatalf("last V2 member removal retained snapshots: %#v", loaded)
	}
}

func TestVersionlessOrphanRemovalInfersPersistedV2Group(t *testing.T) {
	usePersistentRuntimeTestDirs(t)

	const tunnelID = 86
	v2Entry := testV2EntrySpec(tunnelID, 3601, 45601, "exit-v2")
	v2Group, ok := buildSharedFXPEntryGroup([]fxpSpec{v2Entry}, tunnelID, forwardXWireGuardVersion)
	if !ok {
		t.Fatal("V2 entry group is invalid")
	}
	if err := persistFXPSpec(v2Group); err != nil {
		t.Fatal(err)
	}

	v2ID := fxpServerID(v2Group)
	fxpMu.Lock()
	previous := fxpServers[v2ID]
	fxpServers[v2ID] = &fxpProcess{spec: v2Group}
	fxpMu.Unlock()
	t.Cleanup(func() {
		fxpMu.Lock()
		if previous == nil {
			delete(fxpServers, v2ID)
		} else {
			fxpServers[v2ID] = previous
		}
		fxpMu.Unlock()
	})

	versionlessRemoval := v2Entry
	versionlessRemoval.TransportVersion = ""
	if !stopFXP(versionlessRemoval, nil, nil) {
		t.Fatal("versionless V2 orphan removal failed")
	}

	fxpMu.Lock()
	_, running := fxpServers[v2ID]
	fxpMu.Unlock()
	if running {
		t.Fatal("versionless orphan removal left the V2 entry group running")
	}
	if loaded := loadPersistedFXPSpecs(); len(loaded) != 0 {
		t.Fatalf("versionless orphan removal retained V2 snapshots: %#v", loaded)
	}
}

func TestLocalRuntimeStateReportsV2TransportFromActiveOrPersistedGroup(t *testing.T) {
	state := localRuleState{
		Port:        "45611",
		RuleID:      3611,
		TunnelID:    87,
		ForwardType: "forwardx",
		Protocol:    "both",
	}
	v2Entry := testV2EntrySpec(state.TunnelID, state.RuleID, atoi(state.Port), "exit-v2")
	v2Group, ok := buildSharedFXPEntryGroup([]fxpSpec{v2Entry}, state.TunnelID, forwardXWireGuardVersion)
	if !ok {
		t.Fatal("V2 entry group is invalid")
	}

	if got := fxpTransportVersionForLocalRule(state, []fxpSpec{v2Group}); got != forwardXWireGuardVersion {
		t.Fatalf("active V2 group reported transport=%q", got)
	}
	if got := fxpTransportVersionForLocalRule(state, []fxpSpec{v2Entry}); got != forwardXWireGuardVersion {
		t.Fatalf("persisted V2 entry reported transport=%q", got)
	}
}

func TestDesiredStateStagesOneV1EntryGroupForManyRuleActions(t *testing.T) {
	usePersistentRuntimeTestDirs(t)

	const entryCount = 512
	actions := make([]action, 0, entryCount)
	for index := 0; index < entryCount; index++ {
		spec := testV1EntrySpec(81, 2000+index, 43000+index)
		actions = append(actions, action{
			Op: "apply", StatusType: "rule", ForwardType: "forwardx",
			TunnelID: spec.TunnelID, RuleID: spec.RuleID, SourcePort: spec.ListenPort,
			Protocol: spec.Protocol, Fxp: &spec,
		})
	}

	attachDesiredSharedFXPEntryGroups(actions)
	group := actions[entryCount-1].FXPEntryGroup
	if group == nil || len(group.Entries) != entryCount {
		t.Fatalf("unexpected staged group: %#v", group)
	}
	for index, item := range actions {
		want := fmt.Sprintf("fxp-entry-group:%d", item.TunnelID)
		found := false
		for _, key := range actionSerialKeys(item) {
			found = found || key == want
		}
		if !found {
			t.Fatalf("action %d has no shared group serial key: %v", index, actionSerialKeys(item))
		}
	}
}

func TestDesiredStateStagesLargeEntryBatchWithOneFinalSnapshot(t *testing.T) {
	usePersistentRuntimeTestDirs(t)

	const entryCount = 2048
	actions := make([]action, 0, entryCount)
	for index := 0; index < entryCount; index++ {
		spec := testV1EntrySpec(88, 10000+index, 20000+index)
		actions = append(actions, action{Op: "apply", Fxp: &spec})
	}

	attachDesiredSharedFXPEntryGroups(actions)
	for index := range actions {
		group := actions[index].FXPEntryGroup
		if group == nil || group.TunnelID != 88 || group.TransportVersion != "v1" || len(group.Entries) != entryCount {
			t.Fatalf("action %d did not receive the final %d-member snapshot: %#v", index, entryCount, group)
		}
		if group.Entries[0].RuleID != 10000 || group.Entries[entryCount-1].RuleID != 10000+entryCount-1 {
			t.Fatalf("action %d received an incomplete or unsorted snapshot", index)
		}
	}
}

func TestDesiredEntryGroupSequentialApplyReplacesRuleAndListenerConflicts(t *testing.T) {
	usePersistentRuntimeTestDirs(t)

	const tunnelID = 89
	sameRuleOld := testV1EntrySpec(tunnelID, 12001, 47001)
	sameRuleNew := sameRuleOld
	sameRuleNew.ListenPort = 47002
	tcpConflict := testV1EntrySpec(tunnelID, 12002, 47010)
	tcpConflict.Protocol = "tcp"
	udpConflict := testV1EntrySpec(tunnelID, 12003, 47011)
	udpConflict.Protocol = "udp"
	udpConflict.UDPListenPort = 47012
	unrelated := testV1EntrySpec(tunnelID, 12004, 47020)
	replacement := testV1EntrySpec(tunnelID, 12005, tcpConflict.ListenPort)
	replacement.Protocol = "both"
	replacement.UDPListenPort = udpConflict.UDPListenPort
	v2SameListeners := testV2EntrySpec(tunnelID, 12006, replacement.ListenPort, "exit-v2")
	v2SameListeners.UDPListenPort = replacement.UDPListenPort

	v1Group, ok := buildSharedFXPEntryGroup([]fxpSpec{sameRuleOld, tcpConflict, udpConflict, unrelated}, tunnelID, "v1")
	if !ok {
		t.Fatal("initial V1 entry group is invalid")
	}
	v2Group, ok := buildSharedFXPEntryGroup([]fxpSpec{v2SameListeners}, tunnelID, forwardXWireGuardVersion)
	if !ok {
		t.Fatal("initial V2 entry group is invalid")
	}
	for _, group := range []fxpSpec{v1Group, v2Group} {
		if err := persistFXPSpec(group); err != nil {
			t.Fatalf("persist %s group: %v", group.TransportVersion, err)
		}
	}

	actions := []action{
		{Op: "apply", Fxp: &sameRuleNew},
		{Op: "apply", Fxp: &replacement},
		{Op: "apply", Fxp: &v2SameListeners},
	}
	attachDesiredSharedFXPEntryGroups(actions)

	for index := 0; index < 2; index++ {
		if actions[index].FXPEntryGroup == nil {
			t.Fatalf("V1 action %d has no final group", index)
		}
		requireFXPEntryGroupMembers(t, *actions[index].FXPEntryGroup, sameRuleNew, unrelated, replacement)
		if fxpEntryGroupContains(*actions[index].FXPEntryGroup, sameRuleOld) ||
			fxpEntryGroupContains(*actions[index].FXPEntryGroup, tcpConflict) ||
			fxpEntryGroupContains(*actions[index].FXPEntryGroup, udpConflict) {
			t.Fatalf("V1 action %d retained a replaced rule or listener conflict: %#v", index, actions[index].FXPEntryGroup.Entries)
		}
	}
	if actions[2].FXPEntryGroup == nil {
		t.Fatal("V2 action has no final group")
	}
	requireFXPEntryGroupMembers(t, *actions[2].FXPEntryGroup, v2SameListeners)
}

func TestDesiredEntryGroupRemoveSupportsWildcardFieldsWithinTransport(t *testing.T) {
	usePersistentRuntimeTestDirs(t)

	const tunnelID = 90
	tcpEntry := testV1EntrySpec(tunnelID, 13001, 47101)
	tcpEntry.Protocol = "tcp"
	bothEntry := testV1EntrySpec(tunnelID, 13002, 47102)
	udpRemovedByPort := testV1EntrySpec(tunnelID, 13003, 47103)
	udpRemovedByPort.Protocol = "udp"
	udpRemovedByPort.UDPListenPort = 47203
	udpRemaining := testV1EntrySpec(tunnelID, 13004, 47104)
	udpRemaining.Protocol = "udp"
	udpRemaining.UDPListenPort = 47204
	v2Entry := testV2EntrySpec(tunnelID, 13005, tcpEntry.ListenPort, "exit-v2")

	v1Group, ok := buildSharedFXPEntryGroup([]fxpSpec{tcpEntry, bothEntry, udpRemovedByPort, udpRemaining}, tunnelID, "v1")
	if !ok {
		t.Fatal("initial V1 entry group is invalid")
	}
	v2Group, ok := buildSharedFXPEntryGroup([]fxpSpec{v2Entry}, tunnelID, forwardXWireGuardVersion)
	if !ok {
		t.Fatal("initial V2 entry group is invalid")
	}
	for _, group := range []fxpSpec{v1Group, v2Group} {
		if err := persistFXPSpec(group); err != nil {
			t.Fatalf("persist %s group: %v", group.TransportVersion, err)
		}
	}

	removeTCP := fxpSpec{Role: "entry", TransportVersion: "v1", TunnelID: tunnelID, Protocol: "tcp"}
	removeUDPPort := fxpSpec{TransportVersion: "v1", TunnelID: tunnelID, ListenPort: udpRemovedByPort.ListenPort}
	actions := []action{
		{Op: "remove", Fxp: &removeTCP},
		{Op: "remove", Fxp: &removeUDPPort},
		{Op: "apply", Fxp: &v2Entry},
	}
	attachDesiredSharedFXPEntryGroups(actions)

	for index := 0; index < 2; index++ {
		if actions[index].FXPEntryGroup == nil {
			t.Fatalf("V1 wildcard removal %d has no final group", index)
		}
		requireFXPEntryGroupMembers(t, *actions[index].FXPEntryGroup, udpRemaining)
	}
	if actions[2].FXPEntryGroup == nil {
		t.Fatal("V2 action has no final group")
	}
	requireFXPEntryGroupMembers(t, *actions[2].FXPEntryGroup, v2Entry)
}

func TestPersistingV1EntryGroupReplacesOnlyThatTunnelSnapshots(t *testing.T) {
	usePersistentRuntimeTestDirs(t)
	first := testV1EntrySpec(91, 1, 51001)
	second := testV1EntrySpec(91, 2, 51002)
	removed := testV1EntrySpec(91, 3, 51003)
	otherTunnel := testV1EntrySpec(92, 4, 51004)
	for _, spec := range []fxpSpec{first, second, removed, otherTunnel} {
		if err := persistFXPSpec(spec); err != nil {
			t.Fatal(err)
		}
	}
	group, ok := buildSharedFXPEntryGroup([]fxpSpec{first, second}, 91, "v1")
	if !ok {
		t.Fatal("expected valid entry group")
	}
	if err := persistFXPSpec(group); err != nil {
		t.Fatal(err)
	}
	loaded := loadPersistedFXPSpecs()
	if len(loaded) != 3 {
		t.Fatalf("snapshots=%d, want two grouped entries and another tunnel: %#v", len(loaded), loaded)
	}
	for _, spec := range loaded {
		if spec.RuleID == removed.RuleID && spec.TunnelID == removed.TunnelID {
			t.Fatalf("removed group entry was retained: %#v", spec)
		}
	}
}

func TestPersistedEntryGroupsKeepBothTransportsForSameTunnelInEitherSaveOrder(t *testing.T) {
	const tunnelID = 93
	v1Entry := testV1EntrySpec(tunnelID, 4101, 52101)
	v2Entry := testV2EntrySpec(tunnelID, 4102, 52102, "exit-v2")
	v1Group, ok := buildSharedFXPEntryGroup([]fxpSpec{v1Entry}, tunnelID, "v1")
	if !ok {
		t.Fatal("V1 entry group is invalid")
	}
	v2Group, ok := buildSharedFXPEntryGroup([]fxpSpec{v2Entry}, tunnelID, forwardXWireGuardVersion)
	if !ok {
		t.Fatal("V2 entry group is invalid")
	}

	for _, testCase := range []struct {
		name  string
		first fxpSpec
		last  fxpSpec
	}{
		{name: "v1-then-v2", first: v1Group, last: v2Group},
		{name: "v2-then-v1", first: v2Group, last: v1Group},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			usePersistentRuntimeTestDirs(t)
			if err := persistFXPSpec(testCase.first); err != nil {
				t.Fatalf("persist first group: %v", err)
			}
			if err := persistFXPSpec(testCase.last); err != nil {
				t.Fatalf("persist last group: %v", err)
			}

			loaded := loadPersistedFXPSpecs()
			if len(loaded) != 2 {
				t.Fatalf("loaded snapshots=%d, want both transports: %#v", len(loaded), loaded)
			}
			loadedByTransport := map[string]fxpSpec{}
			for _, spec := range loaded {
				loadedByTransport[spec.TransportVersion] = spec
			}
			if !fxpEntryMatches(loadedByTransport["v1"], v1Entry) {
				t.Fatalf("V1 snapshot was replaced by save order: %#v", loaded)
			}
			if !fxpEntryMatches(loadedByTransport[forwardXWireGuardVersion], v2Entry) {
				t.Fatalf("V2 snapshot was replaced by save order: %#v", loaded)
			}
		})
	}
}

func TestPersistedRestorePlanKeepsBothTransportsForSameTunnel(t *testing.T) {
	usePersistentRuntimeTestDirs(t)
	const tunnelID = 94
	v1Entry := testV1EntrySpec(tunnelID, 4201, 52201)
	v2Entry := testV2EntrySpec(tunnelID, 4202, 52202, "exit-v2")
	v1Group, ok := buildSharedFXPEntryGroup([]fxpSpec{v1Entry}, tunnelID, "v1")
	if !ok {
		t.Fatal("V1 entry group is invalid")
	}
	v2Group, ok := buildSharedFXPEntryGroup([]fxpSpec{v2Entry}, tunnelID, forwardXWireGuardVersion)
	if !ok {
		t.Fatal("V2 entry group is invalid")
	}
	for _, group := range []fxpSpec{v1Group, v2Group} {
		if err := persistFXPSpec(group); err != nil {
			t.Fatalf("persist %s group: %v", group.TransportVersion, err)
		}
	}

	planned := planPersistedFXPRestoreSpecs(loadPersistedFXPSpecs())
	if len(planned) != 2 {
		t.Fatalf("restore plan runtimes=%d, want one V1 and one V2 group: %#v", len(planned), planned)
	}
	plannedByTransport := map[string]fxpSpec{}
	for _, spec := range planned {
		if !isFXPEntryGroup(spec) || spec.TunnelID != tunnelID {
			t.Fatalf("unexpected restore runtime: %#v", spec)
		}
		plannedByTransport[spec.TransportVersion] = spec
	}
	requireFXPEntryGroupMembers(t, plannedByTransport["v1"], v1Entry)
	requireFXPEntryGroupMembers(t, plannedByTransport[forwardXWireGuardVersion], v2Entry)
}

func TestRemovingV1EntryDoesNotAlterSameTunnelV2Group(t *testing.T) {
	usePersistentRuntimeTestDirs(t)
	const tunnelID = 95
	v1Removed := testV1EntrySpec(tunnelID, 4301, 52301)
	v1Remaining := testV1EntrySpec(tunnelID, 4302, 52302)
	v2SameIdentity := testV2EntrySpec(tunnelID, v1Removed.RuleID, v1Removed.ListenPort, "exit-v2")
	v2Remaining := testV2EntrySpec(tunnelID, 4303, 52303, "exit-v2-other")
	v1Group, ok := buildSharedFXPEntryGroup([]fxpSpec{v1Removed, v1Remaining}, tunnelID, "v1")
	if !ok {
		t.Fatal("V1 entry group is invalid")
	}
	v2Group, ok := buildSharedFXPEntryGroup([]fxpSpec{v2SameIdentity, v2Remaining}, tunnelID, forwardXWireGuardVersion)
	if !ok {
		t.Fatal("V2 entry group is invalid")
	}
	for _, group := range []fxpSpec{v1Group, v2Group} {
		if err := persistFXPSpec(group); err != nil {
			t.Fatalf("persist %s group: %v", group.TransportVersion, err)
		}
	}

	removePersistedFXPSpec(v1Removed)
	loaded := loadPersistedFXPSpecs()
	if len(loaded) != 3 {
		t.Fatalf("snapshots after V1 removal=%d, want one V1 and both V2 members: %#v", len(loaded), loaded)
	}
	found := map[string]bool{}
	for _, spec := range loaded {
		found[fmt.Sprintf("%s:%d:%d", spec.TransportVersion, spec.RuleID, spec.ListenPort)] = true
	}
	if found[fmt.Sprintf("v1:%d:%d", v1Removed.RuleID, v1Removed.ListenPort)] {
		t.Fatalf("removed V1 member is still persisted: %#v", loaded)
	}
	for _, expected := range []fxpSpec{v1Remaining, v2SameIdentity, v2Remaining} {
		key := fmt.Sprintf("%s:%d:%d", expected.TransportVersion, expected.RuleID, expected.ListenPort)
		if !found[key] {
			t.Fatalf("removing V1 member also removed %s: %#v", key, loaded)
		}
	}
}
