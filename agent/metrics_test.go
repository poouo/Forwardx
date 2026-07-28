package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testTrafficReportIdentity(name string) string {
	return trafficReportIdentityForPanel(
		Config{Token: "token-" + name},
		"https://"+name+".example.test",
	)
}

func testRulePendingTrafficReport(reportID string, identity string, baselines ...persistedTrafficBaseline) pendingTrafficReport {
	stats := make([]any, 0, len(baselines))
	for _, baseline := range baselines {
		stats = append(stats, []any{baseline.RuleID, baseline.In, baseline.Out, baseline.Conns})
	}
	return pendingTrafficReport{
		Payload: map[string]any{
			"reportId":         reportID,
			"reportProducerId": trafficReportProducerID(identity),
			"s":                stats,
		},
		Baselines:      baselines,
		Identity:       identity,
		HasRuleTraffic: len(baselines) > 0,
		StatCount:      len(baselines),
	}
}

func testHostPendingTrafficReport(reportID string, identity string) pendingTrafficReport {
	report := testRulePendingTrafficReport(reportID, identity)
	report.Payload["h"] = []any{uint64(1200), uint64(800)}
	report.HasHostTraffic = true
	return report
}

func useIsolatedTrafficState(t *testing.T) string {
	t.Helper()
	previousDir := trafficStateDir
	previousRuleReportedAt := lastRuleTrafficReportAt
	previousHostReportedAt := lastHostTrafficReportAt
	previousDirty := trafficStateDirectoryDirty.Load()
	previousSync := trafficStateDirectorySync
	trafficPrevMu.Lock()
	previousCache := trafficPrevCache
	trafficPrevCache = map[string]trafficPrevState{}
	trafficPrevMu.Unlock()

	stateDir := t.TempDir()
	trafficStateDir = stateDir
	lastRuleTrafficReportAt = time.Time{}
	lastHostTrafficReportAt = time.Time{}
	trafficStateDirectoryDirty.Store(false)
	trafficStateDirectorySync = syncTrafficStateDirectory
	t.Cleanup(func() {
		trafficStateDir = previousDir
		lastRuleTrafficReportAt = previousRuleReportedAt
		lastHostTrafficReportAt = previousHostReportedAt
		trafficStateDirectorySync = previousSync
		trafficStateDirectoryDirty.Store(previousDirty)
		trafficPrevMu.Lock()
		trafficPrevCache = previousCache
		trafficPrevMu.Unlock()
	})
	return stateDir
}

func TestICMPEchoRequestChecksum(t *testing.T) {
	packet := buildICMPEchoRequest(8, 0x1234, 1)
	if got := icmpChecksum(packet); got != 0 {
		t.Fatalf("checksum should validate to zero, got %#x", got)
	}
}

func TestStripIPv4Header(t *testing.T) {
	header := make([]byte, 20)
	header[0] = 0x45
	body := []byte{0, 0, 0, 0, 0x12, 0x34, 0, 1}
	packet := append(header, body...)
	if got := stripIPv4Header(packet); !bytes.Equal(got, body) {
		t.Fatalf("unexpected stripped packet: %v", got)
	}
}

func TestCPUUsageFromTimes(t *testing.T) {
	cpuUsageMu.Lock()
	previousCPUTimes = cpuTimes{Idle: 100, Total: 200}
	previousCPUReady = true
	cpuUsageMu.Unlock()

	if got := cpuUsageFromTimes(cpuTimes{Idle: 125, Total: 300}); got != 75 {
		t.Fatalf("unexpected cpu usage: got %d want 75", got)
	}
}

func TestTrafficBaselinesCommitOnlyAfterSuccessfulReport(t *testing.T) {
	previousDir := trafficStateDir
	trafficPrevMu.Lock()
	previousCache := trafficPrevCache
	trafficPrevCache = map[string]trafficPrevState{}
	trafficPrevMu.Unlock()
	trafficStateDir = t.TempDir()
	t.Cleanup(func() {
		trafficStateDir = previousDir
		trafficPrevMu.Lock()
		trafficPrevCache = previousCache
		trafficPrevMu.Unlock()
	})

	update := trafficBaselineUpdate{
		port:  "22022",
		state: trafficPrevState{ruleID: 42, in: 1200, out: 800, conns: 3},
	}
	initial := trafficBaselineUpdate{
		port:  update.port,
		state: trafficPrevState{ruleID: 42, in: 1000, out: 500, conns: 2},
	}
	if err := commitTrafficBaselines(true, []trafficBaselineUpdate{initial}); err != nil {
		t.Fatalf("commit initial baseline: %v", err)
	}
	if err := commitTrafficBaselines(false, []trafficBaselineUpdate{update}); err != nil {
		t.Fatalf("retain failed-report baseline: %v", err)
	}
	if ruleID, in, out, conns := readPrev(update.port); ruleID != 42 || in != 1000 || out != 500 || conns != 2 {
		t.Fatalf("failed report advanced baseline: rule=%d in=%d out=%d conns=%d", ruleID, in, out, conns)
	} else if delta(update.state.in, in) != 200 || delta(update.state.out, out) != 300 || delta(update.state.conns, conns) != 1 {
		t.Fatal("failed report delta was not retained for retry")
	}

	if err := commitTrafficBaselines(true, []trafficBaselineUpdate{update}); err != nil {
		t.Fatalf("commit successful-report baseline: %v", err)
	}
	if ruleID, in, out, conns := readPrev(update.port); ruleID != 42 || in != 1200 || out != 800 || conns != 3 {
		t.Fatalf("successful report did not advance baseline: rule=%d in=%d out=%d conns=%d", ruleID, in, out, conns)
	} else if delta(1250, in) != 50 || delta(825, out) != 25 || delta(4, conns) != 1 {
		t.Fatal("successful retry did not establish the next delta baseline")
	}
}

func TestPendingTrafficReportPersistsPayloadAndCommitsSnapshot(t *testing.T) {
	previousDir := trafficStateDir
	trafficPrevMu.Lock()
	previousCache := trafficPrevCache
	trafficPrevCache = map[string]trafficPrevState{}
	trafficPrevMu.Unlock()
	trafficStateDir = t.TempDir()
	t.Cleanup(func() {
		trafficStateDir = previousDir
		trafficPrevMu.Lock()
		trafficPrevCache = previousCache
		trafficPrevMu.Unlock()
	})

	identity := testTrafficReportIdentity("stable")
	report := testRulePendingTrafficReport(
		"agent-stable-report",
		identity,
		persistedTrafficBaseline{Port: "22022", RuleID: 42, In: 1200, Out: 800, Conns: 3},
	)
	if err := os.WriteFile(trafficStateDir+"/port_22022.rule", []byte("42"), 0600); err != nil {
		t.Fatalf("write current rule state: %v", err)
	}
	if err := savePendingTrafficReport(report); err != nil {
		t.Fatalf("save pending traffic report: %v", err)
	}
	loaded, ok, err := loadPendingTrafficReport(identity)
	if err != nil {
		t.Fatalf("load pending traffic report: %v", err)
	}
	if !ok || loaded.Payload["reportId"] != "agent-stable-report" || loaded.StatCount != 1 {
		t.Fatalf("pending traffic report did not round trip: %+v ok=%v", loaded, ok)
	}
	if err := completePendingTrafficReport(loaded); err != nil {
		t.Fatalf("complete pending traffic report: %v", err)
	}
	if _, err := os.Stat(pendingTrafficReportPath()); !os.IsNotExist(err) {
		t.Fatalf("completed pending report was not removed: %v", err)
	}
	if ruleID, in, out, conns := readPrev("22022"); ruleID != 42 || in != 1200 || out != 800 || conns != 3 {
		t.Fatalf("pending report baseline was not committed: rule=%d in=%d out=%d conns=%d", ruleID, in, out, conns)
	}
}

