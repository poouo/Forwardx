package main

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestMimicConnectionStateParsing(t *testing.T) {
	cases := map[string]string{
		"Connection: Established": "established",
		"state Idle":              "idle",
		"no active connection":    "waiting",
		"Connecting to peer":      "connecting",
		"hooks ready":             "unknown",
	}
	for input, expected := range cases {
		if actual := mimicConnectionState(input); actual != expected {
			t.Fatalf("input=%q state=%q want=%q", input, actual, expected)
		}
	}
}

func TestFXPEndpointEventTracksFailureAndRecovery(t *testing.T) {
	fxpEndpointEventMu.Lock()
	fxpEndpointEvents = map[string]fxpEndpointEvent{}
	fxpEndpointEventMu.Unlock()
	spec := fxpSpec{Role: "entry", TunnelID: 3, RuleID: 8}
	recordFXPEndpointLog(spec, "exit endpoint unhealthy index=1 endpoint=203.0.113.8:62444 reason=i/o timeout")
	events := fxpEndpointEventsSnapshot()
	if len(events) != 1 || events[0].Status != "unhealthy" || !strings.Contains(events[0].Message, "timeout") {
		t.Fatalf("unexpected unhealthy event: %#v", events)
	}
	recordFXPEndpointLog(spec, "exit endpoint recovered index=1 endpoint=203.0.113.8:62444")
	events = fxpEndpointEventsSnapshot()
	if len(events) != 1 || events[0].Status != "recovered" || events[0].StartedAt <= 0 {
		t.Fatalf("unexpected recovered event: %#v", events)
	}
}

func TestSupportOutputRedactsCredentials(t *testing.T) {
	redacted := redactSupportOutput("token=abc password: def safe=value")
	if strings.Contains(redacted, "abc") || strings.Contains(redacted, "def") || !strings.Contains(redacted, "safe=value") {
		t.Fatalf("unexpected redaction: %s", redacted)
	}
}

func TestSupportOutputTruncationKeepsUTF8AndLimit(t *testing.T) {
	value := strings.Repeat("中", 100)
	truncated := truncateSupportOutput(value, 64)
	if len(truncated) > 64 {
		t.Fatalf("truncated output is too large: %d", len(truncated))
	}
	if !utf8.ValidString(truncated) {
		t.Fatalf("truncated output is not valid UTF-8: %q", truncated)
	}
	if !strings.HasSuffix(truncated, supportTruncationMarker) {
		t.Fatalf("missing truncation marker: %q", truncated)
	}
}

func TestSupportOutputTotalLimit(t *testing.T) {
	results := []supportCommandResult{
		{Name: "one", Output: strings.Repeat("a", 80)},
		{Name: "two", Output: strings.Repeat("b", 80)},
		{Name: "three", Output: strings.Repeat("c", 80)},
	}
	enforceSupportOutputTotalLimit(results, 150)
	total := 0
	for _, result := range results {
		total += len(result.Output)
	}
	if total > 150 {
		t.Fatalf("total output=%d exceeds limit", total)
	}
	if results[0].Output != strings.Repeat("a", 80) {
		t.Fatal("earlier result was unexpectedly truncated")
	}
	if results[2].Output != "" {
		t.Fatalf("expected later result to be omitted, got %q", results[2].Output)
	}
}
