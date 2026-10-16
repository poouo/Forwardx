package main

import (
	"fmt"
	"testing"
	"time"
)

func TestForwardToolsMatchManagedRuntimeFallbackPaths(t *testing.T) {
	paths := map[string]bool{"/usr/local/bin/gost": true, "/usr/sbin/nginx": true, "/usr/local/bin/realm": true, "/usr/bin/iptables": true, "/usr/bin/nft": true, "/usr/bin/socat": true}
	lookup := func(name string) (string, error) {
		path := "/usr/bin/" + name
		if paths[path] {
			return path, nil
		}
		return "", fmt.Errorf("missing")
	}
	tools := discoverForwardTools(lookup, func(path string) bool { return paths[path] }, "linux")
	for tool, found := range tools {
		if !found {
			t.Fatalf("%s should use its managed fallback path", tool)
		}
	}
	delete(paths, "/usr/local/bin/realm")
	if discoverForwardTools(lookup, func(path string) bool { return paths[path] }, "linux")["realm"] {
		t.Fatal("realm must use the actual absolute apply path")
	}
	for tool, found := range discoverForwardTools(lookup, func(path string) bool { return paths[path] }, "windows") {
		if found {
			t.Fatalf("%s must not claim Linux shell support on Windows", tool)
		}
	}
}

func TestFailedDesiredActionsReportConsecutiveFailuresAndRetryEligibility(t *testing.T) {
	isolateAccessLimitMaintenanceState(t)
	resetActionStatusReportsForTest()
	t.Cleanup(resetActionStatusReportsForTest)
	a := action{Op: "apply", StatusType: "rule", RuleID: 81234, SourcePort: 12000, ForwardType: "gost", ConfigRevision: 1}
	key, signature := desiredActionKey(a), desiredActionSignature(a)
	for attempt := 1; attempt <= 2; attempt++ {
		enqueueActionStatusReport(Config{}, a, false, "listener not ready")
		reports := takeActionStatusReports(1)
		if len(reports) != 1 || reports[0].payload.ConsecutiveFailures != attempt {
			t.Fatalf("attempt %d reports=%+v", attempt, reports)
		}
		if reports[0].payload.RetryNotBefore < time.Now().Add(29*time.Second).UnixMilli() {
			t.Fatal("retry eligibility must honor the desired-state cooldown")
		}
		rememberDesiredActionResult(key, signature, false)
	}
	rememberDesiredActionResult(key, signature, true)
	enqueueActionStatusReport(Config{}, a, true, "")
	report := takeActionStatusReports(1)[0].payload
	if report.ConsecutiveFailures != 0 || report.RetryNotBefore != 0 {
		t.Fatal("success must clear retry details")
	}
	a.ConfigRevision = 0 // legacy action: retry policy is not known
	enqueueActionStatusReport(Config{}, a, false, "legacy failure")
	if takeActionStatusReports(1)[0].payload.RetryNotBefore != 0 {
		t.Fatal("legacy actions must not fabricate retry eligibility")
	}
}
