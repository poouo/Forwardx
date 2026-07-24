package main

import (
	"context"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestManagedServiceBatcherCoalescesConcurrentStarts(t *testing.T) {
	var calls atomic.Int32
	batchSizes := make(chan int, 4)
	batcher := newManagedServiceBatcher(40*time.Millisecond, 128, func(requests []managedServiceStartRequest) []bool {
		calls.Add(1)
		batchSizes <- len(requests)
		results := make([]bool, len(requests))
		for index, request := range requests {
			results[index] = request.name != "bad"
		}
		return results
	})

	const requestCount = 32
	start := make(chan struct{})
	var wg sync.WaitGroup
	errors := make(chan string, requestCount)
	for index := 0; index < requestCount; index++ {
		index := index
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			name := "service"
			want := true
			if index == requestCount-1 {
				name = "bad"
				want = false
			}
			if got := batcher.submit(name, true, false); got != want {
				errors <- name
			}
		}()
	}
	close(start)
	wg.Wait()
	close(batcher.queue)
	close(errors)
	for name := range errors {
		t.Fatalf("unexpected result for %s", name)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("batch executor calls = %d, want 1", got)
	}
	if got := <-batchSizes; got != requestCount {
		t.Fatalf("batch size = %d, want %d", got, requestCount)
	}
}

func TestNetworkTargetDNSCoalescesConcurrentLookups(t *testing.T) {
	networkTargetDNSMu.Lock()
	previousCache := networkTargetDNSCache
	previousCalls := networkTargetDNSCalls
	previousLookup := lookupNetworkTargetIPs
	networkTargetDNSCache = map[string]networkTargetDNSCacheEntry{}
	networkTargetDNSCalls = map[string]*networkTargetDNSCall{}
	networkTargetDNSMu.Unlock()
	t.Cleanup(func() {
		networkTargetDNSMu.Lock()
		networkTargetDNSCache = previousCache
		networkTargetDNSCalls = previousCalls
		lookupNetworkTargetIPs = previousLookup
		networkTargetDNSMu.Unlock()
	})

	var lookups atomic.Int32
	lookupNetworkTargetIPs = func(ctx context.Context, host string) ([]net.IPAddr, error) {
		lookups.Add(1)
		select {
		case <-time.After(25 * time.Millisecond):
			return []net.IPAddr{{IP: net.ParseIP("192.0.2.10")}}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}

	const callers = 32
	var wg sync.WaitGroup
	for index := 0; index < callers; index++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			addresses := resolveNetworkTargetIPs("Probe.Example.Test", time.Second)
			if len(addresses) != 1 || addresses[0] != "192.0.2.10" {
				t.Errorf("unexpected addresses: %v", addresses)
			}
		}()
	}
	wg.Wait()
	if addresses := resolveNetworkTargetIPs("probe.example.test", time.Second); len(addresses) != 1 {
		t.Fatalf("cached addresses: %v", addresses)
	}
	if got := lookups.Load(); got != 1 {
		t.Fatalf("DNS lookups = %d, want 1", got)
	}
}

func TestProbeWorkYieldsToPendingActions(t *testing.T) {
	previousPending := atomic.SwapInt64(&actionPendingCount, 100)
	t.Cleanup(func() { atomic.StoreInt64(&actionPendingCount, previousPending) })
	if got := tcpingTaskConcurrency(100); got != 4 {
		t.Fatalf("busy probe concurrency = %d, want 4", got)
	}

	trafficCollectMu.Lock()
	previousRunning := trafficCollectRunning
	previousLast := lastTrafficCollectAt
	previousInterval := nextTrafficCollectInterval
	trafficCollectRunning = false
	lastTrafficCollectAt = time.Time{}
	nextTrafficCollectInterval = trafficCollectInterval
	trafficCollectMu.Unlock()
	t.Cleanup(func() {
		trafficCollectMu.Lock()
		trafficCollectRunning = previousRunning
		lastTrafficCollectAt = previousLast
		nextTrafficCollectInterval = previousInterval
		trafficCollectMu.Unlock()
	})
	if scheduleTrafficCollection(Config{}) {
		t.Fatal("traffic collection must not start while forwarding actions are pending")
	}
}

