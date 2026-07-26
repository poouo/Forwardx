package main

import (
	"strings"
	"testing"
	"time"
)

func TestActionSerialKeysScopeConflicts(t *testing.T) {
	ruleKeys := strings.Join(actionSerialKeys(action{RuleID: 42, TunnelID: 7, SourcePort: 24080}), ",")
	if ruleKeys != "port:24080,rule:42" {
		t.Fatalf("unexpected rule action keys: %s", ruleKeys)
	}
	tunnelKeys := strings.Join(actionSerialKeys(action{StatusType: "tunnel", TunnelID: 7, SourcePort: 24443}), ",")
	if tunnelKeys != "port:24443,tunnel:7" {
		t.Fatalf("unexpected tunnel action keys: %s", tunnelKeys)
	}
	runtimeKeys := strings.Join(actionSerialKeys(action{StatusType: "runtime", ForwardType: "gost-runtime-sync"}), ",")
	if runtimeKeys != "runtime:gost-runtime-sync" {
		t.Fatalf("unexpected runtime action keys: %s", runtimeKeys)
	}
}

func TestActionSerialLocksOnlyBlockSharedResources(t *testing.T) {
	firstUnlock := acquireActionSerialLocks(actionSerialKeys(action{RuleID: 900001, SourcePort: 41001}))
	if firstUnlock == nil {
		t.Fatal("expected first action lock")
	}

	tryAcquire := func(a action) <-chan struct{} {
		acquired := make(chan struct{})
		go func() {
			unlock := acquireActionSerialLocks(actionSerialKeys(a))
			close(acquired)
			if unlock != nil {
				unlock()
			}
		}()
		return acquired
	}

	sameRule := tryAcquire(action{RuleID: 900001, SourcePort: 41002})
	samePort := tryAcquire(action{RuleID: 900002, SourcePort: 41001})
	independent := tryAcquire(action{RuleID: 900003, SourcePort: 41003})

	select {
	case <-independent:
	case <-time.After(time.Second):
		firstUnlock()
		t.Fatal("independent action was unexpectedly serialized")
	}
	for name, acquired := range map[string]<-chan struct{}{"same rule": sameRule, "same port": samePort} {
		select {
		case <-acquired:
			firstUnlock()
			t.Fatalf("%s action bypassed the shared resource lock", name)
		case <-time.After(30 * time.Millisecond):
		}
	}

	firstUnlock()
	for name, acquired := range map[string]<-chan struct{}{"same rule": sameRule, "same port": samePort} {
		select {
		case <-acquired:
		case <-time.After(time.Second):
			t.Fatalf("%s action did not resume after releasing the lock", name)
		}
	}
}

func TestAcquireCurrentActionSerialLocksRejectsActionMadeStaleWhileWaiting(t *testing.T) {
	actionEpochMu.Lock()
	previousIssuedAt := latestActionIssuedAt
	latestActionIssuedAt = map[string]int64{}
	actionEpochMu.Unlock()
	t.Cleanup(func() {
		actionEpochMu.Lock()
		latestActionIssuedAt = previousIssuedAt
		actionEpochMu.Unlock()
	})

	older := action{
		StatusType:  "runtime",
		ForwardType: "mimic-runtime-sync",
		Op:          "apply",
		IssuedAt:    100,
		Commands:    []string{"disable-mimic"},
	}
	if isOlderAction(older, true) {
		t.Fatal("initial Mimic action unexpectedly stale")
	}

	releaseBlocker := acquireActionSerialLocks(actionSerialKeys(older))
	if releaseBlocker == nil {
		t.Fatal("expected Mimic runtime serial lock")
	}
	blockerReleased := false
	t.Cleanup(func() {
		if !blockerReleased {
			releaseBlocker()
		}
	})

	started := make(chan struct{})
	currentResult := make(chan bool, 1)
	go func() {
		close(started)
		unlock, current := acquireCurrentActionSerialLocks(older)
		if unlock != nil {
			unlock()
		}
		currentResult <- current
	}()
	<-started
	select {
	case <-currentResult:
		t.Fatal("older Mimic action bypassed the held serial lock")
	case <-time.After(30 * time.Millisecond):
	}

	newer := older
	newer.IssuedAt = 200
	newer.Commands = []string{"enable-mimic"}
	if isOlderAction(newer, true) {
		t.Fatal("newer Mimic action unexpectedly stale")
	}

	releaseBlocker()
	blockerReleased = true
	select {
	case current := <-currentResult:
		if current {
			t.Fatal("older Mimic action remained executable after a newer action arrived while it waited")
		}
	case <-time.After(time.Second):
		t.Fatal("waiting Mimic action did not resume after releasing the serial lock")
	}
}
