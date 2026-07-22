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
	if !shouldIncludeHostTraffic(0, now) {
		t.Fatal("first idle host traffic sample must be reported")
	}
	lastHostTrafficReportAt = now
	if shouldIncludeHostTraffic(0, now.Add(idleHostTrafficReportEvery-time.Second)) {
		t.Fatal("idle host traffic samples must be coalesced")
	}
	if !shouldIncludeHostTraffic(0, now.Add(idleHostTrafficReportEvery)) {
		t.Fatal("idle host traffic sample must be reported after the coalescing interval")
	}
	if !shouldIncludeHostTraffic(1, now.Add(time.Second)) {
		t.Fatal("active rule traffic must always include the host counter")
	}
}
