package main

import (
	"bytes"
	"context"
	"errors"
	"net"
	"sync/atomic"
	"testing"
	"time"
)

func TestICMPEchoRequestChecksum(t *testing.T) {
	packet := buildICMPEchoRequest(8, 0x1234, 1)
	if got := icmpChecksum(packet); got != 0 {
		t.Fatalf("checksum should validate to zero, got %#x", got)
	}
}

func TestStripIPv4Header(t *testing.T) {
	header := make([]byte, 20)
	header[0] = 0x45
	body := []byte{0, 0, 0, 0, 0x12, 0x34, 0, 1}
	packet := append(header, body...)
	if got := stripIPv4Header(packet); !bytes.Equal(got, body) {
		t.Fatalf("unexpected stripped packet: %v", got)
	}
}

func TestCPUUsageFromTimes(t *testing.T) {
	cpuUsageMu.Lock()
	previousCPUTimes = cpuTimes{Idle: 100, Total: 200}
	previousCPUReady = true
	cpuUsageMu.Unlock()

	if got := cpuUsageFromTimes(cpuTimes{Idle: 125, Total: 300}); got != 75 {
		t.Fatalf("unexpected cpu usage: got %d want 75", got)
	}
}

func TestTrafficBaselinesCommitOnlyAfterSuccessfulReport(t *testing.T) {
	previousDir := trafficStateDir
	trafficPrevMu.Lock()
	previousCache := trafficPrevCache
	trafficPrevCache = map[string]trafficPrevState{}
	trafficPrevMu.Unlock()
	trafficStateDir = t.TempDir()
	t.Cleanup(func() {
		trafficStateDir = previousDir
		trafficPrevMu.Lock()
		trafficPrevCache = previousCache
		trafficPrevMu.Unlock()
	})

	update := trafficBaselineUpdate{
		port:  "22022",
		state: trafficPrevState{ruleID: 42, in: 1200, out: 800, conns: 3},
	}
	initial := trafficBaselineUpdate{
		port:  update.port,
		state: trafficPrevState{ruleID: 42, in: 1000, out: 500, conns: 2},
	}
	commitTrafficBaselines(true, []trafficBaselineUpdate{initial})
	commitTrafficBaselines(false, []trafficBaselineUpdate{update})
	if ruleID, in, out, conns := readPrev(update.port); ruleID != 42 || in != 1000 || out != 500 || conns != 2 {
		t.Fatalf("failed report advanced baseline: rule=%d in=%d out=%d conns=%d", ruleID, in, out, conns)
	} else if delta(update.state.in, in) != 200 || delta(update.state.out, out) != 300 || delta(update.state.conns, conns) != 1 {
		t.Fatal("failed report delta was not retained for retry")
	}

	commitTrafficBaselines(true, []trafficBaselineUpdate{update})
	if ruleID, in, out, conns := readPrev(update.port); ruleID != 42 || in != 1200 || out != 800 || conns != 3 {
		t.Fatalf("successful report did not advance baseline: rule=%d in=%d out=%d conns=%d", ruleID, in, out, conns)
	} else if delta(1250, in) != 50 || delta(825, out) != 25 || delta(4, conns) != 1 {
		t.Fatal("successful retry did not establish the next delta baseline")
	}
}

func TestScheduleTCPingCollectionDoesNotBlockWhenBusy(t *testing.T) {
	atomic.StoreInt32(&tcpingCollectRunning, 1)
	defer atomic.StoreInt32(&tcpingCollectRunning, 0)

	started := time.Now()
	if scheduleTCPingCollection(Config{}, nil, nil, nil, nil, false) {
		t.Fatal("busy tcping collection must remain due for a retry")
	}
	if elapsed := time.Since(started); elapsed > 50*time.Millisecond {
		t.Fatalf("busy tcping schedule blocked for %s", elapsed)
	}
}

