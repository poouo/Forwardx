package main

import (
	"sync"
	"sync/atomic"
	"testing"
)

func TestFXPUDPQueueBudgetDefaults(t *testing.T) {
	if fxpUDPQueueRuleBudgetBytes != 16*1024*1024 {
		t.Fatalf("rule queue budget = %d, want 16 MiB", fxpUDPQueueRuleBudgetBytes)
	}
	if fxpUDPQueueProcessBudgetBytes != 64*1024*1024 {
		t.Fatalf("process queue budget = %d, want 64 MiB", fxpUDPQueueProcessBudgetBytes)
	}
}

func TestFXPUDPQueueBudgetEnforcesRuleLimitWithoutPartialReservation(t *testing.T) {
	process := newFXPUDPQueueProcessBudget(100)
	rule := newFXPUDPQueueRuleBudget(process, 10)
	if !rule.reserve(6) {
		t.Fatal("initial reservation was rejected")
	}
	if rule.reserve(5) {
		t.Fatal("reservation exceeding the rule limit was accepted")
	}
	if got := rule.usedBytes(); got != 6 {
		t.Fatalf("rule usage after rejected reservation = %d, want 6", got)
	}
	if got := process.usedBytes(); got != 6 {
		t.Fatalf("process usage after rejected reservation = %d, want 6", got)
	}
	if !rule.reserve(4) {
		t.Fatal("reservation reaching the exact rule limit was rejected")
	}
}

func TestFXPUDPQueueBudgetEnforcesSharedProcessLimit(t *testing.T) {
	process := newFXPUDPQueueProcessBudget(10)
	first := newFXPUDPQueueRuleBudget(process, 10)
	second := newFXPUDPQueueRuleBudget(process, 10)
	if !first.reserve(6) {
		t.Fatal("first rule reservation was rejected")
	}
	if second.reserve(5) {
		t.Fatal("reservation exceeding the process limit was accepted")
	}
	if got := second.usedBytes(); got != 0 {
		t.Fatalf("second rule retained a failed reservation: %d", got)
	}
	if got := process.usedBytes(); got != 6 {
		t.Fatalf("process usage after rejected reservation = %d, want 6", got)
	}
	if !second.reserve(4) {
		t.Fatal("reservation reaching the exact process limit was rejected")
	}
	if got := process.usedBytes(); got != 10 {
		t.Fatalf("process usage = %d, want 10", got)
	}
}

func TestFXPUDPQueueBudgetReleaseRestoresBothLimits(t *testing.T) {
	process := newFXPUDPQueueProcessBudget(10)
	rule := newFXPUDPQueueRuleBudget(process, 8)
	if !rule.reserve(8) {
		t.Fatal("reservation was rejected")
	}
	rule.release(3)
	if got := rule.usedBytes(); got != 5 {
		t.Fatalf("rule usage after release = %d, want 5", got)
	}
	if got := process.usedBytes(); got != 5 {
		t.Fatalf("process usage after release = %d, want 5", got)
	}
	if !rule.reserve(3) {
		t.Fatal("released rule capacity was not reusable")
	}
	rule.release(8)
	if got := rule.usedBytes(); got != 0 {
		t.Fatalf("rule usage after full release = %d, want 0", got)
	}
	if got := process.usedBytes(); got != 0 {
		t.Fatalf("process usage after full release = %d, want 0", got)
	}
}

func TestFXPUDPQueueBudgetReplaceIsAtomic(t *testing.T) {
	process := newFXPUDPQueueProcessBudget(10)
	rule := newFXPUDPQueueRuleBudget(process, 8)
	other := newFXPUDPQueueRuleBudget(process, 10)
	if !rule.reserve(6) || !other.reserve(4) {
		t.Fatal("initial reservations were rejected")
	}
	if !rule.replace(3, 3) {
		t.Fatal("equal replacement at the process limit was rejected")
	}
	if rule.replace(2, 3) {
		t.Fatal("replacement exceeding the process limit was accepted")
	}
	if got := rule.usedBytes(); got != 6 {
		t.Fatalf("failed replacement changed rule usage: %d", got)
	}
	if got := process.usedBytes(); got != 10 {
		t.Fatalf("failed replacement changed process usage: %d", got)
	}
	if rule.replace(7, 1) {
		t.Fatal("replacement released bytes not owned by the rule")
	}
}

func TestFXPUDPQueueBudgetRejectsInvalidReservation(t *testing.T) {
	process := newFXPUDPQueueProcessBudget(10)
	rule := newFXPUDPQueueRuleBudget(process, 10)
	if rule.reserve(-1) {
		t.Fatal("negative reservation was accepted")
	}
	if !rule.reserve(0) {
		t.Fatal("zero-byte reservation should be a no-op success")
	}
	var nilRule *fxpUDPQueueRuleBudget
	if nilRule.reserve(1) {
		t.Fatal("nil budget accepted a reservation")
	}
	if got := process.usedBytes(); got != 0 {
		t.Fatalf("invalid reservations changed process usage: %d", got)
	}
}

func TestFXPUDPQueueBudgetConcurrentReservationsStayWithinLimit(t *testing.T) {
	const (
		limit    = 1000
		attempts = 4000
	)
	process := newFXPUDPQueueProcessBudget(limit)
	rule := newFXPUDPQueueRuleBudget(process, limit)
	var accepted atomic.Int64
	var reserveWG sync.WaitGroup
	reserveWG.Add(attempts)
	for i := 0; i < attempts; i++ {
		go func() {
			defer reserveWG.Done()
			if rule.reserve(1) {
				accepted.Add(1)
			}
		}()
	}
	reserveWG.Wait()
	if got := accepted.Load(); got != limit {
		t.Fatalf("accepted reservations = %d, want %d", got, limit)
	}
	if got := rule.usedBytes(); got != limit {
		t.Fatalf("rule usage = %d, want %d", got, limit)
	}
	if got := process.usedBytes(); got != limit {
		t.Fatalf("process usage = %d, want %d", got, limit)
	}

	var releaseWG sync.WaitGroup
	releaseWG.Add(limit)
	for i := 0; i < limit; i++ {
		go func() {
			defer releaseWG.Done()
			rule.release(1)
		}()
	}
	releaseWG.Wait()
	if got := rule.usedBytes(); got != 0 {
		t.Fatalf("rule usage after concurrent release = %d, want 0", got)
	}
	if got := process.usedBytes(); got != 0 {
		t.Fatalf("process usage after concurrent release = %d, want 0", got)
	}
}