func TestPendingTrafficReportStaysPendingUntilBaselinePersists(t *testing.T) {
	previousDir := trafficStateDir
	trafficPrevMu.Lock()
	previousCache := trafficPrevCache
	trafficPrevCache = map[string]trafficPrevState{}
	trafficPrevMu.Unlock()
	trafficStateDir = t.TempDir()
	t.Cleanup(func() {
		trafficStateDir = previousDir
		trafficPrevMu.Lock()
		trafficPrevCache = previousCache
		trafficPrevMu.Unlock()
	})

	report := testRulePendingTrafficReport(
		"agent-durable-baseline",
		testTrafficReportIdentity("durable-baseline"),
		persistedTrafficBaseline{Port: "22022", RuleID: 42, In: 1200, Out: 800, Conns: 3},
	)
	if err := os.WriteFile(trafficStateDir+"/port_22022.rule", []byte("42"), 0600); err != nil {
		t.Fatalf("write current rule state: %v", err)
	}
	if err := savePendingTrafficReport(report); err != nil {
		t.Fatalf("save pending traffic report: %v", err)
	}
	baselinePath := trafficStateDir + "/traffic_22022.prev"
	if err := os.Mkdir(baselinePath, 0700); err != nil {
		t.Fatalf("create baseline write blocker: %v", err)
	}
	if err := os.WriteFile(baselinePath+"/keep", []byte("block replacement"), 0600); err != nil {
		t.Fatalf("populate baseline write blocker: %v", err)
	}
	if err := completePendingTrafficReport(report); err == nil {
		t.Fatal("pending report completed even though its baseline could not persist")
	}
	if _, err := os.Stat(pendingTrafficReportPath()); err != nil {
		t.Fatalf("pending report was not retained after baseline failure: %v", err)
	}
	trafficPrevMu.Lock()
	_, cached := trafficPrevCache["22022"]
	trafficPrevMu.Unlock()
	if cached {
		t.Fatal("failed baseline write advanced the in-memory baseline")
	}
	if err := os.Remove(baselinePath + "/keep"); err != nil {
		t.Fatalf("remove baseline blocker file: %v", err)
	}
	if err := os.Remove(baselinePath); err != nil {
		t.Fatalf("remove baseline blocker directory: %v", err)
	}
	if err := completePendingTrafficReport(report); err != nil {
		t.Fatalf("complete pending report after baseline recovered: %v", err)
	}
	if _, err := os.Stat(pendingTrafficReportPath()); !os.IsNotExist(err) {
		t.Fatalf("completed pending report was not removed: %v", err)
	}
}

func TestPendingTrafficReportStaysPendingOnRuleStateReadFailure(t *testing.T) {
	previousDir := trafficStateDir
	trafficPrevMu.Lock()
	previousCache := trafficPrevCache
	trafficPrevCache = map[string]trafficPrevState{}
	trafficPrevMu.Unlock()
	trafficStateDir = t.TempDir()
	t.Cleanup(func() {
		trafficStateDir = previousDir
		trafficPrevMu.Lock()
		trafficPrevCache = previousCache
		trafficPrevMu.Unlock()
	})

	report := testRulePendingTrafficReport(
		"agent-rule-state-read",
		testTrafficReportIdentity("rule-state-read"),
		persistedTrafficBaseline{Port: "22022", RuleID: 42, In: 1200, Out: 800, Conns: 3},
	)
	if err := savePendingTrafficReport(report); err != nil {
		t.Fatalf("save pending traffic report: %v", err)
	}
	rulePath := trafficStateDir + "/port_22022.rule"
	if err := os.Mkdir(rulePath, 0700); err != nil {
		t.Fatalf("create rule state read blocker: %v", err)
	}
	if err := completePendingTrafficReport(report); err == nil {
		t.Fatal("pending report completed after a transient rule state read failure")
	}
	if _, err := os.Stat(pendingTrafficReportPath()); err != nil {
		t.Fatalf("pending report was not retained after rule state read failure: %v", err)
	}
	if err := os.Remove(rulePath); err != nil {
		t.Fatalf("remove rule state read blocker: %v", err)
	}
	if err := os.WriteFile(rulePath, []byte("42"), 0600); err != nil {
		t.Fatalf("restore current rule state: %v", err)
	}
	if err := completePendingTrafficReport(report); err != nil {
		t.Fatalf("complete pending report after rule state recovered: %v", err)
	}
}

func TestPendingTrafficReportRejectsAnotherPanelIdentity(t *testing.T) {
	previousDir := trafficStateDir
	trafficPrevMu.Lock()
	previousCache := trafficPrevCache
	trafficPrevCache = map[string]trafficPrevState{}
	trafficPrevMu.Unlock()
	trafficStateDir = t.TempDir()
	t.Cleanup(func() {
		trafficStateDir = previousDir
		trafficPrevMu.Lock()
		trafficPrevCache = previousCache
		trafficPrevMu.Unlock()
	})
	writePrev("22022", 42, 1200, 800, 3)
	oldIdentity := testTrafficReportIdentity("old-panel")
	newIdentity := testTrafficReportIdentity("new-panel")
	report := testHostPendingTrafficReport("agent-old-panel", oldIdentity)
	if err := savePendingTrafficReport(report); err != nil {
		t.Fatalf("save pending traffic report: %v", err)
	}
	if _, ok, err := loadPendingTrafficReport(newIdentity); err != nil {
		t.Fatalf("reject mismatched pending traffic report: %v", err)
	} else if ok {
		t.Fatal("pending report from another panel identity was accepted")
	}
	if _, err := os.Stat(pendingTrafficReportPath()); !os.IsNotExist(err) {
		t.Fatalf("mismatched pending report was not removed: %v", err)
	}
	if _, err := os.Stat(trafficStateDir + "/traffic_22022.prev"); !os.IsNotExist(err) {
		t.Fatalf("old traffic baseline was not removed: %v", err)
	}
}

