package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func testV3EntrySpec(tunnelID, ruleID, port int) fxpSpec {
	spec := testV1EntrySpec(tunnelID, ruleID, port)
	spec.TransportVersion = "v3"
	spec.V3Transport = "ws"
	spec.V3Host = "outer.example"
	spec.V3Path = "/stream"
	return spec
}

func TestFXPV3NormalizationAndSerializationPreserveTransport(t *testing.T) {
	no := false
	spec := testV3EntrySpec(301, 1, 23001)
	spec.TransportVersion = " V3 "
	spec.V3Transport = " WS "
	spec.V3Multiplex = &no
	normalized := normalizeFXPSpec(spec)
	if normalized.TransportVersion != "v3" || normalized.V3Transport != "ws" || validateFXPTransport(normalized) != nil {
		t.Fatalf("V3 was downgraded: %#v", normalized)
	}
	raw, err := json.Marshal(normalized)
	if err != nil {
		t.Fatal(err)
	}
	var restored fxpSpec
	if err = json.Unmarshal(raw, &restored); err != nil {
		t.Fatal(err)
	}
	if restored.V3Host != spec.V3Host || restored.V3Path != spec.V3Path || restored.V3Multiplex == nil || *restored.V3Multiplex {
		t.Fatal("V3 options lost in runtime config")
	}
	if fxpServerID(normalized) == fxpServerID(testV1EntrySpec(301, 1, 23001)) {
		t.Fatal("V3 shares V1 runtime identity")
	}
}

func TestFXPV3GroupsSupportRestoreAndAdditiveUpdates(t *testing.T) {
	first := testV3EntrySpec(302, 1, 23001)
	second := testV3EntrySpec(302, 2, 23002)
	before, ok := buildSharedFXPEntryGroup([]fxpSpec{first}, 302, "v3")
	if !ok {
		t.Fatal("V3 group not built")
	}
	after, ok := buildSharedFXPEntryGroup([]fxpSpec{first, second}, 302, "v3")
	if !ok {
		t.Fatal("V3 group addition not built")
	}
	if after.V3Transport != "ws" || after.V3Host != first.V3Host || after.V3Path != first.V3Path || validateFXPTransport(after) != nil {
		t.Fatal("group root lost required V3 settings")
	}
	requireFXPEntryGroupMembers(t, after, first, second)
	if !fxpIsAdditiveUpdate(before, after) {
		t.Fatal("V3 addition would replace healthy runtime")
	}
	plans := planPersistedFXPRestoreSpecs([]fxpSpec{first, second, testV1EntrySpec(302, 3, 23003)})
	if len(plans) != 2 {
		t.Fatal("restore mixed V3 and V1 groups", len(plans))
	}
	if !fxpRemovalMatchesEntry(fxpSpec{TransportVersion: "v3", TunnelID: 302, RuleID: 1}, first) || fxpRemovalMatchesEntry(fxpSpec{TransportVersion: "v1", TunnelID: 302, RuleID: 1}, first) {
		t.Fatal("transport-specific removal is not isolated")
	}
}

func TestFXPV3SignatureTracksAllOuterSettings(t *testing.T) {
	base := normalizeFXPSpec(testV3EntrySpec(303, 1, 23001))
	signature := fxpServerSignature(base)
	for _, change := range []func(*fxpSpec){
		func(s *fxpSpec) { s.V3Transport = "http" }, func(s *fxpSpec) { s.V3Host = "other" }, func(s *fxpSpec) { s.V3Path = "/other" },
		func(s *fxpSpec) { s.V3ServerName = "other" }, func(s *fxpSpec) { no := false; s.V3Multiplex = &no },
	} {
		other := base
		change(&other)
		if fxpServerSignature(other) == signature {
			t.Fatal("changed V3 option was ignored")
		}
	}
	yes := true
	equivalent := base
	equivalent.V3Multiplex = &yes
	if fxpServerSignature(equivalent) != signature {
		t.Fatal("default multiplex true changed runtime identity")
	}
	group, _ := buildSharedFXPEntryGroup([]fxpSpec{base}, 303, "v3")
	group.Entries = nil
	old := fxpServerSignature(group)
	group.V3Path = "/other"
	if fxpServerSignature(group) == old {
		t.Fatal("root group signature ignores V3 config")
	}
}

func TestFXPV3InvalidOptionsFailBeforeTouchingExistingRuntime(t *testing.T) {
	valid := testV3EntrySpec(304, 1, 23001)
	for _, change := range []func(*fxpSpec){
		func(s *fxpSpec) { s.TransportVersion = "v4" }, func(s *fxpSpec) { s.V3Transport = "wss" }, func(s *fxpSpec) { s.V3Transport = "" },
		func(s *fxpSpec) { s.TransportVersion = "v1" }, func(s *fxpSpec) { s.V3Path = "/bad\r\n" },
		func(s *fxpSpec) { s.V3Transport = "tls"; s.V3ServerName = "has space" },
	} {
		bad := valid
		change(&bad)
		message := &actionMessage{}
		if startFXPProcessLockedWithPersistence(Config{}, bad, message, false) {
			t.Fatal("invalid V3 config started")
		}
		if !strings.Contains(message.get(), "transport config rejected") {
			t.Fatal("invalid config reached runtime mutation", message.get())
		}
	}
	if got := normalizeFXPTransportVersion(" V4 "); got != "v4" {
		t.Fatal("unsupported version silently became V1", got)
	}
	group, _ := buildSharedFXPEntryGroup([]fxpSpec{valid}, 304, "v3")
	group.Entries[0].V3Host = "mismatched"
	if validateFXPTransport(group) == nil {
		t.Fatal("mixed V3 configuration was accepted in one tunnel group")
	}
}

func TestFXPV3LocalRuntimeReportsActualVersion(t *testing.T) {
	entry := testV3EntrySpec(305, 1, 23001)
	state := localRuleState{RuleID: 1, TunnelID: 305, Port: "23001", Protocol: "tcp", ForwardType: "forwardx"}
	if got := fxpTransportVersionForLocalRule(state, []fxpSpec{entry}); got != "v3" {
		t.Fatal("local rule reported wrong transport", got)
	}
	exit := entry
	exit.Role = "exit"
	exit.RuleID = 0
	if got := fxpTransportVersionForLocalTunnel(305, 23001, []fxpSpec{exit}); got != "v3" {
		t.Fatal("local tunnel reported wrong transport", got)
	}
}

func TestFXPLegacySignaturesDoNotGainV3Fields(t *testing.T) {
	for _, version := range []string{"v1", "v2"} {
		spec := testV1EntrySpec(306, 1, 23001)
		spec.TransportVersion = version
		before := fxpServerSignature(spec)
		if strings.Contains(before, "v3-options:") {
			t.Fatal("legacy signature changed for V3 support")
		}
		if normalizeFXPSpec(spec).TransportVersion != version || validateFXPTransport(normalizeFXPSpec(spec)) != nil {
			t.Fatal("legacy transport normalization changed")
		}
	}
}
