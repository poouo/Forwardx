package main

import (
	"testing"
	"time"
)

func tcpingGateResult(id int, timeout bool, latency int) map[string]any {
	return map[string]any{
		"ruleId": id, "tunnelId": 0, "probeKey": "rule-probe", "latencyMs": latency, "isTimeout": timeout,
	}
}

func tcpingGateHop(kind string, ownerID, hop int, topology string, timeout bool) map[string]any {
	result := map[string]any{
		"probeKey":    topology + ":hop:" + string(rune('0'+hop)),
		"topologyKey": topology,
		"hopIndex":    hop,
		"hopCount":    2,
		"latencyMs":   10 + hop,
		"isTimeout":   timeout,
	}
	if kind == "tunnel" {
		result["tunnelId"] = ownerID
	} else {
		result["groupId"] = ownerID
	}
	return result
}

func TestTCPingReportGateSuppressesStableAutoProbesButKeepsServices(t *testing.T) {
	gate := newTCPingReportGate()
	now := time.Date(2026, 7, 24, 10, 0, 0, 0, time.UTC)
	results := []map[string]any{tcpingGateResult(1, false, 10)}
	tunnels := []map[string]any{
		tcpingGateHop("tunnel", 2, 0, "tunnel-topology", false),
		tcpingGateHop("tunnel", 2, 1, "tunnel-topology", false),
	}
	groups := []map[string]any{
		tcpingGateHop("group", 3, 0, "group-topology", false),
		tcpingGateHop("group", 3, 1, "group-topology", false),
	}
	services := []map[string]any{{"serviceId": 4, "isTimeout": false}}

	first := gate.plan(results, tunnels, groups, services, false, now)
	if len(first.results) != 1 || len(first.tunnels) != 2 || len(first.forwardGroups) != 2 || len(first.services) != 1 {
		t.Fatalf("first report was not complete: %+v", first)
	}
	gate.commit(first)

	results[0]["latencyMs"] = 99
	stable := gate.plan(results, tunnels, groups, services, false, now.Add(time.Minute))
	if len(stable.results) != 0 || len(stable.tunnels) != 0 || len(stable.forwardGroups) != 0 {
		t.Fatalf("stable automatic probes were not suppressed: %+v", stable)
	}
	if len(stable.services) != 1 {
		t.Fatal("service history must preserve its configured report cadence")
	}
}

func TestTCPingReportGateSendsWholeTopologyOnFailureAndRecovery(t *testing.T) {
	gate := newTCPingReportGate()
	now := time.Date(2026, 7, 24, 10, 0, 0, 0, time.UTC)
	tunnels := []map[string]any{
		tcpingGateHop("tunnel", 2, 0, "tunnel-topology", false),
		tcpingGateHop("tunnel", 2, 1, "tunnel-topology", false),
	}
	gate.commit(gate.plan(nil, tunnels, nil, nil, false, now))

	tunnels[1]["isTimeout"] = true
	failure := gate.plan(nil, tunnels, nil, nil, false, now.Add(time.Second))
	if len(failure.tunnels) != 2 {
		t.Fatalf("failure transition must report the complete topology, got %d hops", len(failure.tunnels))
	}
	gate.commit(failure)

	tunnels[1]["isTimeout"] = false
	recovery := gate.plan(nil, tunnels, nil, nil, false, now.Add(2*time.Second))
	if len(recovery.tunnels) != 2 {
		t.Fatalf("recovery transition must report the complete topology, got %d hops", len(recovery.tunnels))
	}
}

func TestTCPingReportGateRetriesFailedPostsAndSendsFiveMinuteSnapshots(t *testing.T) {
	gate := newTCPingReportGate()
	now := time.Date(2026, 7, 24, 10, 0, 0, 0, time.UTC)
	results := []map[string]any{tcpingGateResult(1, false, 10)}

	failedPost := gate.plan(results, nil, nil, nil, false, now)
	if len(failedPost.results) != 1 {
		t.Fatal("first report should be sent")
	}
	retry := gate.plan(results, nil, nil, nil, false, now.Add(time.Second))
	if len(retry.results) != 1 {
		t.Fatal("an uncommitted report must be retried")
	}
	gate.commit(retry)

	beforeSnapshot := gate.plan(results, nil, nil, nil, false, now.Add(4*time.Minute+59*time.Second))
	if len(beforeSnapshot.results) != 0 {
		t.Fatal("stable state should remain quiet before the snapshot deadline")
	}
	snapshot := gate.plan(results, nil, nil, nil, false, now.Add(5*time.Minute+time.Second))
	if len(snapshot.results) != 1 {
		t.Fatal("stable state should emit a five minute snapshot")
	}
}

func TestTCPingReportGateForceAndTunnelRulesBypassSuppression(t *testing.T) {
	gate := newTCPingReportGate()
	now := time.Date(2026, 7, 24, 10, 0, 0, 0, time.UTC)
	direct := tcpingGateResult(1, false, 10)
	tunnelRule := map[string]any{
		"ruleId": 2, "tunnelId": 9, "probeKey": "tunnel-rule", "latencyMs": 20, "isTimeout": false,
	}
	results := []map[string]any{direct, tunnelRule}
	gate.commit(gate.plan(results, nil, nil, nil, false, now))

	stable := gate.plan(results, nil, nil, nil, false, now.Add(time.Minute))
	if len(stable.results) != 1 || stable.results[0]["ruleId"] != 2 {
		t.Fatalf("tunnel rules must continue to reach server-side composed health evaluation: %+v", stable.results)
	}
	forced := gate.plan(results, nil, nil, nil, true, now.Add(2*time.Minute))
	if len(forced.results) != 2 {
		t.Fatalf("force TCPing must include every rule, got %d", len(forced.results))
	}
}