func TestTrafficReportIdentityChangeClearsPendingState(t *testing.T) {
	previousDir := trafficStateDir
	previousRuntimeURL, _ := runtimePanelURL.Load().(string)
	previousRuleReportedAt := lastRuleTrafficReportAt
	previousHostReportedAt := lastHostTrafficReportAt
	trafficPrevMu.Lock()
	previousCache := trafficPrevCache
	trafficPrevCache = map[string]trafficPrevState{}
	trafficPrevMu.Unlock()
	trafficStateDir = t.TempDir()
	t.Cleanup(func() {
		trafficStateDir = previousDir
		runtimePanelURL.Store(previousRuntimeURL)
		lastRuleTrafficReportAt = previousRuleReportedAt
		lastHostTrafficReportAt = previousHostReportedAt
		trafficPrevMu.Lock()
		trafficPrevCache = previousCache
		trafficPrevMu.Unlock()
	})

	cfg := Config{PanelURL: "https://old.example.test", Token: "shared-token"}
	runtimePanelURL.Store("")
	oldIdentity := trafficReportIdentity(cfg)
	if err := ensureTrafficReportIdentity(oldIdentity); err != nil {
		t.Fatalf("initialize traffic report identity: %v", err)
	}
	writePrev("22022", 42, 1200, 800, 3)
	if err := savePendingTrafficReport(testHostPendingTrafficReport("agent-old-panel", oldIdentity)); err != nil {
		t.Fatalf("save pending traffic report: %v", err)
	}
	lastRuleTrafficReportAt = time.Now()
	lastHostTrafficReportAt = time.Now()

	runtimePanelURL.Store("https://new.example.test")
	newIdentity := trafficReportIdentity(cfg)
	if newIdentity == oldIdentity {
		t.Fatal("runtime panel switch did not change traffic report identity")
	}
	if err := ensureTrafficReportIdentity(newIdentity); err != nil {
		t.Fatalf("switch traffic report identity: %v", err)
	}
	if _, err := os.Stat(pendingTrafficReportPath()); !os.IsNotExist(err) {
		t.Fatalf("old panel pending report was not removed: %v", err)
	}
	if _, err := os.Stat(trafficStateDir + "/traffic_22022.prev"); !os.IsNotExist(err) {
		t.Fatalf("old panel traffic baseline was not removed: %v", err)
	}
	trafficPrevMu.Lock()
	cacheSize := len(trafficPrevCache)
	trafficPrevMu.Unlock()
	if cacheSize != 0 {
		t.Fatalf("old panel traffic baseline cache was not cleared: %d entries", cacheSize)
	}
	if !lastRuleTrafficReportAt.IsZero() || !lastHostTrafficReportAt.IsZero() {
		t.Fatal("old panel traffic report timestamps were not reset")
	}
	rawIdentity, err := os.ReadFile(trafficStateDir + "/" + trafficReportIdentityFile)
	if err != nil {
		t.Fatalf("read traffic report identity: %v", err)
	}
	if strings.TrimSpace(string(rawIdentity)) != newIdentity {
		t.Fatalf("stored traffic report identity = %q, want %q", strings.TrimSpace(string(rawIdentity)), newIdentity)
	}
}

func TestTrafficReportIdentityDoesNotAdvanceWhenStateCleanupFails(t *testing.T) {
	useIsolatedTrafficState(t)
	oldIdentity := testTrafficReportIdentity("cleanup-old")
	newIdentity := testTrafficReportIdentity("cleanup-new")
	if err := ensureTrafficReportIdentity(oldIdentity); err != nil {
		t.Fatalf("initialize traffic report identity: %v", err)
	}
	writePrev("22022", 42, 1200, 800, 3)
	if err := savePendingTrafficReport(testHostPendingTrafficReport("agent-cleanup-blocked", oldIdentity)); err != nil {
		t.Fatalf("save pending traffic report: %v", err)
	}

	syncFailure := errors.New("directory sync blocked")
	trafficStateDirectorySync = func(string) error { return syncFailure }
	if err := ensureTrafficReportIdentity(newIdentity); !errors.Is(err, syncFailure) {
		t.Fatal("traffic identity advanced even though old state cleanup failed")
	}
	rawIdentity, err := os.ReadFile(trafficStateDir + "/" + trafficReportIdentityFile)
	if err != nil {
		t.Fatalf("read retained traffic identity: %v", err)
	}
	if strings.TrimSpace(string(rawIdentity)) != oldIdentity {
		t.Fatalf("traffic identity changed after failed cleanup: %q", strings.TrimSpace(string(rawIdentity)))
	}
	if _, err := os.Stat(pendingTrafficReportPath()); err != nil {
		t.Fatalf("pending report was removed before cleanup completed: %v", err)
	}
	trafficPrevMu.Lock()
	_, cached := trafficPrevCache["22022"]
	trafficPrevMu.Unlock()
	if !cached {
		t.Fatal("baseline cache was cleared before filesystem cleanup completed")
	}
}

func TestPendingTrafficReportDoesNotRestoreAnOldRuleBaseline(t *testing.T) {
	useIsolatedTrafficState(t)
	if err := os.WriteFile(trafficStateDir+"/port_22022.rule", []byte("43"), 0600); err != nil {
		t.Fatalf("write replacement rule state: %v", err)
	}
	report := testRulePendingTrafficReport(
		"agent-stale-rule",
		testTrafficReportIdentity("stale-rule"),
		persistedTrafficBaseline{Port: "22022", RuleID: 42, In: 1200, Out: 800, Conns: 3},
	)
	if err := savePendingTrafficReport(report); err != nil {
		t.Fatalf("save stale pending traffic report: %v", err)
	}
	if err := completePendingTrafficReport(report); err != nil {
		t.Fatalf("complete stale pending traffic report: %v", err)
	}
	if _, err := os.Stat(trafficStateDir + "/traffic_22022.prev"); !os.IsNotExist(err) {
		t.Fatalf("old rule baseline was restored after port reuse: %v", err)
	}
}

func TestPendingTrafficReportKeepsMalformedStateForDiagnosis(t *testing.T) {
	useIsolatedTrafficState(t)
	identity := testTrafficReportIdentity("malformed")
	tests := []struct {
		name string
		raw  []byte
	}{
		{name: "truncated", raw: []byte(`{"payload":`)},
		{name: "trailing value", raw: []byte(`{} {}`)},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if err := os.WriteFile(pendingTrafficReportPath(), tc.raw, 0600); err != nil {
				t.Fatalf("write malformed pending report: %v", err)
			}
			if _, ok, err := loadPendingTrafficReport(identity); err == nil {
				t.Fatal("malformed pending report was silently accepted")
			} else if ok {
				t.Fatal("malformed pending report was marked loadable")
			}
			retained, err := os.ReadFile(pendingTrafficReportPath())
			if err != nil {
				t.Fatalf("malformed pending report was removed: %v", err)
			}
			if !bytes.Equal(retained, tc.raw) {
				t.Fatalf("malformed pending report changed: got %q want %q", retained, tc.raw)
			}
		})
	}
}

func TestPendingTrafficReportRequiresStableIdentifiers(t *testing.T) {
	useIsolatedTrafficState(t)
	identity := testTrafficReportIdentity("required-identifiers")
	tests := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{name: "missing report id", mutate: func(payload map[string]any) { delete(payload, "reportId") }},
		{name: "null report id", mutate: func(payload map[string]any) { payload["reportId"] = nil }},
		{name: "empty report id", mutate: func(payload map[string]any) { payload["reportId"] = "" }},
		{name: "missing producer id", mutate: func(payload map[string]any) { delete(payload, "reportProducerId") }},
		{name: "null producer id", mutate: func(payload map[string]any) { payload["reportProducerId"] = nil }},
		{name: "empty producer id", mutate: func(payload map[string]any) { payload["reportProducerId"] = "" }},
		{name: "wrong producer id", mutate: func(payload map[string]any) { payload["reportProducerId"] = "agent-other" }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			report := testHostPendingTrafficReport("agent-required-fields", identity)
			tc.mutate(report.Payload)
			if err := savePendingTrafficReport(report); err == nil {
				t.Fatal("pending report with an invalid identifier was saved")
			}
		})
	}
}

