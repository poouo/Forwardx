package main

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestIPLimitCountsDistinctAddressesAcrossPortsAndProtocols(t *testing.T) {
	state := ipLimitState{}
	state.configure([]ipAccessLimitSpec{{UserID: 1, MaxIPs: 2, TCPPorts: []int{1000, 1001}, UDPPorts: []int{1000}}})
	now := time.Unix(1000, 0)
	flows := []ipLimitFlow{{"tcp-a", "192.0.2.1", "tcp", 1, 400, 400, true}, {"tcp-b", "192.0.2.1", "tcp", 1, 400, 400, true}, {"udp-a", "192.0.2.1", "udp", 1, 400, 400, true}, {"ipv6", "2001:db8::1", "tcp", 1, 400, 400, true}, {"excess", "192.0.2.9", "tcp", 1, 400, 400, true}}
	if p := state.observe(flows, now); len(p[0].IPs) != 0 {
		t.Fatal("probation counted immediately")
	}
	policies := state.observe(flows, now.Add(6*time.Second))
	if len(policies[0].IPs) != 2 || !policies[0].Full {
		t.Fatalf("quota: %+v", policies)
	}
	if !reflect.DeepEqual(policies[0].IPs, []string{"192.0.2.1", "192.0.2.9"}) {
		t.Fatalf("deterministic admission: %+v", policies)
	}
	// A new rule does not reset the two existing admissions.
	state.configure([]ipAccessLimitSpec{{UserID: 1, MaxIPs: 2, TCPPorts: []int{1000, 1001, 1002}}})
	if len(state.policies()[0].IPs) != 2 {
		t.Fatal("adding a rule reset IP slots")
	}
	state.configure(nil)
	if len(state.users) != 0 {
		t.Fatal("disabled limits retained users")
	}
}

func TestIPLimitShortScansAndOneShotUDPDoNotConsumeSlots(t *testing.T) {
	state := ipLimitState{}
	state.configure([]ipAccessLimitSpec{{UserID: 1, MaxIPs: 1, TCPPorts: []int{1000}, UDPPorts: []int{1000}}})
	now := time.Unix(1000, 0)
	// Large one-shot UDP probes leave conntrack entries behind. Mere presence
	// of those entries is not continued application activity.
	udp := ipLimitFlow{"one-shot", "192.0.2.8", "udp", 1, 2000, 2000, true}
	for i := 0; i < 20; i++ {
		short := ipLimitFlow{fmt.Sprintf("scan-%d", i), "192.0.2.9", "tcp", 1, 4000, 4000, true}
		p := state.observe([]ipLimitFlow{short, udp}, now.Add(time.Duration(i)*2*time.Second))
		if len(p[0].IPs) != 0 {
			t.Fatalf("scan occupied slot at tick %d: %+v", i, p)
		}
		if len(state.flows) > 2 {
			t.Fatal("short scan state accumulated")
		}
	}
	// A held TCP handshake with no meaningful traffic does not count either.
	handshake := ipLimitFlow{"bare-handshake", "192.0.2.10", "tcp", 1, 120, 60, false}
	state.observe([]ipLimitFlow{handshake}, now.Add(time.Minute))
	if p := state.observe([]ipLimitFlow{handshake}, now.Add(2*time.Minute)); len(p[0].IPs) != 0 {
		t.Fatal("idle handshake counted")
	}
}

func TestIPLimitReleasesTCPAndUDPAdmissionsAndSharesFamilyQuota(t *testing.T) {
	now := time.Unix(1000, 0)
	for _, protocol := range []string{"tcp", "udp"} {
		t.Run(protocol, func(t *testing.T) {
			state := ipLimitState{}
			state.configure([]ipAccessLimitSpec{{UserID: 1, MaxIPs: 1, TCPPorts: []int{1000}, UDPPorts: []int{1000}}})
			flow := ipLimitFlow{"live", "2001:db8::1", protocol, 1, 400, 400, true}
			state.observe([]ipLimitFlow{flow}, now)
			flow.in++
			p := state.observe([]ipLimitFlow{flow}, now.Add(6*time.Second))
			if !p[0].Full {
				t.Fatal("real visitor not admitted")
			}
			if protocol == "tcp" {
				p = state.observe(nil, now.Add(17*time.Second))
			} else {
				for i := 8; i <= 38; i += 2 {
					p = state.observe([]ipLimitFlow{flow}, now.Add(time.Duration(i)*time.Second))
				}
			}
			if len(p[0].IPs) != 0 || p[0].Full {
				t.Fatal("inactive IP did not release its slot")
			}
		})
	}
}

