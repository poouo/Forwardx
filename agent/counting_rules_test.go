package main

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

func countingAddCommands(commands []string) []string {
	adds := make([]string, 0, len(commands))
	for _, command := range commands {
		if strings.Contains(command, " -A ") || strings.Contains(command, "nft add rule") {
			adds = append(adds, command)
		}
	}
	return adds
}

func TestCountingRuleModesSeparateSelfReportedNativeAndAgentCounters(t *testing.T) {
	forwardX := fmt.Sprint(countingRuleModeForForwardType(" ForwardX "))
	nativeNft := fmt.Sprint(countingRuleModeForForwardType("NFTABLES"))
	kernelDNAT := fmt.Sprint(countingRuleModeForForwardType("iptables"))
	process := fmt.Sprint(countingRuleModeForForwardType("gost"))

	for name, mode := range map[string]string{
		"forwardx": forwardX,
		"nftables": nativeNft,
		"iptables": kernelDNAT,
		"process":  process,
	} {
		if strings.TrimSpace(mode) == "" {
			t.Fatalf("%s counting mode is empty", name)
		}
	}
	if forwardX == process || nativeNft == process || kernelDNAT == process {
		t.Fatalf("counting modes collapse incompatible layouts: forwardx=%q nftables=%q iptables=%q process=%q", forwardX, nativeNft, kernelDNAT, process)
	}
	if fmt.Sprint(countingRuleModeForForwardType("realm")) != process ||
		fmt.Sprint(countingRuleModeForForwardType("socat")) != process ||
		fmt.Sprint(countingRuleModeForForwardType("nginx")) != process ||
		fmt.Sprint(countingRuleModeForForwardType("guard")) != process {
		t.Fatalf("process forwarders must share the listener counting layout, got gost=%q realm=%q socat=%q nginx=%q guard=%q",
			process,
			fmt.Sprint(countingRuleModeForForwardType("realm")),
			fmt.Sprint(countingRuleModeForForwardType("socat")),
			fmt.Sprint(countingRuleModeForForwardType("nginx")),
			fmt.Sprint(countingRuleModeForForwardType("guard")),
		)
	}
}

func TestSelfReportedAndNativeRulesDoNotInstallFWXStatCounters(t *testing.T) {
	for _, forwardType := range []string{"forwardx", "nftables"} {
		t.Run(forwardType, func(t *testing.T) {
			rule := runningRule{
				RuleID:      41,
				SourcePort:  22022,
				TargetIP:    "203.0.113.10",
				TargetPort:  443,
				Protocol:    "both",
				ForwardType: forwardType,
			}
			if adds := countingAddCommands(countingRuleInstallCmds(rule)); len(adds) != 0 {
				t.Fatalf("%s must not install fwx-stat rules; additions:\n%s", forwardType, strings.Join(adds, "\n"))
			}
		})
	}
}

func TestIptablesDNATCountersUseOnlyConntrackScopedForwardHooks(t *testing.T) {
	rule := runningRule{
		RuleID:      42,
		SourcePort:  22022,
		TargetIP:    "203.0.113.10",
		TargetPort:  443,
		Protocol:    "both",
		ForwardType: "iptables",
	}
	adds := countingAddCommands(countingRuleInstallCmds(rule))
	joined := strings.Join(adds, "\n")

	for _, proto := range []string{"tcp", "udp"} {
		for _, want := range []string{
			"FORWARD -p " + proto + " -m conntrack --ctorigdstport 22022 -d 203.0.113.10 --dport 443",
			"FORWARD -p " + proto + " -m conntrack --ctorigdstport 22022 -s 203.0.113.10 --sport 443",
		} {
			if !strings.Contains(joined, want) {
				t.Fatalf("iptables DNAT additions missing %q:\n%s", want, joined)
			}
		}
	}
	for _, forbiddenHook := range []string{"PREROUTING", "INPUT", "OUTPUT", "POSTROUTING"} {
		if strings.Contains(joined, forbiddenHook) {
			t.Fatalf("iptables DNAT installed redundant %s counter hook:\n%s", forbiddenHook, joined)
		}
	}
	if strings.Contains(joined, "nft add rule") {
		t.Fatalf("iptables DNAT installed a second nft counting backend:\n%s", joined)
	}
	if len(adds) > 4 {
		t.Fatalf("iptables DNAT installed %d rules for both protocols, want at most 4:\n%s", len(adds), joined)
	}
}