func TestPendingTrafficReportRejectsInconsistentSnapshot(t *testing.T) {
	identity := testTrafficReportIdentity("inconsistent")
	baseline := persistedTrafficBaseline{Port: "22022", RuleID: 42, In: 1200, Out: 800, Conns: 3}
	tests := []struct {
		name   string
		mutate func(*pendingTrafficReport)
	}{
		{name: "stat count", mutate: func(report *pendingTrafficReport) { report.StatCount++ }},
		{name: "missing baseline", mutate: func(report *pendingTrafficReport) { report.Baselines = nil }},
		{name: "payload rule", mutate: func(report *pendingTrafficReport) {
			report.Payload["s"] = []any{[]any{43, 1200, 800, 3}}
		}},
		{name: "mixed payload formats", mutate: func(report *pendingTrafficReport) {
			report.Payload["stats"] = []any{}
		}},
		{name: "rule traffic flag", mutate: func(report *pendingTrafficReport) { report.HasRuleTraffic = false }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			report := testRulePendingTrafficReport("agent-inconsistent", identity, baseline)
			tc.mutate(&report)
			if err := validatePendingTrafficReport(report); err == nil {
				t.Fatal("inconsistent pending report passed validation")
			}
		})
	}
}

func TestPendingTrafficReportLoadPreservesLargeIntegers(t *testing.T) {
	useIsolatedTrafficState(t)
	identity := testTrafficReportIdentity("large-integer")
	const largeCounter = "9007199254740993"
	raw := []byte(fmt.Sprintf(
		`{"payload":{"reportId":"agent-large-integer","reportProducerId":%q,"s":[[42,%s,0,0]]},"baselines":[{"port":"22022","ruleId":42,"in":%s,"out":0,"conns":0}],"identity":%q,"hasRuleTraffic":true,"hasHostTraffic":false,"statCount":1}`,
		trafficReportProducerID(identity), largeCounter, largeCounter, identity,
	))
	if err := os.WriteFile(pendingTrafficReportPath(), raw, 0600); err != nil {
		t.Fatalf("write pending report with large counters: %v", err)
	}
	report, ok, err := loadPendingTrafficReport(identity)
	if err != nil {
		t.Fatalf("load pending report with large counters: %v", err)
	}
	if !ok {
		t.Fatal("valid pending report with large counters was not loaded")
	}
	stats, ok := report.Payload["s"].([]any)
	if !ok || len(stats) != 1 {
		t.Fatalf("unexpected compact stats: %#v", report.Payload["s"])
	}
	row, ok := stats[0].([]any)
	if !ok || len(row) != 4 {
		t.Fatalf("unexpected compact stat row: %#v", stats[0])
	}
	counter, ok := row[1].(json.Number)
	if !ok || counter.String() != largeCounter {
		t.Fatalf("large payload counter lost precision: %#v", row[1])
	}
	if report.Baselines[0].In != uint64(9007199254740993) {
		t.Fatalf("large baseline counter lost precision: %d", report.Baselines[0].In)
	}
}

func TestTrafficStateRenameAndRemoveSyncDirectory(t *testing.T) {
	stateDir := useIsolatedTrafficState(t)
	var syncCalls atomic.Int32
	trafficStateDirectorySync = func(gotDir string) error {
		if gotDir != stateDir {
			t.Fatalf("directory sync target = %q, want %q", gotDir, stateDir)
		}
		syncCalls.Add(1)
		return nil
	}
	path := trafficStateDir + "/state"
	if err := writeTrafficStateFile(path, []byte("durable"), 0600); err != nil {
		t.Fatalf("write durable traffic state: %v", err)
	}
	if got := syncCalls.Load(); got != 1 {
		t.Fatalf("rename directory sync calls = %d, want 1", got)
	}
	if err := removeTrafficStateFile(path, trafficStateDir); err != nil {
		t.Fatalf("remove durable traffic state: %v", err)
	}
	if got := syncCalls.Load(); got != 2 {
		t.Fatalf("rename and remove directory sync calls = %d, want 2", got)
	}
}

func TestPendingTrafficReportWaitsForDirectorySyncRecovery(t *testing.T) {
	useIsolatedTrafficState(t)
	identity := testTrafficReportIdentity("sync-recovery")
	report := testHostPendingTrafficReport("agent-sync-recovery", identity)
	syncFailure := errors.New("directory sync unavailable")
	syncRecovered := false
	trafficStateDirectorySync = func(string) error {
		if !syncRecovered {
			return syncFailure
		}
		return nil
	}
	if err := savePendingTrafficReport(report); !errors.Is(err, syncFailure) {
		t.Fatalf("save pending report error = %v, want directory sync failure", err)
	}
	if _, err := os.Stat(pendingTrafficReportPath()); err != nil {
		t.Fatalf("renamed pending report was not retained after sync failure: %v", err)
	}
	if _, ok, err := loadPendingTrafficReport(identity); !errors.Is(err, syncFailure) {
		t.Fatalf("load before directory sync recovery error = %v, want sync failure", err)
	} else if ok {
		t.Fatal("pending report became loadable before directory durability recovered")
	}

	syncRecovered = true
	loaded, ok, err := loadPendingTrafficReport(identity)
	if err != nil {
		t.Fatalf("load pending report after directory sync recovered: %v", err)
	}
	if !ok || loaded.Payload["reportId"] != report.Payload["reportId"] {
		t.Fatalf("pending report did not recover: %+v ok=%v", loaded, ok)
	}
}

func TestFirstTrafficReportIdentityClearsLegacyState(t *testing.T) {
	useIsolatedTrafficState(t)
	identity := testTrafficReportIdentity("first-identity")
	if err := writePrevState("22022", trafficPrevState{ruleID: 42, in: 1200, out: 800, conns: 3}); err != nil {
		t.Fatalf("write legacy baseline: %v", err)
	}
	if err := savePendingTrafficReport(testHostPendingTrafficReport("agent-legacy-pending", identity)); err != nil {
		t.Fatalf("write legacy pending report: %v", err)
	}
	lastRuleTrafficReportAt = time.Now()
	lastHostTrafficReportAt = time.Now()

	if err := ensureTrafficReportIdentity(identity); err != nil {
		t.Fatalf("initialize first traffic identity: %v", err)
	}
	for _, path := range []string{trafficStateDir + "/traffic_22022.prev", pendingTrafficReportPath()} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("legacy traffic state was not removed: %s (%v)", path, err)
		}
	}
	trafficPrevMu.Lock()
	cacheSize := len(trafficPrevCache)
	trafficPrevMu.Unlock()
	if cacheSize != 0 {
		t.Fatalf("legacy traffic cache was not cleared: %d entries", cacheSize)
	}
	if !lastRuleTrafficReportAt.IsZero() || !lastHostTrafficReportAt.IsZero() {
		t.Fatal("legacy traffic report timestamps were not reset")
	}
	rawIdentity, err := os.ReadFile(trafficStateDir + "/" + trafficReportIdentityFile)
	if err != nil {
		t.Fatalf("read initialized traffic identity: %v", err)
	}
	if strings.TrimSpace(string(rawIdentity)) != identity {
		t.Fatalf("initialized traffic identity = %q, want %q", strings.TrimSpace(string(rawIdentity)), identity)
	}
}

