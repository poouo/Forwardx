package main

import (
	"sync/atomic"
	"testing"
	"time"
)

func TestFXPUDPSessionIdleAtBoundary(t *testing.T) {
	now := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	if fxpUDPSessionIdleAt(now, 0) {
		t.Fatal("uninitialized activity was treated as idle")
	}
	if fxpUDPSessionIdleAt(now, now.Add(-fxpUDPIdleTimeout+time.Nanosecond).UnixNano()) {
		t.Fatal("active session was treated as idle")
	}
	if !fxpUDPSessionIdleAt(now, now.Add(-fxpUDPIdleTimeout).UnixNano()) {
		t.Fatal("idle timeout boundary was not treated as idle")
	}
}

func TestFXPUDPSessionSweeperStopsIdempotently(t *testing.T) {
	var calls atomic.Int64
	stop, wake := startFXPUDPSessionSweeper(func(time.Time) {
		calls.Add(1)
	})
	wake()
	stop()
	stop()
	before := calls.Load()
	time.Sleep(10 * time.Millisecond)
	if got := calls.Load(); got != before {
		t.Fatalf("sweeper ran after stop: before=%d after=%d", before, got)
	}
}