func TestIptablesDNATCountersKeepListenersSeparateForSharedTarget(t *testing.T) {
	commandsForPort := func(port int) string {
		return strings.Join(countingAddCommands(countingRuleInstallCmds(runningRule{
			RuleID:      port,
			SourcePort:  port,
			TargetIP:    "192.0.2.10",
			TargetPort:  8080,
			Protocol:    "tcp",
			ForwardType: "iptables",
		})), "\n")
	}
	first := commandsForPort(22022)
	second := commandsForPort(22023)
	if !strings.Contains(first, "--ctorigdstport 22022") || strings.Contains(first, "--ctorigdstport 22023") {
		t.Fatalf("first listener lost its conntrack identity:\n%s", first)
	}
	if !strings.Contains(second, "--ctorigdstport 22023") || strings.Contains(second, "--ctorigdstport 22022") {
		t.Fatalf("second listener lost its conntrack identity:\n%s", second)
	}
}

func TestIptablesDNATIPv6CountersUseOnlyIp6tables(t *testing.T) {
	adds := countingAddCommands(countingRuleInstallCmds(runningRule{
		RuleID:      43,
		SourcePort:  22022,
		TargetIP:    "2001:db8::10",
		TargetPort:  443,
		Protocol:    "tcp",
		ForwardType: "iptables",
	}))
	joined := strings.Join(adds, "\n")
	if !strings.Contains(joined, "ip6tables") || !strings.Contains(joined, "--ctorigdstport 22022") {
		t.Fatalf("IPv6 DNAT counter is not scoped through ip6tables conntrack:\n%s", joined)
	}
	for _, command := range adds {
		if strings.Contains(command, "iptables ") && !strings.Contains(command, "ip6tables ") {
			t.Fatalf("IPv6 DNAT installed an IPv4 counter:\n%s", command)
		}
	}
}

func TestProcessCountersInstallOnlyInputAndOutputHooks(t *testing.T) {
	for _, forwardType := range []string{"gost", "realm", "socat", "nginx"} {
		t.Run(forwardType, func(t *testing.T) {
			adds := countingAddCommands(countingRuleInstallCmds(runningRule{
				RuleID:      50,
				SourcePort:  22022,
				TargetIP:    "203.0.113.10",
				TargetPort:  443,
				Protocol:    "both",
				ForwardType: forwardType,
			}))
			joined := strings.Join(adds, "\n")
			for _, proto := range []string{"tcp", "udp"} {
				if !strings.Contains(joined, "input meta l4proto "+proto+" "+proto+" dport 22022") {
					t.Fatalf("%s missing %s listener input counter:\n%s", forwardType, proto, joined)
				}
				if !strings.Contains(joined, "output meta l4proto "+proto+" "+proto+" sport 22022") {
					t.Fatalf("%s missing %s listener output counter:\n%s", forwardType, proto, joined)
				}
				if !strings.Contains(joined, proto+" dport 22022 ct state new") || !strings.Contains(joined, "fwx-stat-22022:conn") {
					t.Fatalf("%s missing %s persistent connection counter:\n%s", forwardType, proto, joined)
				}
			}
			for _, forbiddenHook := range []string{"PREROUTING", "FORWARD", "POSTROUTING", "forward meta l4proto"} {
				if strings.Contains(joined, forbiddenHook) {
					t.Fatalf("%s installed redundant %s counter hook:\n%s", forwardType, forbiddenHook, joined)
				}
			}
			if len(adds) > 8 {
				t.Fatalf("%s installed %d rules for both protocols, want at most 8:\n%s", forwardType, len(adds), joined)
			}
		})
	}
}