func TestIPLimitUserIsolationCounterResetAndQuotaReduction(t *testing.T) {
	state := ipLimitState{}
	state.configure([]ipAccessLimitSpec{{UserID: 1, MaxIPs: 2, TCPPorts: []int{1}}, {UserID: 2, MaxIPs: 1, TCPPorts: []int{2}}})
	now := time.Unix(1000, 0)
	flows := []ipLimitFlow{{"a", "192.0.2.1", "tcp", 1, 400, 400, true}, {"b", "192.0.2.2", "tcp", 1, 400, 400, true}, {"c", "192.0.2.3", "tcp", 2, 400, 400, true}}
	state.observe(flows, now)
	flows[2].in = 300 // Reused tuple/counter reset starts probation again.
	p := state.observe(flows, now.Add(6*time.Second))
	if len(p[0].IPs) != 2 || len(p[1].IPs) != 0 {
		t.Fatalf("isolation/reset: %+v", p)
	}
	state.configure([]ipAccessLimitSpec{{UserID: 1, MaxIPs: 1, TCPPorts: []int{1}}})
	if p = state.policies(); len(p) != 1 || len(p[0].IPs) != 1 {
		t.Fatalf("reduction: %+v", p)
	}
}

func TestIPLimitParserIgnoresUnrepliedTimeWaitAndUnrelatedTraffic(t *testing.T) {
	specs := []ipAccessLimitSpec{{UserID: 1, MaxIPs: 2, TCPPorts: []int{1000}, UDPPorts: []int{1000}}}
	line := func(proto, state, source, dest string, port int, bytes bool) string {
		accounting := "packets=10 bytes=600"
		if !bytes {
			accounting = ""
		}
		return fmt.Sprintf("ipv4 2 %s 6 120 %s src=%s dst=%s sport=12000 dport=%d %s src=%s dst=%s sport=%d dport=12000 %s [ASSURED]\n", proto, state, source, dest, port, accounting, dest, source, port, accounting)
	}
	raw := line("tcp", "ESTABLISHED", "192.0.2.1", "198.51.100.1", 1000, true) + line("tcp", "TIME_WAIT", "192.0.2.2", "198.51.100.1", 1000, true) + line("tcp", "SYN_SENT [UNREPLIED]", "192.0.2.3", "198.51.100.1", 1000, true) + line("tcp", "ESTABLISHED", "192.0.2.4", "198.51.100.99", 1000, true) + line("udp", "", "2001:db8::1", "198.51.100.1", 1000, true)
	flows, err := scanIPLimitFlows(strings.NewReader(raw), specs, map[string]bool{"198.51.100.1": true})
	if err != nil || len(flows) != 2 || !flows[0].business {
		t.Fatalf("parser: %+v %v", flows, err)
	}
	_, err = scanIPLimitFlows(strings.NewReader(line("tcp", "ESTABLISHED", "192.0.2.1", "198.51.100.1", 1000, false)), specs, map[string]bool{"198.51.100.1": true})
	if err == nil {
		t.Fatal("missing accounting silently accepted")
	}
}

func TestIPLimitFirewallAllowsMembersBeforeDroppingUnknownSources(t *testing.T) {
	fw := newFakePortLimitFirewall()
	policy := ipLimitPolicy{Spec: ipAccessLimitSpec{UserID: 1, MaxIPs: 1, TCPPorts: []int{1000, 1001}, UDPPorts: []int{1000}}, IPs: []string{"192.0.2.1"}, Full: true}
	dispatch, rules := ipLimitRules([]ipLimitPolicy{policy}, false)
	if err := reconcileLimitPlan(fw, "iptables", dispatch, rules, false, []string{"FWX_ID_", "FWX_IU_"}, ipLimitHook); err != nil {
		t.Fatal(err)
	}
	for name, planned := range rules {
		if name == dispatch {
			continue
		}
		actual := fw.tables["iptables"][name]
		if !reflect.DeepEqual(actual, planned) {
			t.Fatalf("allow/drop order: got %v want %v", actual, planned)
		}
	}
	if hook := strings.Join(ipLimitHook(dispatch, "OUTPUT"), " "); strings.Contains(hook, "--syn") || !strings.Contains(hook, "--ctdir ORIGINAL") {
		t.Fatal("does not cover UDP/existing excess probation flows")
	}
	if err := reconcileLimitPlan(fw, "iptables", "", map[string][][]string{}, false, []string{"FWX_ID_", "FWX_IU_"}, ipLimitHook); err != nil {
		t.Fatal(err)
	}
	for name := range fw.tables["iptables"] {
		if managedLimitChain(name, []string{"FWX_ID_", "FWX_IU_"}) {
			t.Fatal("disabled limit retained firewall chains")
		}
	}
}