func TestTrafficReportIdentityUsesExactTokenBytes(t *testing.T) {
	const panelURL = "https://panel.example.test"
	plain := trafficReportIdentityForPanel(Config{Token: "shared-token"}, panelURL)
	leading := trafficReportIdentityForPanel(Config{Token: " shared-token"}, panelURL)
	trailing := trafficReportIdentityForPanel(Config{Token: "shared-token "}, panelURL)
	if plain == leading || plain == trailing || leading == trailing {
		t.Fatalf("token whitespace was ignored by traffic identity: plain=%s leading=%s trailing=%s", plain, leading, trailing)
	}
}

func TestTrafficReportIDsAreUniqueAcrossEqualBatches(t *testing.T) {
	first := newTrafficReportID()
	second := newTrafficReportID()
	if first == second {
		t.Fatalf("equal traffic batches received the same report id: %q", first)
	}
	if !strings.HasPrefix(first, "agent-") || !strings.HasPrefix(second, "agent-") {
		t.Fatalf("unexpected traffic report ids: %q %q", first, second)
	}
}

func TestTrafficReportProducerIDIsStableForOnePanelIdentity(t *testing.T) {
	identity := trafficReportIdentity(Config{PanelURL: "https://panel.example.test", Token: "token-a"})
	first := trafficReportProducerID(identity)
	second := trafficReportProducerID(identity)
	if first == "agent-" || first != second {
		t.Fatalf("traffic producer id is not stable: %q %q", first, second)
	}
	other := trafficReportProducerID(trafficReportIdentity(Config{PanelURL: "https://panel.example.test", Token: "token-b"}))
	if first == other {
		t.Fatalf("different Agent identities share producer id %q", first)
	}
}

func TestIdleTrafficCollectionYieldsUntilHostSnapshotIsDue(t *testing.T) {
	if got := trafficCollectIntervalForRuleCount(0); got != idleHostTrafficReportEvery {
		t.Fatalf("idle interval=%s want=%s", got, idleHostTrafficReportEvery)
	}
	if got := trafficCollectBackoffInterval(idleHostTrafficReportEvery, 10*time.Second); got != idleHostTrafficReportEvery {
		t.Fatalf("idle backoff=%s want=%s", got, idleHostTrafficReportEvery)
	}
}

func TestNewRuleMakesIdleTrafficCollectionImmediatelyDue(t *testing.T) {
	trafficCollectMu.Lock()
	previousLast := lastTrafficCollectAt
	previousNext := nextTrafficCollectInterval
	lastTrafficCollectAt = time.Now()
	nextTrafficCollectInterval = idleHostTrafficReportEvery
	trafficCollectMu.Unlock()
	t.Cleanup(func() {
		trafficCollectMu.Lock()
		lastTrafficCollectAt = previousLast
		nextTrafficCollectInterval = previousNext
		trafficCollectMu.Unlock()
	})

	prioritizeTrafficCollectionForRules(1)
	trafficCollectMu.Lock()
	defer trafficCollectMu.Unlock()
	if !lastTrafficCollectAt.IsZero() || nextTrafficCollectInterval != trafficCollectInterval {
		t.Fatalf("new rule did not reset idle schedule: last=%s next=%s", lastTrafficCollectAt, nextTrafficCollectInterval)
	}
}

func TestParseNftProcessCounterSnapshot(t *testing.T) {
	raw := `table inet forwardx_traffic {
	chain input {
		type filter hook input priority mangle; policy accept;
		tcp dport 22022 counter packets 3 bytes 1200 comment "fwx-stat-22022:in" # handle 4
		udp dport 22022 comment "fwx-stat-22022:in" counter packets 2 bytes 300 # handle 5
	}
	chain output {
		tcp sport 22022 counter packets 4 bytes 2400 comment "fwx-stat-22022:out" # handle 6
	}
	chain forward {
		tcp daddr 203.0.113.10 tcp dport 443 counter packets 1 bytes 600 comment "fwx-stat-22022:in" # handle 7
		tcp saddr 203.0.113.10 tcp sport 443 counter packets 1 bytes 900 comment "fwx-stat-22022:out" # handle 8
	}
}`
	counters, markers := parseNftProcessCounterSnapshot(raw)
	if !markers["22022"] {
		t.Fatal("nft process traffic marker was not detected")
	}
	for _, marker := range []string{"22022:tcp:in", "22022:tcp:out", "22022:udp:in"} {
		if !markers[marker] {
			t.Fatalf("nft process layout marker %q was not detected", marker)
		}
	}
	if markers["22022:udp:out"] {
		t.Fatal("missing udp output rule was reported as installed")
	}
	if got := counters["22022"]; got.In != 1500 || got.Out != 2400 {
		t.Fatalf("unexpected nft process counters: %+v", got)
	}
}

func TestParseNftProcessCounterSnapshotRequiresCompleteListenerLayout(t *testing.T) {
	raw := `table inet forwardx_traffic {
	chain input {
		tcp dport 22022 counter packets 3 bytes 1200 comment "fwx-stat-22022:in" # handle 4
	}
	chain forward {
		tcp saddr 203.0.113.10 tcp sport 443 counter packets 1 bytes 900 comment "fwx-stat-22022:out" # handle 8
	}
}`
	counters, markers := parseNftProcessCounterSnapshot(raw)
	if markers["22022"] {
		t.Fatal("partial input/forward layout was accepted as a complete process counter backend")
	}
	if got := counters["22022"]; got.In != 1200 || got.Out != 0 {
		t.Fatalf("non-authoritative forward counter leaked into process traffic: %+v", got)
	}
}

func TestNftProcessCountingCmdsUseOnlyListenerHooks(t *testing.T) {
	commands := strings.Join(nftProcessCountingCmds(22022, "tcp"), "\n")
	for _, want := range []string{
		"input meta l4proto tcp tcp dport 22022",
		"output meta l4proto tcp tcp sport 22022",
	} {
		if !strings.Contains(commands, want) {
			t.Fatalf("nft process commands missing %q:\n%s", want, commands)
		}
	}
	if strings.Contains(commands, "forward meta l4proto") || strings.Contains(commands, "ct original proto-dst") {
		t.Fatalf("process counters must not install kernel forwarding hooks:\n%s", commands)
	}
}

