package main

import "testing"

func resetHeartbeatStateForTest() {
	heartbeatStateMu.Lock()
	heartbeatStateCache = heartbeatStateSnapshot{}
	heartbeatStateSignatures = map[string]string{}
	heartbeatStateMu.Unlock()
}

func TestApplyHeartbeatStatePreservesOmittedSections(t *testing.T) {
	resetHeartbeatStateForTest()
	t.Cleanup(resetHeartbeatStateForTest)

	initial := applyHeartbeatState(heartbeatResp{
		RunningRules:       []runningRule{{RuleID: 1}},
		TunnelProbes:       []tunnelProbe{{TunnelID: 2}},
		ForwardGroupProbes: []forwardGroupProbe{{GroupID: 3}},
		HostProbeServices:  []hostProbeServiceProbe{{ServiceID: 4}},
		GuardRules:         []guardRule{{}},
		DNSWatch:           []dnsWatchItem{{Host: "example.test"}},
		StateSignatures: map[string]string{
			"runningRules":       "sig-running",
			"tunnelProbes":       "sig-tunnels",
			"forwardGroupProbes": "sig-groups",
			"hostProbeServices":  "sig-services",
			"guardRules":         "sig-guards",
			"dnsWatch":           "sig-dns",
		},
	})
	if len(initial.RunningRules) != 1 || len(initial.TunnelProbes) != 1 || len(initial.ForwardGroupProbes) != 1 || len(initial.HostProbeServices) != 1 {
		t.Fatalf("initial heartbeat state was not applied: %+v", initial)
	}

	preserved := applyHeartbeatState(heartbeatResp{})
	if len(preserved.RunningRules) != 1 || len(preserved.TunnelProbes) != 1 || len(preserved.ForwardGroupProbes) != 1 || len(preserved.HostProbeServices) != 1 {
		t.Fatalf("omitted state sections must preserve the previous snapshot: %+v", preserved)
	}
	if len(heartbeatStateSignaturePayload()) != 6 {
		t.Fatalf("omitted state sections must preserve their signatures")
	}
}

func TestApplyHeartbeatStateInvalidatesUnsignedReplacementSections(t *testing.T) {
	resetHeartbeatStateForTest()
	t.Cleanup(resetHeartbeatStateForTest)

	applyHeartbeatState(heartbeatResp{
		RunningRules:       []runningRule{{RuleID: 1}},
		TunnelProbes:       []tunnelProbe{{TunnelID: 2}},
		ForwardGroupProbes: []forwardGroupProbe{{GroupID: 3}},
		HostProbeServices:  []hostProbeServiceProbe{{ServiceID: 4}},
		GuardRules:         []guardRule{{}},
		DNSWatch:           []dnsWatchItem{{Host: "example.test"}},
		StateSignatures: map[string]string{
			"runningRules":       "sig-running",
			"tunnelProbes":       "sig-tunnels",
			"forwardGroupProbes": "sig-groups",
			"hostProbeServices":  "sig-services",
			"guardRules":         "sig-guards",
			"dnsWatch":           "sig-dns",
		},
	})

	cleared := applyHeartbeatState(heartbeatResp{
		RunningRules:       []runningRule{},
		TunnelProbes:       []tunnelProbe{},
		ForwardGroupProbes: []forwardGroupProbe{},
		HostProbeServices:  []hostProbeServiceProbe{},
		GuardRules:         []guardRule{},
		DNSWatch:           []dnsWatchItem{},
	})
	if len(cleared.RunningRules) != 0 || len(cleared.TunnelProbes) != 0 || len(cleared.ForwardGroupProbes) != 0 || len(cleared.HostProbeServices) != 0 {
		t.Fatalf("explicit replacement sections were not applied: %+v", cleared)
	}
	if signatures := heartbeatStateSignaturePayload(); len(signatures) != 0 {
		t.Fatalf("unsigned replacement must invalidate signatures so the panel resends state: %+v", signatures)
	}

	applyHeartbeatState(heartbeatResp{
		TunnelProbes:    []tunnelProbe{},
		StateSignatures: map[string]string{"tunnelProbes": "sig-empty-tunnels"},
	})
	if signature := heartbeatStateSignaturePayload()["tunnelProbes"]; signature != "sig-empty-tunnels" {
		t.Fatalf("signed empty state is authoritative, got signature %q", signature)
	}
}
