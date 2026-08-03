package main

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

func isolateCountingStateTest(t *testing.T, bootID string) {
	t.Helper()
	previousStateDir := trafficStateDir
	previousBootID := agentBootID
	previousSignatures := countingChainSignatures
	previousCheckedAt := countingChainCheckedAt
	previousPending := countingChainRepairPending
	previousCleanup := countingChainRepairCleanup
	previousQueue := countingChainRepairQueue
	previousDesiredByPort := desiredRunningRulesByPort
	previousDesiredByRulePort := desiredRunningRulesByRulePort
	freshProcessConnMu.Lock()
	previousFreshProcessConnRule := freshProcessConnRule
	freshProcessConnRule = map[string]int{}
	freshProcessConnMu.Unlock()

	trafficStateDir = t.TempDir()
	agentBootID = bootID
	countingChainSignatures = map[string]string{}
	countingChainCheckedAt = map[string]time.Time{}
	countingChainRepairPending = map[string]bool{}
	countingChainRepairCleanup = map[string]bool{}
	countingChainRepairQueue = make(chan runningRule, 4)
	// Keep this test synchronous. The queueing assertion below must not start
	// a background worker that can outlive the temporary global test state.
	countingChainRepairWorkersOnce.Do(func() {})
	desiredRunningRulesByPort = map[string]runningRule{}
	desiredRunningRulesByRulePort = map[string]runningRule{}

	t.Cleanup(func() {
		trafficStateDir = previousStateDir
		agentBootID = previousBootID
		countingChainSignatures = previousSignatures
		countingChainCheckedAt = previousCheckedAt
		countingChainRepairPending = previousPending
		countingChainRepairCleanup = previousCleanup
		countingChainRepairQueue = previousQueue
		desiredRunningRulesByPort = previousDesiredByPort
		desiredRunningRulesByRulePort = previousDesiredByRulePort
		freshProcessConnMu.Lock()
		freshProcessConnRule = previousFreshProcessConnRule
		freshProcessConnMu.Unlock()
	})
}

func TestCountingChainStateRestoresOnlyWithinTheSameSystemBoot(t *testing.T) {
	isolateCountingStateTest(t, "boot-a")
	rule := runningRule{
		RuleID:      71,
		SourcePort:  22022,
		TargetIP:    "203.0.113.10",
		TargetPort:  443,
		Protocol:    "tcp",
		ForwardType: "gost",
	}
	rememberDesiredRunningRules([]runningRule{rule})
	signature := countingChainRuleSignature(rule)
	countingChainSignatures["22022"] = signature
	countingChainRepairPending["22022"] = true

	finishCountingChainRepair(rule, true)
	raw, err := os.ReadFile(countingChainStatePath("22022"))
	if err != nil {
		t.Fatalf("read persisted counting state: %v", err)
	}
	var persisted persistedCountingChainState
	if err := json.Unmarshal(raw, &persisted); err != nil {
		t.Fatalf("decode persisted counting state: %v", err)
	}
	if persisted.BootID != "boot-a" || persisted.Signature != signature || persisted.CheckedAt <= 0 {
		t.Fatalf("unexpected persisted counting state: %+v", persisted)
	}

	countingChainSignatures = map[string]string{}
	countingChainCheckedAt = map[string]time.Time{}
	restoreCountingChainStates("boot-a")
	if countingChainSignatures["22022"] != signature || !countingChainCheckedAt["22022"].IsZero() {
		t.Fatalf("same-boot state was not restored: signature=%q checkedAt=%s", countingChainSignatures["22022"], countingChainCheckedAt["22022"])
	}
	ensureCountingChainsIfNeeded(rule)
	if got := len(countingChainRepairQueue); got != 1 {
		t.Fatalf("same-boot Agent restart queued %d repairs, want one verification", got)
	}
	if countingChainRepairCleanup["22022"] {
		t.Fatal("same-layout Agent upgrade would clear existing traffic counters")
	}

	restoreCountingChainStates("boot-b")
	if len(countingChainSignatures) != 0 || len(countingChainCheckedAt) != 0 {
		t.Fatalf("state from an earlier system boot was restored: signatures=%v checked=%v", countingChainSignatures, countingChainCheckedAt)
	}
	if _, err := os.Stat(countingChainStatePath("22022")); !os.IsNotExist(err) {
		t.Fatalf("stale boot state file was not removed: %v", err)
	}
}

func TestCountingChainStateInvalidationDoesNotDisruptPendingRepair(t *testing.T) {
	isolateCountingStateTest(t, "boot-a")
	rule := runningRule{RuleID: 72, SourcePort: 22023, Protocol: "udp", ForwardType: "realm"}
	signature := countingChainRuleSignature(rule)
	countingChainSignatures["22023"] = signature
	countingChainCheckedAt["22023"] = time.Now()
	if err := writeTrafficStateFile(countingChainStatePath("22023"), []byte(`{"schema":1,"bootId":"boot-a","signature":"`+signature+`","checkedAt":1}`), 0600); err != nil {
		t.Fatalf("write counting state fixture: %v", err)
	}

	if !invalidateCountingChainState("22023") {
		t.Fatal("missing layout did not invalidate a completed counting state")
	}
	if countingChainSignatures["22023"] != signature {
		t.Fatal("missing layout invalidation lost the known counting signature")
	}
	if !countingChainCheckedAt["22023"].IsZero() {
		t.Fatal("missing layout invalidation retained the completed check timestamp")
	}
	if _, err := os.Stat(countingChainStatePath("22023")); !os.IsNotExist(err) {
		t.Fatalf("invalidated counting state remained persisted: %v", err)
	}

	countingChainRepairPending["22023"] = true
	if invalidateCountingChainState("22023") {
		t.Fatal("an in-flight repair was invalidated a second time")
	}
	if countingChainSignatures["22023"] != signature {
		t.Fatal("in-flight repair lost ownership of its signature")
	}
}
