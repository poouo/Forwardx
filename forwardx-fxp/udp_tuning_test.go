package main

import (
	"bytes"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestFXPUDPQueueEnforcesPacketAndByteLimits(t *testing.T) {
	queue := newFXPUDPQueue(3, 10)
	if dropped := queue.enqueue([]byte("aaaa")); dropped {
		t.Fatal("first packet was unexpectedly dropped")
	}
	if dropped := queue.enqueue([]byte("bbbb")); dropped {
		t.Fatal("second packet was unexpectedly dropped")
	}
	if dropped := queue.enqueue([]byte("cccc")); !dropped {
		t.Fatal("byte budget did not evict the oldest packet")
	}
	if got := queue.pending(); got != 2 {
		t.Fatalf("pending packets = %d, want 2", got)
	}
	if got := queue.bytes(); got != 8 {
		t.Fatalf("queued bytes = %d, want 8", got)
	}

	done := make(chan struct{})
	packet, ok := queue.next(done)
	if !ok || !bytes.Equal(packet.payload, []byte("bbbb")) {
		t.Fatalf("oldest retained packet = %q, ok=%v, want bbbb", packet.payload, ok)
	}
	packet.done()
	packet, ok = queue.next(done)
	if !ok || !bytes.Equal(packet.payload, []byte("cccc")) {
		t.Fatalf("newest retained packet = %q, ok=%v, want cccc", packet.payload, ok)
	}
	packet.done()
	if got := queue.bytes(); got != 0 {
		t.Fatalf("queued bytes after drain = %d, want 0", got)
	}
}

func TestFXPUDPQueueRejectsOversizedPacketWithoutDiscardingQueue(t *testing.T) {
	queue := newFXPUDPQueue(2, 4)
	if dropped := queue.enqueue([]byte("keep")); dropped {
		t.Fatal("initial packet was unexpectedly dropped")
	}
	if dropped := queue.enqueue([]byte("oversized")); !dropped {
		t.Fatal("oversized packet was unexpectedly accepted")
	}
	if got := queue.pending(); got != 1 {
		t.Fatalf("pending packets = %d, want 1", got)
	}
	if got := queue.bytes(); got != 4 {
		t.Fatalf("queued bytes = %d, want 4", got)
	}
}

func TestFXPUDPQueueSharedBudgetTracksReplacementDrainAndClear(t *testing.T) {
	process := newFXPUDPQueueProcessBudget(16)
	budget := newFXPUDPQueueRuleBudget(process, 8)
	queue := newFXPUDPQueueWithBudget(2, 8, budget)
	if queue.enqueue([]byte("aaaa")) || queue.enqueue([]byte("bbbb")) {
		t.Fatal("initial packets were unexpectedly dropped")
	}
	if got := budget.usedBytes(); got != 8 {
		t.Fatalf("budget before replacement = %d, want 8", got)
	}
	if dropped := queue.enqueue([]byte("cccc")); !dropped {
		t.Fatal("full queue did not replace its oldest packet")
	}
	if got := budget.usedBytes(); got != 8 {
		t.Fatalf("budget after equal replacement = %d, want 8", got)
	}

	done := make(chan struct{})
	packet, ok := queue.next(done)
	if !ok || string(packet.payload) != "bbbb" {
		t.Fatalf("packet after replacement = %q, ok=%v, want bbbb", packet.payload, ok)
	}
	if got := budget.usedBytes(); got != 8 {
		t.Fatalf("budget while packet is in flight = %d, want 8", got)
	}
	packet.done()
	if got := budget.usedBytes(); got != 4 {
		t.Fatalf("budget after drain = %d, want 4", got)
	}
	queue.clear()
	if got := budget.usedBytes(); got != 0 {
		t.Fatalf("budget after clear = %d, want 0", got)
	}
	if got := process.usedBytes(); got != 0 {
		t.Fatalf("process budget after clear = %d, want 0", got)
	}
}

func TestFXPUDPQueueRejectedReplacementPreservesExistingPacket(t *testing.T) {
	process := newFXPUDPQueueProcessBudget(10)
	budget := newFXPUDPQueueRuleBudget(process, 10)
	other := newFXPUDPQueueRuleBudget(process, 10)
	queue := newFXPUDPQueueWithBudget(1, 10, budget)
	if queue.enqueue([]byte("keep")) {
		t.Fatal("initial packet was unexpectedly dropped")
	}
	if !other.reserve(6) {
		t.Fatal("competing reservation was rejected")
	}
	if dropped := queue.enqueue([]byte("newer")); !dropped {
		t.Fatal("replacement exceeding the process budget was accepted")
	}
	if got := queue.pending(); got != 1 {
		t.Fatalf("queue size after rejected replacement = %d, want 1", got)
	}
	if got := budget.usedBytes(); got != 4 {
		t.Fatalf("queue budget after rejected replacement = %d, want 4", got)
	}

	done := make(chan struct{})
	packet, ok := queue.next(done)
	if !ok || string(packet.payload) != "keep" {
		t.Fatalf("retained packet = %q, ok=%v, want keep", packet.payload, ok)
	}
	packet.done()
	other.release(6)
	if got := process.usedBytes(); got != 0 {
		t.Fatalf("process budget after cleanup = %d, want 0", got)
	}
}

func TestFXPUDPQueueLeaseProtectsInFlightPacketUntilDone(t *testing.T) {
	process := newFXPUDPQueueProcessBudget(16)
	budget := newFXPUDPQueueRuleBudget(process, 16)
	queue := newFXPUDPQueueWithBudget(2, 16, budget)
	if queue.enqueue([]byte("game")) {
		t.Fatal("packet was unexpectedly dropped")
	}
	var inFlight atomic.Int64
	packet, ok := queue.nextTracked(make(chan struct{}), &inFlight)
	if !ok {
		t.Fatal("queued packet was not leased")
	}
	if got := queue.pending(); got != 0 {
		t.Fatalf("pending after lease = %d, want 0", got)
	}
	if got := inFlight.Load(); got != 1 {
		t.Fatalf("in-flight count = %d, want 1", got)
	}
	queue.close()
	if got := budget.usedBytes(); got != 4 {
		t.Fatalf("close released active lease budget: got %d, want 4", got)
	}
	packet.done()
	packet.done()
	if got := inFlight.Load(); got != 0 {
		t.Fatalf("in-flight count after done = %d, want 0", got)
	}
	if got := process.usedBytes(); got != 0 {
		t.Fatalf("process budget after done = %d, want 0", got)
	}
}

func TestFXPUDPQueueCloseRejectsConcurrentEnqueueWithoutBudgetLeak(t *testing.T) {
	process := newFXPUDPQueueProcessBudget(4096)
	budget := newFXPUDPQueueRuleBudget(process, 4096)
	queue := newFXPUDPQueueWithBudget(64, 4096, budget)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 128; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			queue.enqueue([]byte("packet"))
		}()
	}
	close(start)
	queue.close()
	wg.Wait()
	queue.close()
	if got := queue.pending(); got != 0 {
		t.Fatalf("closed queue retained %d packets", got)
	}
	if got := budget.usedBytes(); got != 0 {
		t.Fatalf("closed queue retained %d budget bytes", got)
	}
	if dropped := queue.enqueue([]byte("late")); !dropped {
		t.Fatal("closed queue accepted a late packet")
	}
	if got := process.usedBytes(); got != 0 {
		t.Fatalf("late packet changed process budget to %d", got)
	}
}

