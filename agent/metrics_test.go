package main

import (
	"bytes"
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

func TestScheduleTCPingCollectionDoesNotBlockWhenBusy(t *testing.T) {
	atomic.StoreInt32(&tcpingCollectRunning, 1)
	defer atomic.StoreInt32(&tcpingCollectRunning, 0)

	started := time.Now()
	if scheduleTCPingCollection(Config{}, nil, nil, nil, false) {
		t.Fatal("busy tcping collection must remain due for a retry")
	}
	if elapsed := time.Since(started); elapsed > 50*time.Millisecond {
		t.Fatalf("busy tcping schedule blocked for %s", elapsed)
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
