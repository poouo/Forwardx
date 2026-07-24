package main

import (
	"testing"
	"time"
)

func TestSelfTestPollingOnlyFallsBackWithoutEventStream(t *testing.T) {
	if selfTestIdlePollInterval < agentPresenceInterval {
		t.Fatalf("idle self-test fallback polls too often: got=%s minimum=%s", selfTestIdlePollInterval, agentPresenceInterval)
	}
	if shouldPollSelfTests(true) {
		t.Fatal("connected event streams already wake the heartbeat and must suppress idle self-test polling")
	}
	if !shouldPollSelfTests(false) {
		t.Fatal("self-test polling must remain available while the event stream is disconnected")
	}
}

func TestSelfTestInFlightDeduplicatesRetries(t *testing.T) {
	selfTestInFlightMu.Lock()
	selfTestInFlight = map[int]bool{}
	selfTestInFlightMu.Unlock()
	t.Cleanup(func() {
		selfTestInFlightMu.Lock()
		selfTestInFlight = map[int]bool{}
		selfTestInFlightMu.Unlock()
	})

	if !claimSelfTest(77) {
		t.Fatal("first delivery should claim the test")
	}
	if claimSelfTest(77) {
		t.Fatal("duplicate delivery must not run concurrently")
	}
	releaseSelfTest(77)
	if !claimSelfTest(77) {
		t.Fatal("a released test should be retryable")
	}
}

func TestTunnelSelfTestsRetryTransientListenerReadiness(t *testing.T) {
	for _, kind := range []string{"tunnel", "tunnel-hop", "forward-via-tunnel", "forward-via-tunnel-entry", "forward-chain"} {
		if attempts := selfTestTCPAttempts(selfTest{Kind: kind}); attempts != 4 {
			t.Fatalf("kind %s attempts = %d, want 4", kind, attempts)
		}
	}
	if attempts := selfTestTCPAttempts(selfTest{Kind: ""}); attempts != 1 {
		t.Fatalf("direct test attempts = %d, want 1", attempts)
	}
}

func TestTunnelAndMultiEntrySelfTestsWaitForRuntime(t *testing.T) {
	for _, test := range []selfTest{
		{Kind: "tunnel"},
		{Kind: "tunnel-hop"},
		{Kind: "forward-via-tunnel-entry"},
		{Kind: "forward-chain"},
		{WireGuardPeerID: "42"},
	} {
		if !selfTestDependsOnRuntime(test) {
			t.Fatalf("test %+v should wait for runtime", test)
		}
		if window := selfTestTCPReadinessWindow(test); window != selfTestRuntimeReadinessWindow {
			t.Fatalf("test %+v readiness window=%s", test, window)
		}
	}
	if selfTestDependsOnRuntime(selfTest{}) {
		t.Fatal("direct rule test must not wait for unrelated runtime actions")
	}
	if selfTestDependsOnRuntime(selfTest{Kind: "forward-chain-target"}) {
		t.Fatal("forward-chain final target must not wait for runtime actions")
	}
	if attempts := selfTestTCPAttempts(selfTest{Kind: "forward-chain-target"}); attempts != 1 {
		t.Fatalf("forward-chain final target attempts=%d, want 1", attempts)
	}
	if window := selfTestTCPReadinessWindow(selfTest{Kind: "tunnel", runtimeActionsWaited: true}); window != selfTestPostActionReadinessWindow {
		t.Fatalf("post-action readiness window=%s, want %s", window, selfTestPostActionReadinessWindow)
	}
	if total := selfTestActionWaitWindow + selfTestPostActionReadinessWindow; total > selfTestRuntimeReadinessWindow {
		t.Fatalf("action wait plus probe window=%s exceeds manual test budget=%s", total, selfTestRuntimeReadinessWindow)
	}
}

func TestSelfTestRetryDelayIsBounded(t *testing.T) {
	if got := selfTestRetryDelay(1); got != 250*time.Millisecond {
		t.Fatalf("first retry delay=%s", got)
	}
	if got := selfTestRetryDelay(100); got != selfTestRetryMaxDelay {
		t.Fatalf("retry delay was not capped: %s", got)
	}
}