func TestFXPUDPQueuedPacketSupersededDelayBoundary(t *testing.T) {
	if fxpUDPMaxQueueDelay != 75*time.Millisecond {
		t.Fatalf("queue delay = %s, want 75ms", fxpUDPMaxQueueDelay)
	}
	queuedAt := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	packet := fxpUDPQueuedPacket{payload: []byte("data"), queuedAt: queuedAt}
	if packet.superseded(queuedAt.Add(fxpUDPMaxQueueDelay-time.Nanosecond), 1) {
		t.Fatal("packet expired one nanosecond before queue delay")
	}
	if !packet.superseded(queuedAt.Add(fxpUDPMaxQueueDelay), 1) {
		t.Fatal("packet did not expire at queue delay boundary")
	}
	if !packet.superseded(queuedAt.Add(fxpUDPMaxQueueDelay+time.Nanosecond), 1) {
		t.Fatal("packet did not expire one nanosecond after queue delay")
	}
	if packet.superseded(queuedAt.Add(fxpUDPMaxQueueDelay+time.Nanosecond), 0) {
		t.Fatal("packet without a newer pending packet was superseded")
	}
}

func TestDefaultFXPUDPSessionPolicyIsIndependentOfTCPPlanLimits(t *testing.T) {
	policy := defaultFXPUDPSessionPolicy()
	if policy.softSessions != 960 || policy.hardSessions != 1024 || policy.softPerIP != 60 || policy.hardPerIP != 64 {
		t.Fatalf("default policy = %+v, want total 960/1024 and per-IP 60/64", policy)
	}
}

type udpAdmissionTestSession struct {
	ip       string
	activity int64
	pending  int
}

func udpAdmissionTestSnapshot(session *udpAdmissionTestSession) fxpUDPSessionSnapshot {
	return fxpUDPSessionSnapshot{sourceIP: session.ip, lastActivity: session.activity, pending: session.pending}
}