func TestScheduleTCPingCollectionDefersTopologyProbeWhileActionsPending(t *testing.T) {
	atomic.StoreInt64(&actionPendingCount, 1)
	atomic.StoreInt32(&tcpingCollectRunning, 0)
	defer atomic.StoreInt64(&actionPendingCount, 0)

	started := time.Now()
	if scheduleTCPingCollection(Config{}, nil, []tunnelProbe{{
		TunnelID: 1, TargetIP: "127.0.0.1", TargetPort: 1,
	}}, nil, nil, true) {
		t.Fatal("topology probe must remain due while runtime actions are pending")
	}
	if atomic.LoadInt32(&tcpingCollectRunning) != 0 {
		t.Fatal("deferred topology probe unexpectedly started a collector")
	}
	if elapsed := time.Since(started); elapsed > 50*time.Millisecond {
		t.Fatalf("deferred topology probe blocked for %s", elapsed)
	}
}

func TestTCPingDynamicBatchLimitScalesWithoutUnboundedRuns(t *testing.T) {
	tests := []struct {
		total  int
		min    int
		rounds int
		max    int
		want   int
	}{
		{total: 10, min: 24, rounds: 3, max: 160, want: 10},
		{total: 90, min: 24, rounds: 3, max: 160, want: 30},
		{total: 600, min: 24, rounds: 3, max: 256, want: 200},
		{total: 3000, min: 24, rounds: 3, max: 256, want: 256},
		{total: 25, min: 12, rounds: 2, max: 96, want: 13},
	}
	for _, tc := range tests {
		if got := tcpingDynamicBatchLimit(tc.total, tc.min, tc.rounds, tc.max); got != tc.want {
			t.Fatalf("batch limit total=%d: got %d want %d", tc.total, got, tc.want)
		}
	}
}

func TestTCPingDueIntervalScalesWithWorkAndServiceRequirements(t *testing.T) {
	if got := tcpingDueInterval(nil, 20, 2); got != time.Minute {
		t.Fatalf("small workload interval = %s", got)
	}
	if got := tcpingDueInterval(nil, 600, 0); got != 15*time.Second {
		t.Fatalf("large workload interval = %s", got)
	}
	if got := tcpingDueInterval([]hostProbeServiceProbe{{IntervalSeconds: 5}}, 600, 0); got != 5*time.Second {
		t.Fatalf("service interval should win, got %s", got)
	}
	if got := tcpingRoundsForWindow(5*time.Second, 3*time.Minute); got != 36 {
		t.Fatalf("five-second collection rounds = %d", got)
	}
}

func TestTCPLatencyUsesOneDeadlineAcrossResolvedAddresses(t *testing.T) {
	originalLookup := lookupNetworkTargetIPs
	originalDial := dialNetworkTimeout
	networkTargetDNSMu.Lock()
	originalCache := networkTargetDNSCache
	originalCalls := networkTargetDNSCalls
	networkTargetDNSCache = map[string]networkTargetDNSCacheEntry{}
	networkTargetDNSCalls = map[string]*networkTargetDNSCall{}
	networkTargetDNSMu.Unlock()
	t.Cleanup(func() {
		lookupNetworkTargetIPs = originalLookup
		dialNetworkTimeout = originalDial
		networkTargetDNSMu.Lock()
		networkTargetDNSCache = originalCache
		networkTargetDNSCalls = originalCalls
		networkTargetDNSMu.Unlock()
	})

	lookupNetworkTargetIPs = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("192.0.2.1")}, {IP: net.ParseIP("192.0.2.2")}}, nil
	}
	dialCalls := 0
	dialNetworkTimeout = func(string, string, time.Duration) (net.Conn, error) {
		dialCalls++
		time.Sleep(45 * time.Millisecond)
		return nil, errors.New("expected timeout")
	}

	started := time.Now()
	_, reachable, _ := tcpLatencyResolved("deadline.example.test", 443, 40*time.Millisecond)
	if reachable {
		t.Fatal("synthetic timeout unexpectedly became reachable")
	}
	if dialCalls != 1 {
		t.Fatalf("dial attempts=%d, want 1 within the shared deadline", dialCalls)
	}
	if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
		t.Fatalf("resolved addresses exceeded the shared deadline: %s", elapsed)
	}
}

