package main

import (
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestProbeRoundCacheMeasuresEachTargetOnce(t *testing.T) {
	cache := newProbeRoundCache()
	var calls atomic.Int32
	probe := func() probeMeasurement {
		calls.Add(1)
		time.Sleep(20 * time.Millisecond)
		return probeMeasurement{LatencyMs: 7, Reachable: true, ProbeCount: 3, ProbeSuccesses: 3}
	}
	var wg sync.WaitGroup
	for i := 0; i < 30; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if got := cache.measure(probeRoundKey("tcp", " Example.com ", 443), probe); got.LatencyMs != 7 || got.ProbeSuccesses != 3 {
				t.Errorf("unexpected shared measurement: %+v", got)
			}
		}()
	}
	wg.Wait()
	cache.measure(probeRoundKey("tcp", "example.com", 8443), probe)
	cache.measure(probeRoundKey("ping", "example.com", 0), probe)
	if got := calls.Load(); got != 3 {
		t.Fatalf("expected one probe per distinct target, got %d", got)
	}
	var missing *probeRoundCache
	missing.measure("tcp|x|1", probe)
	if got := calls.Load(); got != 4 {
		t.Fatalf("a nil cache must still probe, got %d calls", got)
	}
}

func TestRunTCPingTasksSharesConnectionsToTheSameTarget(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	var accepted atomic.Int32
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			accepted.Add(1)
			_ = conn.Close()
		}
	}()
	port := listener.Addr().(*net.TCPAddr).Port
	tasks := make([]tcpingTask, 0, 27)
	for rule := 1; rule <= 27; rule++ {
		tasks = append(tasks, tcpingTask{Kind: "rule", RuleID: rule, TunnelID: 1, Method: "tcping", TargetIP: "127.0.0.1", TargetPort: port})
	}
	results, _, _, _ := runTCPingTasks(tasks)
	if len(results) != len(tasks) {
		t.Fatalf("every rule must still get a result: %d of %d", len(results), len(tasks))
	}
	for _, payload := range results {
		if payload["isTimeout"] != false || payload["probeCount"] != tcpingTCPProbeCount || payload["probeSuccesses"] != tcpingTCPProbeCount {
			t.Fatalf("unexpected payload: %+v", payload)
		}
	}
	time.Sleep(100 * time.Millisecond)
	if got := int(accepted.Load()); got != tcpingTCPProbeCount {
		t.Fatalf("expected %d connections for 27 rules sharing one target, got %d", tcpingTCPProbeCount, got)
	}
}
