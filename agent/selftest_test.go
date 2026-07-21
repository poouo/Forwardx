package main

import (
	"testing"
	"time"
)

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
}

func TestSelfTestRetryDelayIsBounded(t *testing.T) {
	if got := selfTestRetryDelay(1); got != 500*time.Millisecond {
		t.Fatalf("first retry delay=%s", got)
	}
	if got := selfTestRetryDelay(100); got != selfTestRetryMaxDelay {
		t.Fatalf("retry delay was not capped: %s", got)
	}
}