func TestIdleHostTrafficReportsAreCoalesced(t *testing.T) {
	previous := lastHostTrafficReportAt
	t.Cleanup(func() { lastHostTrafficReportAt = previous })
	now := time.Now()
	lastHostTrafficReportAt = time.Time{}
	if !shouldIncludeHostTraffic(false, now) {
		t.Fatal("first idle host traffic sample must be reported")
	}
	lastHostTrafficReportAt = now
	if shouldIncludeHostTraffic(false, now.Add(idleHostTrafficReportEvery-time.Second)) {
		t.Fatal("idle host traffic samples must be coalesced")
	}
	if !shouldIncludeHostTraffic(false, now.Add(idleHostTrafficReportEvery)) {
		t.Fatal("idle host traffic sample must be reported after the coalescing interval")
	}
	if !shouldIncludeHostTraffic(true, now.Add(time.Second)) {
		t.Fatal("active rule traffic must always include the host counter")
	}
}

func TestActiveRuleTrafficReportsAreBatched(t *testing.T) {
	previous := lastRuleTrafficReportAt
	previousInterval := activeTrafficReportNanos.Load()
	setActiveTrafficReportIntervalSeconds(int(activeTrafficReportEvery / time.Second))
	t.Cleanup(func() {
		lastRuleTrafficReportAt = previous
		activeTrafficReportNanos.Store(previousInterval)
	})
	now := time.Now()
	lastRuleTrafficReportAt = time.Time{}
	if !shouldReportRuleTraffic(1, now) {
		t.Fatal("first active traffic delta must be reported immediately")
	}
	lastRuleTrafficReportAt = now
	reportInterval := currentActiveTrafficReportInterval()
	if shouldReportRuleTraffic(1, now.Add(reportInterval-time.Millisecond)) {
		t.Fatal("active traffic deltas must be accumulated between reports")
	}
	if !shouldReportRuleTraffic(1, now.Add(reportInterval)) {
		t.Fatal("active traffic deltas must be reported when the batch interval is due")
	}
	if shouldReportRuleTraffic(0, now.Add(reportInterval)) {
		t.Fatal("an empty rule delta must not create a traffic report")
	}
}

func TestSteadyTrafficReportsAndCollectionUsePanelBatchWindow(t *testing.T) {
	previousReportAt := lastRuleTrafficReportAt
	previousInterval := activeTrafficReportNanos.Load()
	setActiveTrafficReportIntervalSeconds(int(steadyTrafficReportEvery / time.Second))
	t.Cleanup(func() {
		lastRuleTrafficReportAt = previousReportAt
		activeTrafficReportNanos.Store(previousInterval)
	})

	now := time.Now()
	lastRuleTrafficReportAt = now
	reportInterval := currentActiveTrafficReportInterval()
	if shouldReportRuleTraffic(1, now.Add(reportInterval-time.Millisecond)) {
		t.Fatal("steady traffic report was emitted before the panel batch window")
	}
	if !shouldReportRuleTraffic(1, now.Add(reportInterval)) {
		t.Fatal("steady traffic report was not emitted when the panel batch window elapsed")
	}
	if got := trafficCollectionIntervalForRuleCount(1); got != reportInterval {
		t.Fatalf("steady collection interval=%s want=%s", got, reportInterval)
	}

	setActiveTrafficReportIntervalSeconds(1)
	if got := configuredActiveTrafficReportInterval(); got != activeTrafficReportEvery {
		t.Fatalf("interactive interval clamp=%s want=%s", got, activeTrafficReportEvery)
	}
	if got := trafficCollectionIntervalForRuleCount(1); got != currentActiveTrafficReportInterval() {
		t.Fatalf("interactive collection interval=%s want=%s", got, currentActiveTrafficReportInterval())
	}
}