func TestIPLimitNormalizationRejectsAmbiguousPortsAndCanonicalizes(t *testing.T) {
	normalized, err := normalizeIPAccessLimits([]ipAccessLimitSpec{{UserID: 1, MaxIPs: 2, TCPPorts: []int{20, 10, 20}, UDPPorts: []int{10}}})
	if err != nil || !reflect.DeepEqual(normalized[0].TCPPorts, []int{10, 20}) {
		t.Fatal(normalized, err)
	}
	_, err = normalizeIPAccessLimits([]ipAccessLimitSpec{{UserID: 1, MaxIPs: 2, TCPPorts: []int{10}}, {UserID: 2, MaxIPs: 1, TCPPorts: []int{10}}})
	if err == nil {
		t.Fatal("overlapping user port accepted")
	}
	_, err = normalizeIPAccessLimits([]ipAccessLimitSpec{{UserID: 1, MaxIPs: 100001, TCPPorts: []int{10}}})
	if err == nil {
		t.Fatal("unbounded quota accepted")
	}
}

func TestIPLimitIPSetsAtomicMembershipRepairAndCleanup(t *testing.T) {
	fw := newFakePortLimitFirewall()
	sets := map[string][]string{"unrelated": {"203.0.113.1"}}
	writes := 0
	run := func(input string, args ...string) (string, error) {
		switch args[0] {
		case "save":
			ips, exists := sets[args[1]]
			if !exists {
				return "", fmt.Errorf("set missing")
			}
			lines := []string{}
			for _, ip := range ips {
				lines = append(lines, "add "+args[1]+" "+ip)
			}
			return strings.Join(lines, "\n"), nil
		case "list":
			names := []string{}
			for name := range sets {
				names = append(names, name)
			}
			return strings.Join(names, "\n"), nil
		case "destroy":
			writes++
			delete(sets, args[1])
		case "restore":
			writes++
			for _, line := range strings.Split(strings.TrimSpace(input), "\n") {
				f := strings.Fields(line)
				switch f[0] {
				case "create":
					if _, ok := sets[f[1]]; !ok {
						sets[f[1]] = nil
					}
				case "flush":
					if !strings.HasSuffix(f[1], "_T") {
						t.Fatal("flushed a live set")
					}
					sets[f[1]] = nil
				case "add":
					sets[f[1]] = append(sets[f[1]], f[2])
				case "swap":
					sets[f[1]], sets[f[2]] = sets[f[2]], sets[f[1]]
				case "destroy":
					delete(sets, f[1])
				default:
					return "", fmt.Errorf("unexpected restore command")
				}
			}
		default:
			return "", fmt.Errorf("unexpected ipset operation")
		}
		return "", nil
	}
	policies := []ipLimitPolicy{{Spec: ipAccessLimitSpec{UserID: 1, MaxIPs: 2, TCPPorts: []int{1000}}, IPs: []string{"192.0.2.1", "2001:db8::1"}, Full: true}}
	if err := syncIPLimitFirewallWith(fw, policies, false, true, run); err != nil {
		t.Fatal(err)
	}
	for ipv6, want := range map[bool][]string{false: {"192.0.2.1"}, true: {"2001:db8::1"}} {
		if !reflect.DeepEqual(sets[ipLimitSetName(1, ipv6)], want) {
			t.Fatal("family membership", sets)
		}
	}
	beforeWrites, beforeFW := writes, len(fw.writes)
	if err := syncIPLimitFirewallWith(fw, policies, true, true, run); err != nil {
		t.Fatal(err)
	}
	if writes != beforeWrites || len(fw.writes) != beforeFW {
		t.Fatal("health check mutated firewall")
	}
	sets[ipLimitSetName(1, false)] = nil // External flush must not remain invisible.
	if err := syncIPLimitFirewallWith(fw, policies, true, true, run); err == nil {
		t.Fatal("membership drift ignored")
	}
	if err := syncIPLimitFirewallWith(fw, policies, false, true, run); err != nil {
		t.Fatal(err)
	}
	if err := syncIPLimitFirewallWith(fw, nil, false, true, run); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(sets, map[string][]string{"unrelated": {"203.0.113.1"}}) {
		t.Fatalf("unsafe cleanup: %v", sets)
	}
}

func TestIPLimitUnavailableDependenciesDoNotInstallPartialRules(t *testing.T) {
	fw := newFakePortLimitFirewall()
	policies := []ipLimitPolicy{{Spec: ipAccessLimitSpec{UserID: 1, MaxIPs: 1, TCPPorts: []int{1000}}}}
	run := func(string, ...string) (string, error) { t.Fatal("unexpected ipset command"); return "", nil }
	if err := syncIPLimitFirewallWith(fw, policies, false, false, run); err == nil || len(fw.writes) != 0 {
		t.Fatal("missing dependency silently accepted")
	}
}

func TestIPLimitParserRejectsTruncatedSnapshots(t *testing.T) {
	if _, err := scanIPLimitFlows(strings.NewReader(strings.Repeat("irrelevant\n", ipLimitSnapshotBytes/11+1)), nil, nil); err == nil {
		t.Fatal("truncated snapshot accepted")
	}
}
