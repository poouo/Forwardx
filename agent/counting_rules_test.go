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
		fmt.Sprint(countingRuleModeForForwardType("nginx")) != process {
		t.Fatalf("process forwarders must share the listener counting layout, got gost=%q realm=%q socat=%q nginx=%q",
			process,
			fmt.Sprint(countingRuleModeForForwardType("realm")),
			fmt.Sprint(countingRuleModeForForwardType("socat")),
			fmt.Sprint(countingRuleModeForForwardType("nginx")),
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

func TestProcessIptablesFallbackUsesOnlyListenerHooks(t *testing.T) {
	commands := strings.Join(countingAddCommands(iptablesProcessCountingCmds(22022, "both")), "\n")
	for _, proto := range []string{"tcp", "udp"} {
		if !strings.Contains(commands, "INPUT -p "+proto+" --dport 22022") {
			t.Fatalf("iptables fallback missing %s input listener counter:\n%s", proto, commands)
		}
		if !strings.Contains(commands, "OUTPUT -p "+proto+" --sport 22022") {
			t.Fatalf("iptables fallback missing %s output listener counter:\n%s", proto, commands)
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