func TestProcessCounterRepairChecksEveryProtocolSeparately(t *testing.T) {
	commands := strings.Join(nftProcessCountingEnsureCmds(22022, "both"), "\n")
	for _, want := range []string{
		"grep -F 'tcp dport 22022'",
		"grep -F 'tcp sport 22022'",
		"grep -F 'udp dport 22022'",
		"grep -F 'udp sport 22022'",
		"grep -F 'fwx-stat-22022:conn'",
		"grep -F 'ct state new'",
		"grep -F 'ct status != confirmed'",
	} {
		if !strings.Contains(commands, want) {
			t.Fatalf("non-destructive repair does not distinguish %q:\n%s", want, commands)
		}
	}
}

func TestAccessLimitMaintenanceExtractsOnlyAuxiliaryCommandsAndThrottles(t *testing.T) {
	a := action{
		Op:         "apply",
		StatusType: "rule",
		RuleID:     42,
		SourcePort: 22022,
		Commands: []string{
			"systemctl restart forwardx-rule-42",
			"iptables -A FWX_LIMIT_u7_t3 -p tcp -m connlimit --connlimit-above 100 --connlimit-mask 0 -j REJECT --reject-with tcp-reset; true",
			"iptables -A FWX_LIMIT_u7_t3 -j RETURN; true",
		},
		PostCommands: []string{
			"iptables -C INPUT -p tcp --dport 22022 -j FWX_LIMIT_u7_t3; true",
		},
	}
	commands := accessLimitCommands(a)
	if len(commands) != 3 {
		t.Fatalf("auxiliary command count=%d want=3: %v", len(commands), commands)
	}
	if !hasConfiguredAccessLimits(a) {
		t.Fatal("configured connlimit rules were not selected for maintenance")
	}
	cleanupOnly := a
	cleanupOnly.Commands = []string{"iptables -C INPUT -p tcp --dport 22022 -j FWX_LIMIT_u7_t3; true"}
	cleanupOnly.PostCommands = nil
	if hasConfiguredAccessLimits(cleanupOnly) {
		t.Fatal("cleanup-only action was mistaken for a configured access limit")
	}
	if !needsAccessLimitMaintenance(cleanupOnly) {
		t.Fatal("cleanup-only action would leave a stale access-limit jump behind")
	}
	for _, command := range commands {
		if strings.Contains(command, "systemctl") || !strings.Contains(command, "FWX_LIMIT_") {
			t.Fatalf("maintenance included a disruptive command: %q", command)
		}
	}

	accessLimitMaintenanceMu.Lock()
	previous := accessLimitMaintenanceLast
	accessLimitMaintenanceLast = map[string]time.Time{}
	accessLimitMaintenanceMu.Unlock()
	t.Cleanup(func() {
		accessLimitMaintenanceMu.Lock()
		accessLimitMaintenanceLast = previous
		accessLimitMaintenanceMu.Unlock()
	})
	now := time.Unix(1_800_000_000, 0)
	if !claimAccessLimitMaintenance(a, now) {
		t.Fatal("first maintenance pass was unexpectedly throttled")
	}
	if claimAccessLimitMaintenance(a, now.Add(accessLimitMaintenanceInterval-time.Second)) {
		t.Fatal("maintenance repeated before its cooldown elapsed")
	}
	if !claimAccessLimitMaintenance(a, now.Add(accessLimitMaintenanceInterval)) {
		t.Fatal("maintenance remained throttled after its cooldown elapsed")
	}
}

func accessLimitMaintenanceTestAction(ruleID, port int, issuedAt int64, chain string) action {
	return action{
		Op:          "apply",
		StatusType:  "rule",
		RuleID:      ruleID,
		SourcePort:  port,
		Protocol:    "tcp",
		ForwardType: "gost",
		IssuedAt:    issuedAt,
		Commands: []string{
			"iptables -F " + chain + "; true",
			"iptables -A " + chain + " -p tcp -m connlimit --connlimit-above 100 --connlimit-mask 0 -j REJECT --reject-with tcp-reset; true",
			"iptables -A " + chain + " -j RETURN; true",
			fmt.Sprintf("iptables -C INPUT -p tcp --dport %d -j %s; true", port, chain),
		},
	}
}