func TestRuleLatencyProbeUsesPingOnlyForUDP(t *testing.T) {
	tests := []struct {
		protocol string
		method   string
	}{
		{protocol: "udp", method: "ping"},
		{protocol: "tcp", method: "tcping"},
		{protocol: "both", method: "tcping"},
	}
	for _, tc := range tests {
		task, ok := buildRuleLatencyProbeTask(localRuleState{
			Port: "443", RuleID: 7, TargetIP: "hy2.example.com", TargetPort: 443, Protocol: tc.protocol,
		})
		if !ok {
			t.Fatalf("protocol %s did not create a probe task", tc.protocol)
		}
		if task.Method != tc.method {
			t.Fatalf("protocol %s method = %s, want %s", tc.protocol, task.Method, tc.method)
		}
	}
}

func TestRuleLatencyProbePrefersLatestDesiredProtocol(t *testing.T) {
	rememberDesiredRunningRules([]runningRule{{
		RuleID: 9, SourcePort: 8443, TargetIP: "new-hy2.example.com", TargetPort: 8443, Protocol: "udp",
	}})
	t.Cleanup(func() { rememberDesiredRunningRules(nil) })

	task, ok := buildRuleLatencyProbeTask(localRuleState{
		Port: "8443", RuleID: 9, TargetIP: "old.example.com", TargetPort: 443, Protocol: "tcp",
	})
	if !ok {
		t.Fatal("desired UDP rule did not create a probe task")
	}
	if task.Method != "ping" || task.TargetIP != "new-hy2.example.com" || task.TargetPort != 8443 {
		t.Fatalf("probe did not use desired rule metadata: %+v", task)
	}
}

func TestTunnelRuleLatencySkipsLocalEntryAndUsesExplicitExitProbe(t *testing.T) {
	if _, ok := buildRuleLatencyProbeTask(localRuleState{
		Port: "10080", RuleID: 12, TunnelID: 3, TargetIP: "target.example.com", TargetPort: 443, Protocol: "tcp",
	}); ok {
		t.Fatal("tunnel rule must not probe its final target from a local entry or relay state")
	}

	task, ok := buildExplicitRuleLatencyProbeTask(ruleLatencyProbe{
		RuleID: 12, TunnelID: 3, TargetIP: "target.example.com", TargetPort: 443,
		Method: "tcping", ProbeKey: "rule-latency", TopologyKey: "topology-v1",
	})
	if !ok {
		t.Fatal("explicit tunnel exit probe was rejected")
	}
	if task.SourcePort != 0 || task.Method != "tcping" || task.ProbeKey != "rule-latency" || task.TopologyKey != "topology-v1" {
		t.Fatalf("unexpected explicit tunnel rule probe: %+v", task)
	}
}

func TestMultiEntryWireGuardProbesKeepTheirOwnPeers(t *testing.T) {
	tasks := buildTunnelProbeTasks([]tunnelProbe{
		{
			TunnelID: 7, TargetIP: "entry-a.example.test", TargetPort: 31001,
			WireGuardPeerID: "exit-for-entry-a", ProbeKey: "entry-a",
		},
		{
			TunnelID: 7, TargetIP: "entry-b.example.test", TargetPort: 31001,
			WireGuardPeerID: "exit-for-entry-b", ProbeKey: "entry-b",
		},
	})
	if len(tasks) != 2 {
		t.Fatalf("multi-entry probe tasks=%d, want 2", len(tasks))
	}
	if tasks[0].WireGuardPeerID != "exit-for-entry-a" || tasks[0].ProbeKey != "entry-a" {
		t.Fatalf("first entry probe was overwritten: %+v", tasks[0])
	}
	if tasks[1].WireGuardPeerID != "exit-for-entry-b" || tasks[1].ProbeKey != "entry-b" {
		t.Fatalf("second entry probe was overwritten: %+v", tasks[1])
	}
}