func TestRuleTrafficCountersUseExactlyOneBackend(t *testing.T) {
	iptables := map[string]trafficCounters{"22022": {In: 9000, Out: 8000}}
	nativeNFT := map[int]trafficCounters{7: {In: 7000, Out: 6000}}
	processNFT := map[string]trafficCounters{"22022": {In: 1500, Out: 2400}}
	processMarkers := map[string]bool{"22022:tcp:in": true, "22022:tcp:out": true}

	process := localRuleState{Port: "22022", RuleID: 7, ForwardType: "gost", Protocol: "tcp"}
	if got := countersForRuleTrafficState(process, iptables, nativeNFT, processNFT, processMarkers); got != processNFT["22022"] {
		t.Fatalf("healthy process nft counters were merged with another backend: %+v", got)
	}
	if got := countersForRuleTrafficState(process, iptables, nativeNFT, processNFT, nil); got != iptables["22022"] {
		t.Fatalf("process counter did not fall back to iptables without a complete nft marker: %+v", got)
	}
	if got := countersForRuleTrafficState(localRuleState{Port: "22022", RuleID: 7, ForwardType: "iptables"}, iptables, nativeNFT, processNFT, processMarkers); got != iptables["22022"] {
		t.Fatalf("iptables rule sampled a different backend: %+v", got)
	}
	if got := countersForRuleTrafficState(localRuleState{Port: "22022", RuleID: 7, ForwardType: "nftables"}, iptables, nativeNFT, processNFT, processMarkers); got != nativeNFT[7] {
		t.Fatalf("native nftables rule sampled a different backend: %+v", got)
	}
}

func TestShouldCollectRuleTrafficSkipsForwardXAndInvalidRules(t *testing.T) {
	tests := []struct {
		name  string
		state localRuleState
		want  bool
	}{
		{name: "iptables", state: localRuleState{Port: "22001", RuleID: 1, ForwardType: "iptables"}, want: true},
		{name: "realm", state: localRuleState{Port: "22002", RuleID: 2, ForwardType: "realm"}, want: true},
		{name: "forwardx", state: localRuleState{Port: "22003", RuleID: 3, ForwardType: "forwardx"}, want: false},
		{name: "forwardx case insensitive", state: localRuleState{Port: "22004", RuleID: 4, ForwardType: " ForwardX "}, want: false},
		{name: "forwardx v1", state: localRuleState{Port: "22005", RuleID: 5, ForwardType: "forwardx-v1"}, want: false},
		{name: "forwardx wireguard", state: localRuleState{Port: "22006", RuleID: 6, ForwardType: " ForwardX-WireGuard "}, want: false},
		{name: "missing rule", state: localRuleState{Port: "22007", RuleID: 0, ForwardType: "gost"}, want: false},
		{name: "missing port", state: localRuleState{RuleID: 7, ForwardType: "gost"}, want: false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := shouldCollectRuleTraffic(tc.state); got != tc.want {
				t.Fatalf("shouldCollectRuleTraffic(%+v) = %v, want %v", tc.state, got, tc.want)
			}
		})
	}
}

func TestCollectableRuleTrafficStatesDriveIntervalsAndConntrackPorts(t *testing.T) {
	states := []localRuleState{
		{Port: "22001", RuleID: 1, ForwardType: "forwardx"},
		{Port: "22002", RuleID: 2, ForwardType: "forwardx-v1"},
		{Port: "22003", RuleID: 3, ForwardType: "iptables"},
		{Port: "22004", RuleID: 4, ForwardType: "realm"},
		{Port: "22005", RuleID: 0, ForwardType: "gost"},
	}
	filtered := collectableRuleTrafficStates(states)
	if len(filtered) != 2 || filtered[0].Port != "22003" || filtered[1].Port != "22004" {
		t.Fatalf("unexpected collectable states: %+v", filtered)
	}
	if got := trafficCollectIntervalForRuleCount(len(collectableRuleTrafficStates(states[:2]))); got != idleHostTrafficReportEvery {
		t.Fatalf("self-reported-only interval=%s want=%s", got, idleHostTrafficReportEvery)
	}
	ports := collectableRuleTrafficPorts(states)
	if len(ports) != 2 || !ports["22003"] || !ports["22004"] {
		t.Fatalf("conntrack ports include non-collectable rules: %+v", ports)
	}
}

func TestTrafficSnapshotRequirementsFollowForwardTypes(t *testing.T) {
	tests := []struct {
		name   string
		states []localRuleState
		want   trafficSnapshotRequirements
	}{
		{
			name: "self reported only",
			states: []localRuleState{
				{Port: "1", RuleID: 1, ForwardType: "forwardx"},
				{Port: "2", RuleID: 2, ForwardType: "forwardx-v1"},
			},
			want: trafficSnapshotRequirements{},
		},
		{name: "iptables", states: []localRuleState{{Port: "1", RuleID: 1, ForwardType: "iptables"}}, want: trafficSnapshotRequirements{iptables: true}},
		{name: "native nft", states: []localRuleState{{Port: "1", RuleID: 1, ForwardType: "nftables"}}, want: trafficSnapshotRequirements{nativeNFT: true}},
		{name: "process nft first", states: []localRuleState{{Port: "1", RuleID: 1, ForwardType: "gost"}}, want: trafficSnapshotRequirements{processNFT: true}},
		{
			name: "mixed",
			states: []localRuleState{
				{Port: "1", RuleID: 1, ForwardType: "iptables"},
				{Port: "2", RuleID: 2, ForwardType: "nftables"},
				{Port: "3", RuleID: 3, ForwardType: "realm"},
			},
			want: trafficSnapshotRequirements{iptables: true, nativeNFT: true, processNFT: true},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := trafficSnapshotRequirementsForStates(tc.states); got != tc.want {
				t.Fatalf("requirements=%+v want=%+v", got, tc.want)
			}
		})
	}
}

func TestProcessTrafficRequestsIptablesOnlyWhenNftLayoutIsMissing(t *testing.T) {
	states := []localRuleState{
		{Port: "22001", RuleID: 1, ForwardType: "gost", Protocol: "tcp"},
		{Port: "22002", RuleID: 2, ForwardType: "realm", Protocol: "both"},
		{Port: "22003", RuleID: 3, ForwardType: "nftables"},
	}
	completeMarkers := map[string]bool{
		"22001:tcp:in": true, "22001:tcp:out": true,
		"22002:tcp:in": true, "22002:tcp:out": true,
		"22002:udp:in": true, "22002:udp:out": true,
	}
	if processTrafficNeedsIptablesFallback(states, completeMarkers) {
		t.Fatal("complete process nft layouts unnecessarily requested iptables")
	}
	delete(completeMarkers, "22002:udp:out")
	if !processTrafficNeedsIptablesFallback(states, completeMarkers) {
		t.Fatal("missing process nft layout did not request iptables fallback")
	}
}

