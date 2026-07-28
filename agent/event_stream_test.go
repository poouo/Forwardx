package main

import (
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

func TestAgentEventStreamScannerAcceptsLargeDesiredState(t *testing.T) {
	payload := strings.Repeat("x", 2*1024*1024)
	scanner := newAgentEventStreamScanner(strings.NewReader(payload + "\n"))
	if !scanner.Scan() {
		t.Fatalf("large event was rejected: %v", scanner.Err())
	}
	if got := len(scanner.Text()); got != len(payload) {
		t.Fatalf("event length = %d, want %d", got, len(payload))
	}
}

func TestAgentEventStreamChallengeNegotiationSkipsClockSync(t *testing.T) {
	resetAgentAuthChallengeCacheForTests()
	t.Cleanup(resetAgentAuthChallengeCacheForTests)
	previousPanelURL, _ := runtimePanelURL.Load().(string)
	runtimePanelURL.Store("")
	t.Cleanup(func() { runtimePanelURL.Store(previousPanelURL) })
	cfg := Config{PanelURL: "https://panel.example.test"}
	clockError := errors.New("event stream status: 401 Unauthorized: Request timestamp out of window")
	legacyErr := wrapAgentRequestAttemptError(clockError, agentRequestAuth{version: "v1"}, agentAuthResultRejected, false)
	if fastRetry := prepareAgentEventStreamRetry(cfg, legacyErr); fastRetry {
		t.Fatal("legacy timestamp rejection retried without a challenge")
	}

	observeAgentAuthCapability(cfg.PanelURL, agentAuthChallengeCapability)
	negotiationErr := wrapAgentRequestAttemptError(clockError, agentRequestAuth{version: "v1"}, agentAuthResultRejected, false)
	if fastRetry := prepareAgentEventStreamRetry(cfg, negotiationErr); !fastRetry {
		t.Fatal("negotiated event stream retry did not use challenge auth")
	}

	fallbackErr := wrapAgentRequestAttemptError(
		clockError,
		agentRequestAuth{version: "v1", challengeKnownAtStart: true},
		agentAuthResultRejected,
		false,
	)
	if fastRetry := prepareAgentEventStreamRetry(cfg, fallbackErr); fastRetry {
		t.Fatal("challenge fetch failure retried legacy auth without a new challenge")
	}

	ordinaryV2Err := wrapAgentRequestAttemptError(io.EOF, agentRequestAuth{version: "v2"}, "", false)
	if fastRetry := prepareAgentEventStreamRetry(cfg, ordinaryV2Err); fastRetry {
		t.Fatal("ordinary v2 disconnect bypassed exponential backoff")
	}

	authenticatedErr := wrapAgentRequestAttemptError(
		clockError,
		agentRequestAuth{version: "v2"},
		agentAuthResultAccepted,
		true,
	)
	if fastRetry := prepareAgentEventStreamRetry(cfg, authenticatedErr); fastRetry {
		t.Fatal("authenticated stream business error bypassed exponential backoff")
	}
}

func TestFXPPortReleaseTimeoutAllowsNginxHandoff(t *testing.T) {
	if got := fxpPortReleaseTimeout(`users:(("forwardx-nginx",pid=10,fd=4))`); got != 15*time.Second {
		t.Fatalf("nginx handoff timeout = %s, want 15s", got)
	}
	if got := fxpPortReleaseTimeout(`users:(("other-service",pid=11,fd=4))`); got != 3*time.Second {
		t.Fatalf("ordinary port timeout = %s, want 3s", got)
	}
}
