package main

import (
	"reflect"
	"testing"
	"time"
)

func resetDNSWatchTestState() {
	dnsWatchMu.Lock()
	dnsWatchSnapshot = map[string][]string{}
	dnsWatchCandidates = map[string]dnsWatchCandidate{}
	dnsWatchRetiredSnapshots = map[string]dnsWatchRetiredSnapshot{}
	pendingDNSChanges = nil
	dnsWatchMu.Unlock()
}

func dnsWatchLookupSequence(values ...[]string) func(string) []string {
	index := 0
	return func(string) []string {
		if index >= len(values) {
			return nil
		}
		value := values[index]
		index++
		return append([]string(nil), value...)
	}
}

func TestDNSWatchConfirmsStableChangeBeforeReporting(t *testing.T) {
	resetDNSWatchTestState()
	defer resetDNSWatchTestState()

	items := []dnsWatchItem{{Host: "ddns.example.com", Scope: "forward-rule-target", RefID: 42}}
	lookup := dnsWatchLookupSequence(
		[]string{"192.0.2.10"},
		[]string{"192.0.2.20"},
		[]string{"192.0.2.20"},
		[]string{"192.0.2.20"},
		[]string{"192.0.2.20"},
	)

	start := time.Unix(100, 0)
	if updateDNSWatchWithLookupAt(items, lookup, start) {
		t.Fatal("initial DNS snapshot should not request an immediate refresh")
	}
	if !updateDNSWatchWithLookupAt(items, lookup, start.Add(2*time.Second)) {
		t.Fatal("first changed result should request a fast confirmation poll")
	}
	if changes := takePendingDNSChanges(); len(changes) != 0 {
		t.Fatalf("first changed result reported too early: %#v", changes)
	}
	if !updateDNSWatchWithLookupAt(items, lookup, start.Add(6*time.Second)) {
		t.Fatal("second changed result should request another fast confirmation poll")
	}
	if changes := takePendingDNSChanges(); len(changes) != 0 {
		t.Fatalf("second changed result reported too early: %#v", changes)
	}
	if !updateDNSWatchWithLookupAt(items, lookup, start.Add(8*time.Second)) {
		t.Fatal("third changed result inside the confirmation window should remain pending")
	}
	if changes := takePendingDNSChanges(); len(changes) != 0 {
		t.Fatalf("confirmation window was ignored: %#v", changes)
	}
	if !updateDNSWatchWithLookupAt(items, lookup, start.Add(12*time.Second)) {
		t.Fatal("confirmed DNS change should request a heartbeat to report it")
	}

	changes := takePendingDNSChanges()
	if len(changes) != 1 {
		t.Fatalf("confirmed DNS change reports = %d, want 1", len(changes))
	}
	if got, want := changes[0].Old, []string{"192.0.2.10"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("old IPs = %#v, want %#v", got, want)
	}
	if got, want := changes[0].New, []string{"192.0.2.20"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("new IPs = %#v, want %#v", got, want)
	}
}

func TestDNSWatchIgnoresOldAndNewAddressOscillation(t *testing.T) {
	resetDNSWatchTestState()
	defer resetDNSWatchTestState()

	items := []dnsWatchItem{{Host: "ddns.example.com", Scope: "forward-rule-target", RefID: 42}}
	lookup := dnsWatchLookupSequence(
		[]string{"192.0.2.10"},
		[]string{"192.0.2.20"},
		[]string{"192.0.2.10"},
		[]string{"192.0.2.20"},
		[]string{"192.0.2.10"},
	)

	start := time.Unix(200, 0)
	updateDNSWatchWithLookupAt(items, lookup, start)
	if !updateDNSWatchWithLookupAt(items, lookup, start.Add(2*time.Second)) {
		t.Fatal("changed result should start confirmation")
	}
	if updateDNSWatchWithLookupAt(items, lookup, start.Add(4*time.Second)) {
		t.Fatal("return to the stable address should cancel confirmation")
	}
	if !updateDNSWatchWithLookupAt(items, lookup, start.Add(6*time.Second)) {
		t.Fatal("a later changed result should start a new confirmation")
	}
	if updateDNSWatchWithLookupAt(items, lookup, start.Add(8*time.Second)) {
		t.Fatal("second return to the stable address should cancel confirmation")
	}
	if changes := takePendingDNSChanges(); len(changes) != 0 {
		t.Fatalf("oscillating DNS answers should not be reported: %#v", changes)
	}
}

func TestDNSWatchHoldsDownRecentlyRetiredAddress(t *testing.T) {
	resetDNSWatchTestState()
	defer resetDNSWatchTestState()

	items := []dnsWatchItem{{Host: "ddns.example.com", Scope: "forward-rule-target", RefID: 42}}
	lookup := dnsWatchLookupSequence(
		[]string{"192.0.2.10"},
		[]string{"192.0.2.20"},
		[]string{"192.0.2.20"},
		[]string{"192.0.2.20"},
		[]string{"192.0.2.10"},
		[]string{"192.0.2.10"},
	)

	start := time.Unix(250, 0)
	updateDNSWatchWithLookupAt(items, lookup, start)
	updateDNSWatchWithLookupAt(items, lookup, start.Add(2*time.Second))
	updateDNSWatchWithLookupAt(items, lookup, start.Add(6*time.Second))
	updateDNSWatchWithLookupAt(items, lookup, start.Add(12*time.Second))
	if changes := takePendingDNSChanges(); len(changes) != 1 {
		t.Fatalf("initial confirmed change reports = %d, want 1", len(changes))
	}

	if updateDNSWatchWithLookupAt(items, lookup, start.Add(30*time.Second)) {
		t.Fatal("recently retired address should be ignored without fast polling")
	}
	if changes := takePendingDNSChanges(); len(changes) != 0 {
		t.Fatalf("retired address was reported during hold-down: %#v", changes)
	}
	if !updateDNSWatchWithLookupAt(items, lookup, start.Add(dnsRollbackHoldDown+13*time.Second)) {
		t.Fatal("retired address should become eligible after hold-down")
	}
	if changes := takePendingDNSChanges(); len(changes) != 0 {
		t.Fatalf("expired retired address should still require confirmation: %#v", changes)
	}
}

func TestDNSWatchResolutionFailureResetsCandidate(t *testing.T) {
	resetDNSWatchTestState()
	defer resetDNSWatchTestState()

	items := []dnsWatchItem{{Host: "ddns.example.com", Scope: "forward-rule-target", RefID: 42}}
	lookup := dnsWatchLookupSequence(
		[]string{"192.0.2.10"},
		[]string{"192.0.2.20"},
		nil,
		[]string{"192.0.2.20"},
		[]string{"192.0.2.20"},
	)

	start := time.Unix(300, 0)
	updateDNSWatchWithLookupAt(items, lookup, start)
	updateDNSWatchWithLookupAt(items, lookup, start.Add(2*time.Second))
	if updateDNSWatchWithLookupAt(items, lookup, start.Add(4*time.Second)) {
		t.Fatal("failed lookup should stop fast confirmation polling")
	}
	if !updateDNSWatchWithLookupAt(items, lookup, start.Add(6*time.Second)) {
		t.Fatal("changed result after a failure should restart confirmation")
	}
	if !updateDNSWatchWithLookupAt(items, lookup, start.Add(12*time.Second)) {
		t.Fatal("second changed result after a failure should remain pending")
	}
	if changes := takePendingDNSChanges(); len(changes) != 0 {
		t.Fatalf("change should require three consecutive successful answers: %#v", changes)
	}
}