func TestCountingLayoutPresenceUsesTheExpectedSingleBackend(t *testing.T) {
	diagnostics := trafficDiagnosticsSnapshot{
		iptablesMarkers:   map[string]bool{"22001": true, "22004": true},
		ip6tablesMarkers:  map[string]bool{"22002": true},
		nftMarkers:        map[int]bool{},
		nftProcessMarkers: map[string]bool{"22003": true},
	}
	tests := []struct {
		name  string
		state localRuleState
		want  bool
	}{
		{name: "IPv4 kernel marker", state: localRuleState{Port: "22001", RuleID: 1, ForwardType: "iptables", TargetIP: "192.0.2.10", TargetPort: 443}, want: true},
		{name: "IPv6 kernel marker", state: localRuleState{Port: "22002", RuleID: 2, ForwardType: "iptables", TargetIP: "2001:db8::10", TargetPort: 443}, want: true},
		{name: "process nft marker", state: localRuleState{Port: "22003", RuleID: 3, ForwardType: "gost"}, want: true},
		{name: "process iptables fallback", state: localRuleState{Port: "22004", RuleID: 4, ForwardType: "realm"}, want: true},
		{name: "missing process layout", state: localRuleState{Port: "22005", RuleID: 5, ForwardType: "socat"}, want: false},
		{name: "missing IPv4 kernel layout", state: localRuleState{Port: "22006", RuleID: 6, ForwardType: "iptables", TargetIP: "192.0.2.20", TargetPort: 443}, want: false},
		{name: "unresolved kernel target waits for DNS", state: localRuleState{Port: "22007", RuleID: 7, ForwardType: "iptables", TargetIP: "expired.example", TargetPort: 443}, want: true},
		{name: "native nft owns its counters", state: localRuleState{Port: "22008", RuleID: 8, ForwardType: "nftables"}, want: true},
		{name: "ForwardX self reports", state: localRuleState{Port: "22009", RuleID: 9, ForwardType: "forwardx-v1"}, want: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := countingLayoutPresentForTrafficState(tc.state, diagnostics); got != tc.want {
				t.Fatalf("layout present=%v want=%v state=%+v", got, tc.want, tc.state)
			}
		})
	}
}

func TestIptablesAgentCountingForwardTargetRuleScopesConntrackPort(t *testing.T) {
	inbound := iptablesAgentCountingForwardTargetRule("tcp", "22022", "192.0.2.10", "8080", true)
	if want := "FORWARD -p tcp -m conntrack --ctorigdstport 22022 -d 192.0.2.10 --dport 8080"; inbound != want {
		t.Fatalf("inbound target rule = %q, want %q", inbound, want)
	}
	outbound := iptablesAgentCountingForwardTargetRule("tcp", "22022", "192.0.2.10", "8080", false)
	if want := "FORWARD -p tcp -m conntrack --ctorigdstport 22022 -s 192.0.2.10 --sport 8080"; outbound != want {
		t.Fatalf("outbound target rule = %q, want %q", outbound, want)
	}
	if !strings.Contains(inbound, "--ctorigdstport 22022") || !strings.Contains(outbound, "--ctorigdstport 22022") {
		t.Fatal("target rules must retain the original listener port match")
	}
}

func TestScheduleTCPingCollectionDoesNotBlockWhenBusy(t *testing.T) {
	atomic.StoreInt32(&tcpingCollectRunning, 1)
	defer atomic.StoreInt32(&tcpingCollectRunning, 0)

	started := time.Now()
	if scheduleTCPingCollection(Config{}, nil, nil, nil, nil, false) {
		t.Fatal("busy tcping collection must remain due for a retry")
	}
	if elapsed := time.Since(started); elapsed > 50*time.Millisecond {
		t.Fatalf("busy tcping schedule blocked for %s", elapsed)
	}
}

func TestScheduleTCPingCollectionDefersTopologyProbeWhileActionsPending(t *testing.T) {
	atomic.StoreInt64(&actionPendingCount, 1)
	atomic.StoreInt32(&tcpingCollectRunning, 0)
	defer atomic.StoreInt64(&actionPendingCount, 0)

	started := time.Now()
	if scheduleTCPingCollection(Config{}, nil, []tunnelProbe{{
		TunnelID: 1, TargetIP: "127.0.0.1", TargetPort: 1,
	}}, nil, nil, true) {
		t.Fatal("topology probe must remain due while runtime actions are pending")
	}
	if atomic.LoadInt32(&tcpingCollectRunning) != 0 {
		t.Fatal("deferred topology probe unexpectedly started a collector")
	}
	if elapsed := time.Since(started); elapsed > 50*time.Millisecond {
		t.Fatalf("deferred topology probe blocked for %s", elapsed)
	}
}

func TestRuntimeProbeResultsAreDiscardedAfterCompletedAction(t *testing.T) {
	previousPending := atomic.SwapInt64(&actionPendingCount, 0)
	previousEpoch := runtimeActionEpoch.Load()
	t.Cleanup(func() {
		atomic.StoreInt64(&actionPendingCount, previousPending)
		runtimeActionEpoch.Store(previousEpoch)
	})

	startEpoch := runtimeActionEpoch.Load()
	markRuntimeActionQueued()
	if pending := atomic.AddInt64(&actionPendingCount, -1); pending != 0 {
		t.Fatalf("simulated action did not finish cleanly: pending=%d", pending)
	}
	if runtimeActionEpoch.Load() == startEpoch {
		t.Fatal("queued runtime action did not advance the action epoch")
	}
	rules := []map[string]any{{"ruleId": 1}}
	tunnels := []map[string]any{{"tunnelId": 2}}
	groups := []map[string]any{{"groupId": 3}}
	services := []map[string]any{{"serviceId": 4}}

	rules, tunnels, groups, services = filterRuntimeProbeResultsAfterActions(
		startEpoch,
		false,
		rules,
		tunnels,
		groups,
		services,
	)
	if len(rules) != 0 || len(tunnels) != 0 || len(groups) != 0 {
		t.Fatalf("stale runtime results survived action epoch change: rules=%v tunnels=%v groups=%v", rules, tunnels, groups)
	}
	if len(services) != 1 || services[0]["serviceId"] != 4 {
		t.Fatalf("service result was discarded with runtime results: %v", services)
	}
}

func TestExecuteTCPingTaskSkipsWireGuardRuntimeNotReady(t *testing.T) {
	task := tcpingTask{
		Kind:            "tunnel",
		TunnelID:        12,
		TargetIP:        "100.64.0.2",
		TargetPort:      443,
		WireGuardPeerID: "22",
	}
	result := executeTCPingTaskWithWireGuardProbe(task, func(int, string, int, time.Duration) (int, wireGuardProbeStatus) {
		return 0, wireGuardProbeNotReady
	})
	if result.Payload != nil {
		t.Fatalf("not-ready WireGuard runtime produced an automatic timeout: %v", result.Payload)
	}
}

func TestExecuteTCPingTaskReportsStableWireGuardDialTimeout(t *testing.T) {
	task := tcpingTask{
		Kind:            "tunnel",
		TunnelID:        12,
		TargetIP:        "100.64.0.2",
		TargetPort:      443,
		WireGuardPeerID: "22",
	}
	result := executeTCPingTaskWithWireGuardProbe(task, func(int, string, int, time.Duration) (int, wireGuardProbeStatus) {
		return 0, wireGuardProbeTimeout
	})
	if result.Payload == nil || result.Payload["isTimeout"] != true {
		t.Fatalf("stable WireGuard dial failure was not reported as a timeout: %v", result.Payload)
	}
}

func TestTCPingDynamicBatchLimitScalesWithoutUnboundedRuns(t *testing.T) {
	tests := []struct {
		total  int
		min    int
		rounds int
		max    int
		want   int
	}{
		{total: 10, min: 24, rounds: 3, max: 160, want: 10},
		{total: 90, min: 24, rounds: 3, max: 160, want: 30},
		{total: 600, min: 24, rounds: 3, max: 256, want: 200},
		{total: 3000, min: 24, rounds: 3, max: 256, want: 256},
		{total: 25, min: 12, rounds: 2, max: 96, want: 13},
	}
	for _, tc := range tests {
		if got := tcpingDynamicBatchLimit(tc.total, tc.min, tc.rounds, tc.max); got != tc.want {
			t.Fatalf("batch limit total=%d: got %d want %d", tc.total, got, tc.want)
		}
	}
}