func isolateAccessLimitMaintenanceState(t *testing.T) {
	t.Helper()
	accessLimitMaintenanceMu.Lock()
	previousMaintenance := accessLimitMaintenanceLast
	accessLimitMaintenanceLast = map[string]time.Time{}
	accessLimitMaintenanceMu.Unlock()

	desiredActionRecordMu.Lock()
	previousRecords := desiredActionRecordsMem
	previousLoaded := desiredActionRecordsLoaded
	desiredActionRecordsMem = map[string]desiredActionRecord{}
	desiredActionRecordsLoaded = true
	desiredActionRecordMu.Unlock()

	actionEpochMu.Lock()
	previousIssuedAt := latestActionIssuedAt
	latestActionIssuedAt = map[string]int64{}
	actionEpochMu.Unlock()

	t.Cleanup(func() {
		accessLimitMaintenanceMu.Lock()
		accessLimitMaintenanceLast = previousMaintenance
		accessLimitMaintenanceMu.Unlock()
		desiredActionRecordMu.Lock()
		desiredActionRecordsMem = previousRecords
		desiredActionRecordsLoaded = previousLoaded
		desiredActionRecordMu.Unlock()
		actionEpochMu.Lock()
		latestActionIssuedAt = previousIssuedAt
		actionEpochMu.Unlock()
	})
}

func setCurrentDesiredActionRecordForMaintenanceTest(a action) {
	desiredActionRecordMu.Lock()
	desiredActionRecordsMem[desiredActionKey(a)] = newDesiredActionRecord(desiredActionSignature(a), true)
	desiredActionRecordMu.Unlock()
}

func TestAccessLimitMaintenanceWaitsForActionsSharingTheSameChain(t *testing.T) {
	isolateAccessLimitMaintenanceState(t)
	chain := "FWX_LIMIT_u7_t3"
	inFlight := accessLimitMaintenanceTestAction(41, 22021, 100, chain)
	maintenance := accessLimitMaintenanceTestAction(42, 22022, 100, chain)
	setCurrentDesiredActionRecordForMaintenanceTest(maintenance)

	unlockInFlight := acquireActionSerialLocks(actionSerialKeys(inFlight))
	if unlockInFlight == nil {
		t.Fatal("in-flight access-limit action did not acquire serial locks")
	}
	type result struct {
		attempted bool
		ok        bool
	}
	resultCh := make(chan result, 1)
	runCalled := make(chan struct{}, 1)
	go func() {
		installed := false
		attempted, ok := maintainAccessLimitAction(
			maintenance,
			time.Unix(1_800_000_000, 0),
			func(action) bool { return installed },
			func([]string) bool {
				installed = true
				runCalled <- struct{}{}
				return true
			},
		)
		resultCh <- result{attempted: attempted, ok: ok}
	}()

	select {
	case <-runCalled:
		unlockInFlight()
		t.Fatal("maintenance interleaved with an in-flight action on the same FWX_LIMIT chain")
	case <-time.After(50 * time.Millisecond):
	}
	unlockInFlight()

	select {
	case got := <-resultCh:
		if !got.attempted || !got.ok {
			t.Fatalf("serialized maintenance result=%+v want attempted and ready", got)
		}
	case <-time.After(time.Second):
		t.Fatal("maintenance did not resume after the in-flight action completed")
	}
}

func TestAccessLimitMaintenanceRunsCleanupForCurrentDesiredAction(t *testing.T) {
	isolateAccessLimitMaintenanceState(t)
	a := accessLimitMaintenanceTestAction(42, 22022, 0, "FWX_LIMIT_u7_t3")
	a.Commands = []string{
		"while iptables -C INPUT -p tcp --dport 22022 -j FWX_LIMIT_u7_t3 2>/dev/null; do iptables -D INPUT -p tcp --dport 22022 -j FWX_LIMIT_u7_t3; done; true",
	}
	if hasConfiguredAccessLimits(a) || !needsAccessLimitMaintenance(a) {
		t.Fatal("cleanup-only desired action was not selected exclusively for maintenance")
	}
	setCurrentDesiredActionRecordForMaintenanceTest(a)
	cleaned := false
	attempted, ok := maintainAccessLimitAction(
		a,
		time.Unix(1_800_000_000, 0),
		func(action) bool { return cleaned },
		func(commands []string) bool {
			cleaned = len(commands) == 1
			return cleaned
		},
	)
	if !attempted || !ok || !cleaned {
		t.Fatalf("cleanup maintenance attempted=%v ok=%v cleaned=%v", attempted, ok, cleaned)
	}
}

