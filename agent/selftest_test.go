package main

import "testing"

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
	for _, kind := range []string{"tunnel", "tunnel-hop", "forward-via-tunnel", "forward-via-tunnel-entry"} {
		if attempts := selfTestTCPAttempts(selfTest{Kind: kind}); attempts != 4 {
			t.Fatalf("kind %s attempts = %d, want 4", kind, attempts)
		}
	}
	if attempts := selfTestTCPAttempts(selfTest{Kind: ""}); attempts != 1 {
		t.Fatalf("direct test attempts = %d, want 1", attempts)
	}
}
