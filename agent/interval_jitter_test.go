package main

import (
	"fmt"
	"testing"
	"time"
)

func TestStableIntervalJitterIsBoundedAndDeterministic(t *testing.T) {
	base := 100 * time.Second
	first := stableIntervalJitter(base, "agent-a:presence", 10)
	if first != stableIntervalJitter(base, "agent-a:presence", 10) {
		t.Fatal("stable jitter changed for the same Agent and scope")
	}
	if first < 90*time.Second || first > 110*time.Second {
		t.Fatalf("jittered interval=%s outside the 10%% bound", first)
	}
	if first == stableIntervalJitter(base, "agent-b:presence", 10) {
		t.Fatal("different Agent keys unexpectedly received the same interval")
	}
}

func TestStableIntervalJitterHandlesDisabledAndClampedInputs(t *testing.T) {
	base := 50 * time.Second
	if got := stableIntervalJitter(base, "agent-a", 0); got != base {
		t.Fatalf("disabled jitter=%s want=%s", got, base)
	}
	if got := stableIntervalJitter(base, "", 10); got != base {
		t.Fatalf("empty-key jitter=%s want=%s", got, base)
	}
	if got := stableIntervalJitter(base, "agent-a", 50); got < 40*time.Second || got > 60*time.Second {
		t.Fatalf("clamped jitter=%s outside the 20%% bound", got)
	}
}

func TestStableIntervalJitterBelowSpreadsWithoutDeadlineConcentration(t *testing.T) {
	base := 5 * time.Minute
	values := map[time.Duration]bool{}
	atDeadline := 0
	for index := 0; index < 64; index++ {
		value := stableIntervalJitterBelow(base, fmt.Sprintf("agent-%d:full", index), 10)
		if value < 270*time.Second || value > base {
			t.Fatalf("one-sided jitter=%s outside [270s, 300s]", value)
		}
		values[value] = true
		if value == base {
			atDeadline++
		}
	}
	if len(values) < 16 || atDeadline > 2 {
		t.Fatalf("one-sided jitter remained concentrated: unique=%d atDeadline=%d", len(values), atDeadline)
	}
}
