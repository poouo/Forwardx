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

func TestFXPUDPSessionExpirationWaitsForDrainButBoundsStalls(t *testing.T) {
	now := time.Date(2026, 8, 8, 12, 0, 0, 0, time.UTC)
	regularIdle := now.Add(-fxpUDPIdleTimeout).UnixNano()
	if !fxpUDPSessionExpiredAt(now, regularIdle, 0) {
		t.Fatal("drained idle session was not expired")
	}
	if fxpUDPSessionExpiredAt(now, regularIdle, 1) {
		t.Fatal("normal idle timeout interrupted pending work")
	}
	stalled := now.Add(-fxpUDPStalledTimeout).UnixNano()
	if !fxpUDPSessionExpiredAt(now, stalled, 1) {
		t.Fatal("stalled session with pending work was retained indefinitely")
	}
	if fxpUDPSessionExpiredAt(now, 0, 0) {
		t.Fatal("uninitialized session was expired")
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
