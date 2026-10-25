package main

import (
	"sync/atomic"
	"testing"
	"time"
)

func serviceScheduleTasks(probes []hostProbeServiceProbe) []tcpingTask {
	tasks := make([]tcpingTask, 0, len(probes))
	for _, probe := range probes {
		tasks = append(tasks, tcpingTask{Kind: "service", ServiceID: probe.ServiceID})
	}
	return tasks
}

func TestServiceProbeScheduleKeepsIndependentIntervals(t *testing.T) {
	var schedule serviceProbeSchedule
	now := time.Unix(1000, 0)
	probes := []hostProbeServiceProbe{
		{ServiceID: 1, TargetIP: "example.test", TargetPort: 80, IntervalSeconds: 5},
		{ServiceID: 2, TargetIP: "example.test", TargetPort: 443, IntervalSeconds: 300},
	}
	tasks := serviceScheduleTasks(probes)
	if got := schedule.selectTasks(tasks, probes, 96, false, now); len(got) != 2 {
		t.Fatalf("first run selected %d services, want 2", len(got))
	}
	for elapsed := 5; elapsed < 300; elapsed += 5 {
		got := schedule.selectTasks(tasks, probes, 96, false, now.Add(time.Duration(elapsed)*time.Second))
		if len(got) != 1 || got[0].ServiceID != 1 {
			t.Fatalf("at %ds slower service ran early: %+v", elapsed, got)
		}
	}
	if got := schedule.selectTasks(tasks, probes, 96, false, now.Add(300*time.Second)); len(got) != 2 {
		t.Fatalf("at 300s selected %d services, want 2", len(got))
	}
}

func TestServiceProbeScheduleDueBoundaryAndForce(t *testing.T) {
	var schedule serviceProbeSchedule
	now := time.Unix(1000, 0)
	probes := []hostProbeServiceProbe{{ServiceID: 1, TargetIP: "example.test", Method: "ping", IntervalSeconds: 30}}
	tasks := serviceScheduleTasks(probes)
	schedule.selectTasks(tasks, probes, 96, false, now)
	if schedule.due(probes, now.Add(29*time.Second)) || !schedule.due(probes, now.Add(30*time.Second)) {
		t.Fatal("service deadline must be independent of the global jittered interval")
	}
	if got := schedule.selectTasks(tasks, probes, 96, false, now.Add(time.Second)); len(got) != 0 {
		t.Fatal("service ran before its own interval")
	}
	if got := schedule.selectTasks(tasks, probes, 96, true, now.Add(time.Second)); len(got) != 1 {
		t.Fatal("manual force must bypass the service interval")
	}
	if schedule.due(probes, now.Add(30*time.Second)) || !schedule.due(probes, now.Add(31*time.Second)) {
		t.Fatal("manual execution must update the service deadline")
	}
}

func TestServiceProbeScheduleOnlyMarksSelectedAndPrunesRemoved(t *testing.T) {
	var schedule serviceProbeSchedule
	now := time.Unix(1000, 0)
	probes := []hostProbeServiceProbe{
		{ServiceID: 1, TargetIP: "example.test", Method: "ping", IntervalSeconds: 300},
		{ServiceID: 2, TargetIP: "example.test", Method: "ping", IntervalSeconds: 300},
	}
	tasks := serviceScheduleTasks(probes)
	first := schedule.selectTasks(tasks, probes, 1, false, now)
	if len(first) != 1 || !schedule.due(probes, now.Add(time.Second)) {
		t.Fatal("unselected service must remain due after a capped batch")
	}
	second := schedule.selectTasks(tasks, probes, 1, false, now.Add(time.Second))
	if len(second) != 1 || first[0].ServiceID == second[0].ServiceID {
		t.Fatal("capped batches did not select the waiting service")
	}
	probes[0].TargetIP = "changed.test"
	if !schedule.due(probes, now.Add(2*time.Second)) {
		t.Fatal("changed service configuration must be immediately due")
	}
	if got := schedule.selectTasks(tasks, probes, 96, false, now.Add(2*time.Second)); len(got) != 1 || got[0].ServiceID != 1 {
		t.Fatalf("configuration change selected unexpected services: %+v", got)
	}
	schedule.selectTasks(nil, nil, 96, false, now.Add(3*time.Second))
	if len(schedule.last) != 0 {
		t.Fatal("removed services left scheduling records behind")
	}
	if !schedule.due(probes, now.Add(4*time.Second)) {
		t.Fatal("re-added service must run immediately")
	}
}

func TestServiceProbeScheduleNormalizesIntervalsAndIgnoresInvalid(t *testing.T) {
	for seconds, want := range map[int]time.Duration{-1: 30 * time.Second, 0: 30 * time.Second, 1: 5 * time.Second, 5: 5 * time.Second, 300: 300 * time.Second} {
		if got := serviceProbeInterval(hostProbeServiceProbe{IntervalSeconds: seconds}); got != want {
			t.Fatalf("interval %d = %s, want %s", seconds, got, want)
		}
	}
	var schedule serviceProbeSchedule
	invalid := []hostProbeServiceProbe{{ServiceID: 1}, {TargetIP: "example.test", TargetPort: 443}, {ServiceID: 2, TargetIP: "example.test"}}
	if schedule.due(invalid, time.Now()) {
		t.Fatal("invalid probes must not keep the scheduler hot")
	}
}

func TestServiceOnlyCollectionDoesNotRunRuntimeProbes(t *testing.T) {
	previousPending := atomic.SwapInt64(&actionPendingCount, 1)
	t.Cleanup(func() { atomic.StoreInt64(&actionPendingCount, previousPending) })
	if !scheduleTCPingCollectionMode(Config{},
		[]ruleLatencyProbe{{RuleID: 1}}, []tunnelProbe{{TunnelID: 1}}, []forwardGroupProbe{{GroupID: 1}},
		nil, false, true) {
		t.Fatal("service-only cycle retained runtime probes and was deferred by pending actions")
	}
	deadline := time.Now().Add(time.Second)
	for atomic.LoadInt32(&tcpingCollectRunning) != 0 {
		if time.Now().After(deadline) {
			t.Fatal("service-only cycle did not finish without probing runtime targets")
		}
		time.Sleep(time.Millisecond)
	}
}
