package main

import (
	"os"
	"os/exec"
	"testing"
)

func TestFXPApplyGroupDoesNotResurrectReassignedListeners(t *testing.T) {
	first, moved := testV1EntrySpec(17, 1, 24001), testV1EntrySpec(17, 2, 24002)
	unknown := testV1EntrySpec(17, 3, 24003)
	group, _ := buildSharedFXPEntryGroup([]fxpSpec{first, moved, unknown}, 17, "v1")
	for _, desired := range []runningRule{
		{RuleID: 2, TunnelID: 0, SourcePort: 24002, Protocol: "both", ForwardType: "nginx"},
		{RuleID: 2, TunnelID: 18, SourcePort: 24002, Protocol: "both", ForwardType: "forwardx"},
		{RuleID: 4, TunnelID: 17, SourcePort: 24002, Protocol: "both", ForwardType: "forwardx"},
		{RuleID: 2, TunnelID: 17, SourcePort: 24002, Protocol: "tcp", ForwardType: "forwardx"},
	} {
		filtered := filterFXPApplyGroup(group, func(entry fxpSpec) (runningRule, bool) {
			return desired, entry.RuleID == moved.RuleID
		})
		requireFXPEntryGroupMembers(t, filtered, first, unknown)
	}
	// Concurrent additions with no newer assignment remain preserved.
	unchanged := filterFXPApplyGroup(group, func(entry fxpSpec) (runningRule, bool) {
		return runningRule{RuleID: entry.RuleID, TunnelID: 17, Protocol: "both", ForwardType: "forwardx"}, true
	})
	requireFXPEntryGroupMembers(t, unchanged, first, moved, unknown)
	if len(group.Entries) != 3 {
		t.Fatal("filter mutated the queued recovery snapshot")
	}
}

func TestSharedFXPApplyDoesNotScheduleUnknownListenerHandoff(t *testing.T) {
	current := testV1EntrySpec(17, 1, 24001)
	desired := current
	desired.TargetPort++
	group, ok := buildSharedFXPEntryGroup([]fxpSpec{current}, current.TunnelID, current.TransportVersion)
	if !ok {
		t.Fatal("entry group is invalid")
	}
	withTestFXPServers(t, map[string]*fxpProcess{
		fxpServerID(group): {spec: group, cmd: &exec.Cmd{Process: &os.Process{Pid: 1}}},
	})
	a := action{
		Op: "apply", StatusType: "rule", RuleID: desired.RuleID, TunnelID: desired.TunnelID,
		SourcePort: desired.ListenPort, Protocol: desired.Protocol, ForwardType: "forwardx", Fxp: &desired,
	}
	if !runningSharedFXPEntryCanApplyInPlace(a) {
		t.Fatal("tracked shared FXP member should be updated in place")
	}
	if actionJobNeedsPreRuntimeHandoffWithListenerProbe(actionJob{action: a}, func(action) bool { return true }) {
		t.Fatal("busy shared FXP member was incorrectly scheduled for destructive handoff")
	}
}
