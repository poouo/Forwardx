package main

import (
	"bytes"
	"testing"
	"time"
)

func testFXPUDPFragment(sequence uint64, fragment, fragments uint8, payload string) fxpUDPPacket {
	return fxpUDPPacket{
		sequence:  sequence,
		fragment:  fragment,
		fragments: fragments,
		payload:   []byte(payload),
	}
}

func TestUDPFragmentReassemblerReleasesBudgetOnCompletion(t *testing.T) {
	process := newFXPUDPQueueProcessBudget(32)
	budget := newFXPUDPQueueRuleBudget(process, 32)
	var reassembler udpFragmentReassembler
	reassembler.bindBudget(budget)
	var replay udpReplayWindow

	if payload, ok := reassembler.accept(testFXPUDPFragment(1, 0, 2, "first"), &replay); ok || payload != nil {
		t.Fatalf("incomplete fragment set returned payload %q, ok=%v", payload, ok)
	}
	if got := budget.usedBytes(); got != 5 {
		t.Fatalf("pending fragment budget = %d, want 5", got)
	}
	payload, ok := reassembler.accept(testFXPUDPFragment(1, 1, 2, "second"), &replay)
	if !ok || !bytes.Equal(payload, []byte("firstsecond")) {
		t.Fatalf("completed payload = %q, ok=%v", payload, ok)
	}
	if got := budget.usedBytes(); got != 0 {
		t.Fatalf("rule budget after completion = %d, want 0", got)
	}
	if got := process.usedBytes(); got != 0 {
		t.Fatalf("process budget after completion = %d, want 0", got)
	}
}

func TestUDPFragmentReassemblerReleasesExpiredBudget(t *testing.T) {
	process := newFXPUDPQueueProcessBudget(32)
	budget := newFXPUDPQueueRuleBudget(process, 32)
	var reassembler udpFragmentReassembler
	reassembler.setBudget(budget)
	var replay udpReplayWindow

	if _, ok := reassembler.accept(testFXPUDPFragment(1, 0, 2, "old"), &replay); ok {
		t.Fatal("incomplete old fragment set was accepted")
	}
	reassembler.mu.Lock()
	reassembler.pending[1].createdAt = time.Now().Add(-fxpUDPFragmentTimeout)
	reassembler.mu.Unlock()
	if _, ok := reassembler.accept(testFXPUDPFragment(2, 0, 2, "n"), &replay); ok {
		t.Fatal("incomplete new fragment set was accepted")
	}
	if got := budget.usedBytes(); got != 1 {
		t.Fatalf("budget after expiration and replacement = %d, want 1", got)
	}
	reassembler.mu.Lock()
	_, oldPending := reassembler.pending[1]
	_, newPending := reassembler.pending[2]
	reassembler.mu.Unlock()
	if oldPending || !newPending {
		t.Fatalf("unexpected pending sets after expiration: old=%v new=%v", oldPending, newPending)
	}
}

func TestUDPFragmentReassemblerReleasesBudgetOnMetadataConflict(t *testing.T) {
	process := newFXPUDPQueueProcessBudget(32)
	budget := newFXPUDPQueueRuleBudget(process, 32)
	var reassembler udpFragmentReassembler
	reassembler.bindBudget(budget)
	var replay udpReplayWindow

	if _, ok := reassembler.accept(testFXPUDPFragment(1, 0, 2, "kept"), &replay); ok {
		t.Fatal("incomplete fragment set was accepted")
	}
	if _, ok := reassembler.accept(testFXPUDPFragment(1, 1, 3, "conflict"), &replay); ok {
		t.Fatal("conflicting fragment metadata was accepted")
	}
	if got := budget.usedBytes(); got != 0 {
		t.Fatalf("budget after metadata conflict = %d, want 0", got)
	}
	if len(reassembler.pending) != 0 {
		t.Fatalf("pending sets after metadata conflict = %d, want 0", len(reassembler.pending))
	}
}

