package main

import (
	"strings"
	"testing"
	"time"
)

func TestSourceAnalyticsOnlyOriginalLocalIngressAndByteDeltas(t *testing.T) {
	sampler := sourceAnalyticsSampler{}
	states := []localRuleState{{Port: "10000", RuleID: 5, ForwardType: "gost", Protocol: "tcp"}}
	local := map[string]bool{"192.0.2.1": true}
	now := time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)
	line := "ipv4 2 tcp 6 100 ESTABLISHED src=203.0.113.7 dst=192.0.2.1 sport=50000 dport=10000 packets=1 bytes=100 src=198.51.100.1 dst=203.0.113.7 sport=443 dport=50000 packets=1 bytes=200"
	// Outgoing traffic/reply tuples must not masquerade as a visitor.
	wrong := "tcp 6 100 ESTABLISHED src=192.0.2.1 dst=198.51.100.1 sport=50000 dport=10000 bytes=900 src=198.51.100.1 dst=192.0.2.1 sport=443 dport=10000 bytes=900"
	rows, status := sampler.scan(strings.NewReader(line+"\n"+wrong), states, local, now)
	if status != "sampled" || len(rows) != 1 || rows[0]["ip"] != "203.0.113.7" || rows[0]["bytesIn"].(uint64) != 0 {
		t.Fatalf("first snapshot=%v %s", rows, status)
	}
	updated := strings.ReplaceAll(strings.ReplaceAll(line, "bytes=100", "bytes=150"), "bytes=200", "bytes=300")
	rows, _ = sampler.scan(strings.NewReader(updated), states, local, now.Add(time.Minute))
	if rows[0]["bytesIn"].(uint64) != 50 || rows[0]["bytesOut"].(uint64) != 100 || !rows[0]["accounting"].(bool) {
		t.Fatalf("delta=%v", rows)
	}
	rows, _ = sampler.scan(strings.NewReader(line), states, local, now.Add(2*time.Minute))
	if rows[0]["bytesIn"].(uint64) != 0 || rows[0]["bytesOut"].(uint64) != 0 {
		t.Fatalf("reset=%v", rows)
	}
}

func TestSourceAnalyticsMissingAccountingAndCaps(t *testing.T) {
	sampler := sourceAnalyticsSampler{}
	states := []localRuleState{{Port: "10000", RuleID: 5, ForwardType: "realm", Protocol: "tcp"}}
	line := "tcp 6 src=::ffff:203.0.113.7 dst=192.0.2.1 sport=50000 dport=10000 src=192.0.2.1 dst=203.0.113.7 sport=10000 dport=50000"
	rows, _ := sampler.scan(strings.NewReader(line), states, map[string]bool{"192.0.2.1": true}, time.Now())
	if len(rows) != 1 || rows[0]["accounting"].(bool) || rows[0]["ip"] != "203.0.113.7" {
		t.Fatalf("missing accounting=%v", rows)
	}
	sampler.seen = map[string]bool{}
	for i := 0; i < 5000; i++ {
		sampler.seen[string(rune(i))] = true
	}
	rows, status := sampler.scan(strings.NewReader(line), states, map[string]bool{"192.0.2.1": true}, time.Now())
	if len(rows) != 0 || status != "limited" {
		t.Fatalf("daily cap=%v %s", rows, status)
	}
}

func TestSourceAnalyticsPolicyAndDisabledReset(t *testing.T) {
	previous := sourceAnalyticsEnabled.Load()
	defer sourceAnalyticsEnabled.Store(previous)
	updateSourceAnalyticsPolicy(map[string]any{"sourceAnalyticsEnabled": false})
	rows, status := collectSourceAnalytics(nil)
	if len(rows) != 0 || status != "disabled" {
		t.Fatal(status)
	}
	updateSourceAnalyticsPolicy(map[string]any{"sourceAnalyticsEnabled": true})
	if !sourceAnalyticsEnabled.Load() {
		t.Fatal("policy not applied")
	}
}
