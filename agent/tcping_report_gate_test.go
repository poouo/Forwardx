package main

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestTCPingCounterPreservesSuppressedSuccessesAndHealth(t *testing.T) {
	gate := newTCPingReportGate()
	now := time.Now()
	sent := 0
	var last map[string]any
	for i := 0; i < 1000; i++ {
		report := tcpingGateResult(1, i == 150, 8)
		report["probeCount"] = 3
		report["probeSuccesses"] = 3
		if i == 150 {
			report["probeSuccesses"] = 0
		}
		plan := gate.plan([]map[string]any{report}, nil, nil, nil, i == 999, now.Add(time.Duration(i)*time.Second))
		if _, changed := report["probeCounterEpoch"]; changed {
			t.Fatal("must not mutate current health report")
		}
		if len(plan.results) > 0 {
			sent++
			last = plan.results[0]
			if tcpingReportInt(last, "probeCount") != 3 {
				t.Fatal("must preserve current batch for health decisions")
			}
			if (i == 150) != tcpingReportStatus(last) {
				t.Fatal("health status changed")
			}
			gate.commit(plan)
			gate.commit(plan) // An acknowledgement is not another probe.
		} else if i == 150 || i == 151 {
			t.Fatal("failure/recovery must be immediate")
		}
	}
	if sent >= 10 {
		t.Fatalf("steady report throttling lost: %d reports", sent)
	}
	if tcpingReportInt(last, "probeTotalCount") != 3000 || tcpingReportInt(last, "probeTotalSuccesses") != 2997 {
		t.Fatalf("suppressed probes lost or counted twice: %+v", last)
	}
}

func TestTCPingCountersSeparateEpochsAndBoundMemory(t *testing.T) {
	gate := newTCPingReportGate()
	now := time.Now()
	report := tcpingGateResult(1, false, 8)
	first := gate.plan([]map[string]any{report}, nil, nil, nil, true, now).results[0]
	second := gate.plan([]map[string]any{report}, nil, nil, nil, true, now.Add(time.Second)).results[0]
	if tcpingReportInt(second, "probeTotalCount") != 2 || first["probeCounterEpoch"] != second["probeCounterEpoch"] {
		t.Fatal("unacknowledged POST must keep monotonic counters")
	}
	restarted := newTCPingReportGate().plan([]map[string]any{report}, nil, nil, nil, true, now).results[0]
	if restarted["probeCounterEpoch"] == first["probeCounterEpoch"] {
		t.Fatal("restart must rotate epoch")
	}
	report["topologyKey"] = "new-topology"
	changed := gate.plan([]map[string]any{report}, nil, nil, nil, true, now.Add(2*time.Second)).results[0]
	if changed["probeCounterEpoch"] == first["probeCounterEpoch"] {
		t.Fatal("topology change must rotate counter stream")
	}
	expired := gate.plan([]map[string]any{report}, nil, nil, nil, true, now.Add(tcpingReportStateTTL+3*time.Second)).results[0]
	if expired["probeCounterEpoch"] == changed["probeCounterEpoch"] {
		t.Fatal("TTL reset must use a new epoch")
	}
	for _, element := range gate.counters {
		element.Value.(*tcpingProbeCounter).count = tcpingCounterMax
	}
	rolled := gate.plan([]map[string]any{report}, nil, nil, nil, true, now.Add(tcpingReportStateTTL+4*time.Second)).results[0]
	if rolled["probeCounterEpoch"] == expired["probeCounterEpoch"] || tcpingReportInt(rolled, "probeTotalCount") != 1 {
		t.Fatal("counter overflow must rotate epoch")
	}
	gate = newTCPingReportGate()
	for i := 0; i <= tcpingCounterCapacity; i++ {
		item := map[string]any{"ruleId": i + 1, "probeKey": fmt.Sprint(i), "isTimeout": false}
		gate.countReports("rule", []map[string]any{item}, now)
	}
	if len(gate.counters) != tcpingCounterCapacity || gate.counterOrder.Len() != tcpingCounterCapacity {
		t.Fatal("counter cache must be bounded")
	}
	gate.plan(nil, nil, nil, nil, false, now.Add(tcpingReportStateTTL+time.Second))
	if len(gate.counters) != 0 || gate.counterOrder.Len() != 0 {
		t.Fatal("expired counters must be reclaimed")
	}
}

func TestTCPingCountersConcurrentCollections(t *testing.T) {
	gate := newTCPingReportGate()
	var workers sync.WaitGroup
	for i := 0; i < 100; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			plan := gate.plan([]map[string]any{tcpingGateResult(1, false, 8)}, nil, nil, nil, true, time.Now())
			gate.commit(plan)
		}()
	}
	workers.Wait()
	last := gate.plan([]map[string]any{tcpingGateResult(1, false, 8)}, nil, nil, nil, true, time.Now()).results[0]
	if tcpingReportInt(last, "probeTotalCount") != 101 {
		t.Fatalf("lost concurrent probes: %+v", last)
	}
}

func TestTCPingCountersDoNotCountSyntheticSelfHops(t *testing.T) {
	gate := newTCPingReportGate()
	report := tcpingGateHop("group", 3, 0, "group-self", false)
	report["method"] = "self"
	plan := gate.plan(nil, nil, []map[string]any{report}, nil, true, time.Now())
	if len(plan.forwardGroups) != 1 {
		t.Fatal("synthetic hop must still participate in health topology")
	}
	if _, counted := plan.forwardGroups[0]["probeTotalCount"]; counted {
		t.Fatal("synthetic success must not dilute actual failure rate")
	}
}

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

func TestTCPingReportGateSendsAgentHealthDecisionWithUnchangedRawTimeout(t *testing.T) {
	gate := newTCPingReportGate()
	now := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	report := tcpingGateHop("group", 3, 0, "group-health", true)
	report["memberId"] = 9
	report["healthStatus"] = "healthy"
	gate.commit(gate.plan(nil, nil, []map[string]any{report}, nil, false, now))

	report["healthStatus"] = "unhealthy"
	transition := gate.plan(nil, nil, []map[string]any{report}, nil, false, now.Add(time.Minute))
	if len(transition.forwardGroups) != 1 {
		t.Fatalf("health transition was suppressed: %+v", transition)
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

func TestTCPingReportGateSendsPacketLossRecoveryWithoutWaiting(t *testing.T) {
	gate := newTCPingReportGate()
	now := time.Date(2026, 7, 24, 10, 0, 0, 0, time.UTC)
	report := tcpingGateResult(7, false, 10)
	report["probeCount"] = 5
	report["probeSuccesses"] = 4
	first := gate.plan([]map[string]any{report}, nil, nil, nil, false, now)
	if len(first.results) != 1 {
		t.Fatal("first packet-loss report should be sent")
	}
	gate.commit(first)
	report["probeSuccesses"] = 5
	recovered := gate.plan([]map[string]any{report}, nil, nil, nil, false, now.Add(time.Second))
	if len(recovered.results) != 1 {
		t.Fatal("packet-loss recovery should not wait for the five-minute snapshot")
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