func TestUDPFragmentReassemblerReleasesOldestBudgetOnEviction(t *testing.T) {
	process := newFXPUDPQueueProcessBudget(64)
	budget := newFXPUDPQueueRuleBudget(process, 64)
	var reassembler udpFragmentReassembler
	reassembler.bindBudget(budget)
	var replay udpReplayWindow
	base := time.Now().Add(-time.Second)

	for sequence := uint64(1); sequence <= fxpUDPMaxPendingFragmentSets; sequence++ {
		if _, ok := reassembler.accept(testFXPUDPFragment(sequence, 0, 2, "x"), &replay); ok {
			t.Fatalf("incomplete fragment set %d was accepted", sequence)
		}
		reassembler.mu.Lock()
		reassembler.pending[sequence].createdAt = base.Add(time.Duration(sequence) * time.Millisecond)
		reassembler.mu.Unlock()
	}
	if got := budget.usedBytes(); got != fxpUDPMaxPendingFragmentSets {
		t.Fatalf("budget before eviction = %d, want %d", got, fxpUDPMaxPendingFragmentSets)
	}
	if _, ok := reassembler.accept(testFXPUDPFragment(99, 0, 2, "y"), &replay); ok {
		t.Fatal("incomplete replacement fragment set was accepted")
	}
	if got := budget.usedBytes(); got != fxpUDPMaxPendingFragmentSets {
		t.Fatalf("budget after eviction = %d, want %d", got, fxpUDPMaxPendingFragmentSets)
	}
	reassembler.mu.Lock()
	_, oldestPending := reassembler.pending[1]
	_, replacementPending := reassembler.pending[99]
	reassembler.mu.Unlock()
	if oldestPending || !replacementPending {
		t.Fatalf("unexpected pending sets after eviction: oldest=%v replacement=%v", oldestPending, replacementPending)
	}
}

func TestUDPFragmentReassemblerClearAndRebindReleaseBudget(t *testing.T) {
	firstProcess := newFXPUDPQueueProcessBudget(32)
	firstBudget := newFXPUDPQueueRuleBudget(firstProcess, 32)
	secondProcess := newFXPUDPQueueProcessBudget(32)
	secondBudget := newFXPUDPQueueRuleBudget(secondProcess, 32)
	var reassembler udpFragmentReassembler
	reassembler.bindBudget(firstBudget)
	var replay udpReplayWindow

	if _, ok := reassembler.accept(testFXPUDPFragment(1, 0, 2, "one"), &replay); ok {
		t.Fatal("incomplete fragment set was accepted")
	}
	reassembler.setBudget(secondBudget)
	if got := firstBudget.usedBytes(); got != 0 {
		t.Fatalf("old budget after rebind = %d, want 0", got)
	}
	if len(reassembler.pending) != 0 {
		t.Fatalf("pending sets after rebind = %d, want 0", len(reassembler.pending))
	}
	if _, ok := reassembler.accept(testFXPUDPFragment(2, 0, 2, "two"), &replay); ok {
		t.Fatal("incomplete rebound fragment set was accepted")
	}
	if got := secondBudget.usedBytes(); got != 3 {
		t.Fatalf("new budget before clear = %d, want 3", got)
	}
	reassembler.clear()
	reassembler.clear()
	if got := secondBudget.usedBytes(); got != 0 {
		t.Fatalf("new budget after clear = %d, want 0", got)
	}
	if len(reassembler.pending) != 0 {
		t.Fatalf("pending sets after clear = %d, want 0", len(reassembler.pending))
	}
}

