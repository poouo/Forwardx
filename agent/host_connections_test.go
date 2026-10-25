package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

const socketSummary4Fixture = "sockets: used 999999\nTCP: inuse 5 orphan 100 tw 7 alloc 900000 mem 123\nUDP: inuse 3 mem 456\nUDPLITE: inuse 987\nRAW: inuse 678\n"
const socketSummary6Fixture = "TCP6: inuse 2\nUDP6: inuse 4\nUDPLITE6: inuse 345\nRAW6: inuse 789\n"

func writeSocketSummaryFixture(t *testing.T, directory, name, data string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(directory, name), []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
}

func assertSocketCount(t *testing.T, count hostSocketCount, total, inUse uint64, ipv6 bool) {
	t.Helper()
	if count.Status != "ok" || count.Total == nil || *count.Total != total || count.InUse == nil || *count.InUse != inUse || count.IPv6Included != ipv6 {
		t.Fatalf("unexpected socket count: %+v", count)
	}
}

func TestHostConnectionsAggregateIPv4AndIPv6WithoutGlobalCounts(t *testing.T) {
	directory := t.TempDir()
	writeSocketSummaryFixture(t, directory, "sockstat", socketSummary4Fixture)
	writeSocketSummaryFixture(t, directory, "sockstat6", socketSummary6Fixture)
	stats := readHostConnectionStats(directory, time.Unix(1700000000, 0))
	assertSocketCount(t, stats.TCP, 14, 7, true)
	assertSocketCount(t, stats.UDP, 7, 7, true)
	if stats.TCP.TimeWait == nil || *stats.TCP.TimeWait != 7 || stats.UDP.TimeWait != nil {
		t.Fatal("TIME_WAIT must be included exactly once, and only in TCP")
	}
	if stats.Version != 1 || stats.Scope != "network-namespace" || stats.SampledAt != 1700000000 {
		t.Fatalf("invalid metadata: %+v", stats)
	}
}

func TestHostConnectionsIPv4OnlyAndHiddenIPv6Summary(t *testing.T) {
	directory := t.TempDir()
	writeSocketSummaryFixture(t, directory, "sockstat", socketSummary4Fixture)
	stats := readHostConnectionStats(directory, time.Now())
	assertSocketCount(t, stats.TCP, 12, 5, false)
	assertSocketCount(t, stats.UDP, 3, 3, false)
	writeSocketSummaryFixture(t, directory, "tcp6", "IPv6 is present but its summary is hidden")
	stats = readHostConnectionStats(directory, time.Now())
	if stats.TCP.Status != "unavailable" || stats.TCP.Reason != "ipv6-summary-missing" || stats.TCP.Total != nil {
		t.Fatalf("partial TCP total accepted: %+v", stats.TCP)
	}
	assertSocketCount(t, stats.UDP, 3, 3, false)
}

func TestHostConnectionsMissingAndInvalidAreNotZero(t *testing.T) {
	directory := t.TempDir()
	stats := readHostConnectionStats(directory, time.Now())
	if stats.TCP.Reason != "summary-missing" || stats.UDP.Reason != "summary-missing" {
		t.Fatalf("missing summary: %+v", stats)
	}
	data, _ := json.Marshal(stats)
	if strings.Contains(string(data), `"total"`) {
		t.Fatal("unavailable count serialized as zero")
	}
	writeSocketSummaryFixture(t, directory, "sockstat", "TCP: inuse 0 tw 0\nUDP: inuse 0\n")
	stats = readHostConnectionStats(directory, time.Now())
	assertSocketCount(t, stats.TCP, 0, 0, false)
	assertSocketCount(t, stats.UDP, 0, 0, false)
	data, _ = json.Marshal(stats)
	if strings.Count(string(data), `"total":0`) != 2 {
		t.Fatal("known zeros omitted")
	}
	writeSocketSummaryFixture(t, directory, "sockstat", "TCP: inuse -1 tw 0\nUDP: inuse 3\n")
	stats = readHostConnectionStats(directory, time.Now())
	if stats.TCP.Status != "unavailable" || stats.TCP.Total != nil {
		t.Fatal("negative TCP count accepted")
	}
	assertSocketCount(t, stats.UDP, 3, 3, false)
}

func TestSocketSummaryParserRejectsAmbiguousAndOverflowCounts(t *testing.T) {
	for _, raw := range []string{
		"", "TCP: tw 1", "TCP: inuse x", "TCP: inuse -1", "TCP: inuse 1 tw", "TCP: inuse 1 inuse 2",
		"TCP: inuse 1\nTCP: inuse 2", "TCP: tw 1\nTCP: inuse 2", "TCP: inuse 18446744073709551616",
	} {
		if _, err := parseSocketSummary(raw, "TCP", "inuse"); err == nil {
			t.Fatalf("invalid summary accepted: %q", raw)
		}
	}
	directory := t.TempDir()
	writeSocketSummaryFixture(t, directory, "sockstat", "TCP: inuse 18446744073709551615 tw 1\nUDP: inuse 0\n")
	stats := readHostConnectionStats(directory, time.Now())
	if stats.TCP.Status != "unavailable" {
		t.Fatal("total overflow accepted")
	}
	writeSocketSummaryFixture(t, directory, "sockstat", "TCP: inuse 18446744073709551615 tw 0\nUDP: inuse 0\n")
	writeSocketSummaryFixture(t, directory, "sockstat6", socketSummary6Fixture)
	stats = readHostConnectionStats(directory, time.Now())
	if stats.TCP.Status != "unavailable" {
		t.Fatal("IPv4+IPv6 overflow accepted")
	}
	writeSocketSummaryFixture(t, directory, "sockstat", strings.Repeat("a", 65537))
	if _, err := readSocketSummary(filepath.Join(directory, "sockstat")); err == nil {
		t.Fatal("oversized summary accepted")
	}
	if socketReadFailure(os.ErrPermission) != "permission-denied" {
		t.Fatal("permission failure not classified")
	}
}

func TestConnectionStatsCacheAndHeartbeatCompatibility(t *testing.T) {
	hostConnectionCache.Lock()
	previousStats, previousAt := hostConnectionCache.stats, hostConnectionCache.at
	sample := unavailableHostConnectionStats(time.Now(), "permission-denied")
	hostConnectionCache.stats, hostConnectionCache.at = sample, time.Now()
	hostConnectionCache.Unlock()
	defer func() {
		hostConnectionCache.Lock()
		hostConnectionCache.stats, hostConnectionCache.at = previousStats, previousAt
		hostConnectionCache.Unlock()
	}()
	if got := systemConnectionStats(); got.SampledAt != sample.SampledAt || got.TCP.Reason != "permission-denied" {
		t.Fatal("recent sample was reread instead of reused")
	}
	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(source), `payload["connectionStats"] = systemConnectionStats()`) != 2 {
		t.Fatal("normal and busy/metrics heartbeats must both include stats without changing compact metric indexes")
	}
}

func TestHostConnectionsLiveLinuxKernelSummary(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux kernel proc summaries")
	}
	stats := readHostConnectionStats("/proc/net", time.Now())
	if stats.TCP.Status != "ok" || stats.UDP.Status != "ok" {
		t.Skipf("proc summaries unavailable: %+v", stats)
	}
	if *stats.TCP.Total != *stats.TCP.InUse+*stats.TCP.TimeWait || *stats.UDP.Total != *stats.UDP.InUse {
		t.Fatal("live socket totals inconsistent")
	}
}
