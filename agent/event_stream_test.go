package main

import (
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

func TestFXPPortReleaseTimeoutAllowsNginxHandoff(t *testing.T) {
	if got := fxpPortReleaseTimeout(`users:(("forwardx-nginx",pid=10,fd=4))`); got != 15*time.Second {
		t.Fatalf("nginx handoff timeout = %s, want 15s", got)
	}
	if got := fxpPortReleaseTimeout(`users:(("other-service",pid=11,fd=4))`); got != 3*time.Second {
		t.Fatalf("ordinary port timeout = %s, want 3s", got)
	}
}