func TestUDPFragmentReassemblerBudgetRejectionDropsAssembly(t *testing.T) {
	process := newFXPUDPQueueProcessBudget(5)
	budget := newFXPUDPQueueRuleBudget(process, 5)
	var reassembler udpFragmentReassembler
	reassembler.bindBudget(budget)
	var replay udpReplayWindow

	if _, ok := reassembler.accept(testFXPUDPFragment(1, 0, 2, "abc"), &replay); ok {
		t.Fatal("incomplete fragment set was accepted")
	}
	if _, ok := reassembler.accept(testFXPUDPFragment(1, 1, 2, "def"), &replay); ok {
		t.Fatal("fragment exceeding the budget was accepted")
	}
	if got := budget.usedBytes(); got != 0 {
		t.Fatalf("budget after rejected continuation = %d, want 0", got)
	}
	if len(reassembler.pending) != 0 {
		t.Fatalf("pending sets after rejected continuation = %d, want 0", len(reassembler.pending))
	}

	tinyProcess := newFXPUDPQueueProcessBudget(2)
	tinyBudget := newFXPUDPQueueRuleBudget(tinyProcess, 2)
	reassembler.setBudget(tinyBudget)
	if _, ok := reassembler.accept(testFXPUDPFragment(2, 0, 2, "toolarge"), &replay); ok {
		t.Fatal("new assembly exceeding the budget was accepted")
	}
	if got := tinyBudget.usedBytes(); got != 0 {
		t.Fatalf("budget after rejected new assembly = %d, want 0", got)
	}
	if len(reassembler.pending) != 0 {
		t.Fatalf("pending sets after rejected new assembly = %d, want 0", len(reassembler.pending))
	}
}

func TestUDPFragmentReassemblerWithoutBudgetKeepsUnlimitedBehavior(t *testing.T) {
	var reassembler udpFragmentReassembler
	var replay udpReplayWindow
	if _, ok := reassembler.accept(testFXPUDPFragment(1, 0, 2, "unlimited-"), &replay); ok {
		t.Fatal("incomplete fragment set was accepted")
	}
	payload, ok := reassembler.accept(testFXPUDPFragment(1, 1, 2, "payload"), &replay)
	if !ok || string(payload) != "unlimited-payload" {
		t.Fatalf("unbudgeted completed payload = %q, ok=%v", payload, ok)
	}
}

func TestUDPFragmentReassemblerCloseRejectsLateFragmentsWithoutBudgetLeak(t *testing.T) {
	process := newFXPUDPQueueProcessBudget(32)
	budget := newFXPUDPQueueRuleBudget(process, 32)
	var reassembler udpFragmentReassembler
	reassembler.bindBudget(budget)
	var replay udpReplayWindow

	if _, ok := reassembler.accept(testFXPUDPFragment(1, 0, 2, "first"), &replay); ok {
		t.Fatal("incomplete fragment set was accepted")
	}
	reassembler.close()
	reassembler.close()
	if got := budget.usedBytes(); got != 0 {
		t.Fatalf("closed reassembler retained %d budget bytes", got)
	}
	if _, ok := reassembler.accept(testFXPUDPFragment(2, 0, 2, "late"), &replay); ok {
		t.Fatal("closed reassembler accepted a late fragment")
	}
	if got := process.usedBytes(); got != 0 {
		t.Fatalf("late fragment changed process budget to %d", got)
	}
}

func TestUDPFragmentReassemblerActiveExpireReleasesBudget(t *testing.T) {
	process := newFXPUDPQueueProcessBudget(32)
	budget := newFXPUDPQueueRuleBudget(process, 32)
	var reassembler udpFragmentReassembler
	reassembler.bindBudget(budget)
	var replay udpReplayWindow

	if _, ok := reassembler.accept(testFXPUDPFragment(1, 0, 2, "old"), &replay); ok {
		t.Fatal("incomplete fragment set was accepted")
	}
	reassembler.mu.Lock()
	reassembler.pending[1].createdAt = time.Now().Add(-fxpUDPFragmentTimeout)
	reassembler.mu.Unlock()
	reassembler.expire(time.Now())
	if got := budget.usedBytes(); got != 0 {
		t.Fatalf("expired fragment retained %d budget bytes", got)
	}
	if len(reassembler.pending) != 0 {
		t.Fatalf("expired fragment sets = %d, want 0", len(reassembler.pending))
	}
}