func TestSuccessfulHeartbeatDelayLetsAgentOwnBackgroundProbes(t *testing.T) {
	fullHeartbeatSeconds := int(agentFullHeartbeatInterval / time.Second)
	if got := successfulHeartbeatDelaySeconds(20, 30, true, true); got != fullHeartbeatSeconds {
		t.Fatalf("service probe interval kept full heartbeat hot: got=%ds want=%ds", got, fullHeartbeatSeconds)
	}
	if got := successfulHeartbeatDelaySeconds(3, 30, true, true); got != 3 {
		t.Fatalf("interactive metrics interval changed: got=%ds want=3s", got)
	}
	if got := successfulHeartbeatDelaySeconds(2, 30, true, true); got != 2 {
		t.Fatalf("interactive task interval changed: got=%ds want=2s", got)
	}
	if got := successfulHeartbeatDelaySeconds(120, 30, true, false); got != agentIdleHeartbeatIntervalSeconds {
		t.Fatalf("disconnected event stream fallback: got=%ds want=%ds", got, agentIdleHeartbeatIntervalSeconds)
	}
	if got := successfulHeartbeatDelaySeconds(20, 30, true, false); got != 20 {
		t.Fatalf("disconnected event stream lost short polling: got=%ds want=20s", got)
	}
	if got := successfulHeartbeatDelaySeconds(20, 30, false, true); got != 20 {
		t.Fatalf("legacy panel interval changed: got=%ds want=20s", got)
	}
}

func TestSuccessfulHeartbeatJitterPreservesInteractiveAndAuditBounds(t *testing.T) {
	if got := jitterSuccessfulHeartbeatDelaySeconds(3); got != 3 {
		t.Fatalf("interactive heartbeat was jittered: %ds", got)
	}
	fullHeartbeatSeconds := int(agentFullHeartbeatInterval / time.Second)
	got := jitterSuccessfulHeartbeatDelaySeconds(fullHeartbeatSeconds)
	if got < fullHeartbeatSeconds*9/10 || got > fullHeartbeatSeconds {
		t.Fatalf("full heartbeat jitter=%ds outside bounded audit window", got)
	}
}

func TestPresenceIntervalHonorsPanelWithinAvailabilityBounds(t *testing.T) {
	if agentPresenceInterval != 5*time.Second {
		t.Fatalf("default presence interval=%s want=5s", agentPresenceInterval)
	}
	cases := []struct {
		name             string
		serverSeconds    int
		expectedInterval time.Duration
	}{
		{name: "missing uses default", serverSeconds: 0, expectedInterval: 5 * time.Second},
		{name: "negative uses default", serverSeconds: -1, expectedInterval: 5 * time.Second},
		{name: "too frequent is clamped", serverSeconds: 1, expectedInterval: 2 * time.Second},
		{name: "panel value is honored", serverSeconds: 3, expectedInterval: 3 * time.Second},
		{name: "availability ceiling is honored", serverSeconds: 5, expectedInterval: 5 * time.Second},
		{name: "slow value cannot break failover", serverSeconds: 60, expectedInterval: 5 * time.Second},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := boundedAgentPresenceInterval(tc.serverSeconds); got != tc.expectedInterval {
				t.Fatalf("presence interval=%s want=%s", got, tc.expectedInterval)
			}
		})
	}
}

func TestPresenceFailurePathRetainsFastTimeoutAndBackoff(t *testing.T) {
	if agentPresenceHTTPClient.Timeout != 8*time.Second {
		t.Fatalf("presence timeout=%s want=8s", agentPresenceHTTPClient.Timeout)
	}
	if got := nextHeartbeatRetryInterval(0); got != 5*time.Second {
		t.Fatalf("first retry=%s want=5s", got)
	}
	if got := nextHeartbeatRetryInterval(5 * time.Second); got != 10*time.Second {
		t.Fatalf("second retry=%s want=10s", got)
	}
	if got := nextHeartbeatRetryInterval(30 * time.Second); got != 30*time.Second {
		t.Fatalf("retry ceiling=%s want=30s", got)
	}
}

func TestPresenceSchedulingSpreadsLoadWithoutExtendingTheDeadline(t *testing.T) {
	configured := boundedAgentPresenceInterval(5)
	got := scheduledAgentPresenceInterval(5)
	if got < configured*9/10 || got > configured {
		t.Fatalf("scheduled presence interval=%s outside [%s,%s]", got, configured*9/10, configured)
	}
	if got := scheduledAgentPresenceInterval(1); got != agentPresenceMinInterval {
		t.Fatalf("minimum presence interval was jittered below its bound: %s", got)
	}
}