func TestTCPingDueIntervalScalesWithWorkAndServiceRequirements(t *testing.T) {
	if got := tcpingDueInterval(nil, 20, 2); got != time.Minute {
		t.Fatalf("small workload interval = %s", got)
	}
	if got := tcpingDueInterval(nil, 600, 0); got != 15*time.Second {
		t.Fatalf("large workload interval = %s", got)
	}
	if got := tcpingDueInterval([]hostProbeServiceProbe{{IntervalSeconds: 5}}, 600, 0); got != 5*time.Second {
		t.Fatalf("service interval should win, got %s", got)
	}
	if got := tcpingRoundsForWindow(5*time.Second, 3*time.Minute); got != 36 {
		t.Fatalf("five-second collection rounds = %d", got)
	}
	if got := capForwardGroupHealthProbeInterval(time.Minute, []forwardGroupProbe{{ProbeType: "china"}}); got != 30*time.Second {
		t.Fatalf("forward-group health probe interval = %s", got)
	}
	if got := capForwardGroupHealthProbeInterval(time.Minute, []forwardGroupProbe{{ProbeType: "entry", FailoverSeconds: 10, RecoverSeconds: 120}}); got != 5*time.Second {
		t.Fatalf("short forward-group health window interval = %s", got)
	}
	if got := capForwardGroupHealthProbeInterval(time.Minute, []forwardGroupProbe{{ProbeType: "chain"}}); got != time.Minute {
		t.Fatalf("display-only chain probe interval should stay unchanged, got %s", got)
	}
}

func TestTCPLatencyUsesOneDeadlineAcrossResolvedAddresses(t *testing.T) {
	originalLookup := lookupNetworkTargetIPs
	originalDial := dialNetworkTimeout
	networkTargetDNSMu.Lock()
	originalCache := networkTargetDNSCache
	originalCalls := networkTargetDNSCalls
	networkTargetDNSCache = map[string]networkTargetDNSCacheEntry{}
	networkTargetDNSCalls = map[string]*networkTargetDNSCall{}
	networkTargetDNSMu.Unlock()
	t.Cleanup(func() {
		lookupNetworkTargetIPs = originalLookup
		dialNetworkTimeout = originalDial
		networkTargetDNSMu.Lock()
		networkTargetDNSCache = originalCache
		networkTargetDNSCalls = originalCalls
		networkTargetDNSMu.Unlock()
	})

	lookupNetworkTargetIPs = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("192.0.2.1")}, {IP: net.ParseIP("192.0.2.2")}}, nil
	}
	dialCalls := 0
	dialNetworkTimeout = func(string, string, time.Duration) (net.Conn, error) {
		dialCalls++
		time.Sleep(45 * time.Millisecond)
		return nil, errors.New("expected timeout")
	}

	started := time.Now()
	_, reachable, _ := tcpLatencyResolved("deadline.example.test", 443, 40*time.Millisecond)
	if reachable {
		t.Fatal("synthetic timeout unexpectedly became reachable")
	}
	if dialCalls != 1 {
		t.Fatalf("dial attempts=%d, want 1 within the shared deadline", dialCalls)
	}
	if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
		t.Fatalf("resolved addresses exceeded the shared deadline: %s", elapsed)
	}
}

func TestRuleLatencyProbeUsesPingOnlyForUDP(t *testing.T) {
	tests := []struct {
		protocol string
		method   string
	}{
		{protocol: "udp", method: "ping"},
		{protocol: "tcp", method: "tcping"},
		{protocol: "both", method: "tcping"},
	}
	for _, tc := range tests {
		task, ok := buildRuleLatencyProbeTask(localRuleState{
			Port: "443", RuleID: 7, TargetIP: "hy2.example.com", TargetPort: 443, Protocol: tc.protocol,
		})
		if !ok {
			t.Fatalf("protocol %s did not create a probe task", tc.protocol)
		}
		if task.Method != tc.method {
			t.Fatalf("protocol %s method = %s, want %s", tc.protocol, task.Method, tc.method)
		}
	}
}

func TestRuleLatencyProbePrefersLatestDesiredProtocol(t *testing.T) {
	rememberDesiredRunningRules([]runningRule{{
		RuleID: 9, SourcePort: 8443, TargetIP: "new-hy2.example.com", TargetPort: 8443, Protocol: "udp",
	}})
	t.Cleanup(func() { rememberDesiredRunningRules(nil) })

	task, ok := buildRuleLatencyProbeTask(localRuleState{
		Port: "8443", RuleID: 9, TargetIP: "old.example.com", TargetPort: 443, Protocol: "tcp",
	})
	if !ok {
		t.Fatal("desired UDP rule did not create a probe task")
	}
	if task.Method != "ping" || task.TargetIP != "new-hy2.example.com" || task.TargetPort != 8443 {
		t.Fatalf("probe did not use desired rule metadata: %+v", task)
	}
}

func TestTunnelRuleLatencySkipsLocalEntryAndUsesExplicitExitProbe(t *testing.T) {
	if _, ok := buildRuleLatencyProbeTask(localRuleState{
		Port: "10080", RuleID: 12, TunnelID: 3, TargetIP: "target.example.com", TargetPort: 443, Protocol: "tcp",
	}); ok {
		t.Fatal("tunnel rule must not probe its final target from a local entry or relay state")
	}

	task, ok := buildExplicitRuleLatencyProbeTask(ruleLatencyProbe{
		RuleID: 12, TunnelID: 3, TargetIP: "target.example.com", TargetPort: 443,
		Method: "tcping", ProbeKey: "rule-latency", TopologyKey: "topology-v1",
	})
	if !ok {
		t.Fatal("explicit tunnel exit probe was rejected")
	}
	if task.SourcePort != 0 || task.Method != "tcping" || task.ProbeKey != "rule-latency" || task.TopologyKey != "topology-v1" {
		t.Fatalf("unexpected explicit tunnel rule probe: %+v", task)
	}
}

func TestMultiEntryWireGuardProbesKeepTheirOwnPeers(t *testing.T) {
	tasks := buildTunnelProbeTasks([]tunnelProbe{
		{
			TunnelID: 7, TargetIP: "entry-a.example.test", TargetPort: 31001,
			WireGuardPeerID: "exit-for-entry-a", ProbeKey: "entry-a",
		},
		{
			TunnelID: 7, TargetIP: "entry-b.example.test", TargetPort: 31001,
			WireGuardPeerID: "exit-for-entry-b", ProbeKey: "entry-b",
		},
	})
	if len(tasks) != 2 {
		t.Fatalf("multi-entry probe tasks=%d, want 2", len(tasks))
	}
	if tasks[0].WireGuardPeerID != "exit-for-entry-a" || tasks[0].ProbeKey != "entry-a" {
		t.Fatalf("first entry probe was overwritten: %+v", tasks[0])
	}
	if tasks[1].WireGuardPeerID != "exit-for-entry-b" || tasks[1].ProbeKey != "entry-b" {
		t.Fatalf("second entry probe was overwritten: %+v", tasks[1])
	}
}