func TestAccessLimitMaintenanceSkipsSupersededDesiredActions(t *testing.T) {
	t.Run("newer removal", func(t *testing.T) {
		isolateAccessLimitMaintenanceState(t)
		old := accessLimitMaintenanceTestAction(42, 22022, 100, "FWX_LIMIT_u7_t3")
		setCurrentDesiredActionRecordForMaintenanceTest(old)
		remove := old
		remove.Op = "remove"
		remove.IssuedAt = 101
		if isOlderAction(remove, true) {
			t.Fatal("newer removal was unexpectedly considered stale")
		}
		runs := 0
		attempted, ok := maintainAccessLimitAction(old, time.Unix(1_800_000_000, 0), func(action) bool { return false }, func([]string) bool {
			runs++
			return true
		})
		if attempted || !ok || runs != 0 {
			t.Fatalf("superseded maintenance attempted=%v ok=%v runs=%d", attempted, ok, runs)
		}
	})

	t.Run("changed desired signature", func(t *testing.T) {
		isolateAccessLimitMaintenanceState(t)
		old := accessLimitMaintenanceTestAction(42, 22022, 0, "FWX_LIMIT_u7_t3")
		changed := old
		changed.Commands = append([]string(nil), old.Commands...)
		changed.Commands[1] = strings.Replace(changed.Commands[1], "--connlimit-above 100", "--connlimit-above 200", 1)
		setCurrentDesiredActionRecordForMaintenanceTest(changed)
		runs := 0
		attempted, ok := maintainAccessLimitAction(old, time.Unix(1_800_000_000, 0), func(action) bool { return false }, func([]string) bool {
			runs++
			return true
		})
		if attempted || !ok || runs != 0 {
			t.Fatalf("outdated signature maintenance attempted=%v ok=%v runs=%d", attempted, ok, runs)
		}
	})
}

func TestProcessIptablesFallbackUsesOnlyListenerHooks(t *testing.T) {
	commands := strings.Join(countingAddCommands(iptablesProcessCountingCmds(22022, "both")), "\n")
	for _, proto := range []string{"tcp", "udp"} {
		if !strings.Contains(commands, "INPUT -p "+proto+" --dport 22022") {
			t.Fatalf("iptables fallback missing %s input listener counter:\n%s", proto, commands)
		}
		if !strings.Contains(commands, "OUTPUT -p "+proto+" --sport 22022") {
			t.Fatalf("iptables fallback missing %s output listener counter:\n%s", proto, commands)
		}
		if !strings.Contains(commands, "INPUT -p "+proto+" --dport 22022 -m conntrack --ctstate NEW") || !strings.Contains(commands, "fwx-stat-22022:conn") {
			t.Fatalf("iptables fallback missing %s persistent connection counter:\n%s", proto, commands)
		}
	}
	for _, forbiddenHook := range []string{"PREROUTING", "FORWARD", "POSTROUTING"} {
		if strings.Contains(commands, forbiddenHook) {
			t.Fatalf("iptables fallback installed redundant %s hook:\n%s", forbiddenHook, commands)
		}
	}
	if !strings.Contains(commands, "ip6tables") || !strings.Contains(commands, "iptables") {
		t.Fatalf("iptables fallback must cover IPv4 and IPv6 listeners:\n%s", commands)
	}
}

func TestIptablesCountingCleanupUsesBusyBoxCompatibleSingleScan(t *testing.T) {
	commands := []string{
		iptablesAgentDeleteByComment("iptables", "mangle", "fwx-stat-22:"),
		iptablesAgentDeleteCountingRules("iptables", "22"),
		iptablesAgentDeleteCountingRules("ip6tables", "22"),
	}
	for _, command := range commands {
		if strings.Contains(command, "xargs") {
			t.Fatalf("cleanup depends on a non-portable xargs option:\n%s", command)
		}
		for _, want := range []string{
			"position[chain]++",
			"for (i=count; i>=1; i--)",
			`-D "$chain" "$number"`,
		} {
			if !strings.Contains(command, want) {
				t.Fatalf("single-scan reverse cleanup missing %q:\n%s", want, command)
			}
		}
	}
	countingCleanup := commands[1]
	if !strings.Contains(countingCleanup, "$i==in_chain || $i==out_chain") {
		t.Fatalf("legacy chain cleanup no longer uses exact AWK field matching:\n%s", countingCleanup)
	}
	if strings.Contains(countingCleanup, "FWX_IN_220") || strings.Contains(countingCleanup, "fwx-stat-220:") {
		t.Fatalf("port 22 cleanup leaked into port 220 markers:\n%s", countingCleanup)
	}
}

func TestCountingChainSignatureIncludesLayoutAndForwardType(t *testing.T) {
	base := runningRule{
		RuleID:      60,
		SourcePort:  22022,
		TargetIP:    "203.0.113.10",
		TargetPort:  443,
		Protocol:    "tcp",
		ForwardType: "gost",
	}
	baseSignature := countingChainRuleSignature(base)
	if baseSignature == countingChainRuleSignature(runningRule{
		RuleID:      base.RuleID,
		SourcePort:  base.SourcePort,
		TargetIP:    base.TargetIP,
		TargetPort:  base.TargetPort,
		Protocol:    base.Protocol,
		ForwardType: "iptables",
	}) {
		t.Fatal("counting signature did not change when the forward type changed")
	}
	legacySignature := fmt.Sprintf("%d|%s|%d|%s", base.SourcePort, base.TargetIP, base.TargetPort, base.Protocol)
	if baseSignature == legacySignature {
		t.Fatal("counting signature still uses the pre-layout-version format")
	}
	changedTarget := base
	changedTarget.TargetIP = "198.51.100.20"
	changedTarget.TargetPort = 8443
	if baseSignature != countingChainRuleSignature(changedTarget) {
		t.Fatal("process counting signature changed with an unrelated DNS target change")
	}
	kernel := base
	kernel.ForwardType = "iptables"
	kernelChangedTarget := kernel
	kernelChangedTarget.TargetIP = "198.51.100.20"
	if countingChainRuleSignature(kernel) == countingChainRuleSignature(kernelChangedTarget) {
		t.Fatal("kernel counting signature ignored its DNAT target")
	}
}

func TestCountingRepairCacheDoesNotQueueAnUnchangedRule(t *testing.T) {
	rule := runningRule{
		RuleID:      70,
		SourcePort:  22022,
		TargetIP:    "203.0.113.10",
		TargetPort:  443,
		Protocol:    "tcp",
		ForwardType: "gost",
	}
	key := fmt.Sprint(rule.SourcePort)

	countingChainMu.Lock()
	previousSignatures := countingChainSignatures
	previousCheckedAt := countingChainCheckedAt
	previousPending := countingChainRepairPending
	previousQueue := countingChainRepairQueue
	countingChainSignatures = map[string]string{key: countingChainRuleSignature(rule)}
	countingChainCheckedAt = map[string]time.Time{key: time.Now()}
	countingChainRepairPending = map[string]bool{}
	countingChainRepairQueue = make(chan runningRule, 1)
	countingChainMu.Unlock()
	t.Cleanup(func() {
		countingChainMu.Lock()
		countingChainSignatures = previousSignatures
		countingChainCheckedAt = previousCheckedAt
		countingChainRepairPending = previousPending
		countingChainRepairQueue = previousQueue
		countingChainMu.Unlock()
	})

	ensureCountingChainsIfNeeded(rule)
	if got := len(countingChainRepairQueue); got != 0 {
		t.Fatalf("unchanged counting rule queued %d repair jobs", got)
	}
}
