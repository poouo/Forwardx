package main

import (
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"
)

type fakePortLimitFirewall struct {
	tables       map[string]map[string][][]string
	missing      map[string]bool
	ipv6         bool
	failContains string
	writes       []string
}

func newFakePortLimitFirewall() *fakePortLimitFirewall {
	return &fakePortLimitFirewall{tables: map[string]map[string][][]string{}, missing: map[string]bool{}, ipv6: true}
}
func (f *fakePortLimitFirewall) Available(binary string) bool { return !f.missing[binary] }
func (f *fakePortLimitFirewall) IPv6Enabled() bool            { return f.ipv6 }
func (f *fakePortLimitFirewall) Run(binary string, args ...string) (string, error) {
	table := f.tables[binary]
	if table == nil {
		table = map[string][][]string{"PREROUTING": nil, "OUTPUT": nil}
		f.tables[binary] = table
	}
	cmd := binary + " " + strings.Join(args, " ")
	if f.failContains != "" && strings.Contains(cmd, f.failContains) {
		return "", fmt.Errorf("simulated connlimit failure")
	}
	if args[0] == "-S" {
		var names []string
		for name := range table {
			names = append(names, name)
		}
		sort.Strings(names)
		var lines []string
		for _, name := range names {
			if name != "PREROUTING" && name != "OUTPUT" {
				lines = append(lines, "-N "+name)
			}
			for _, rule := range table[name] {
				lines = append(lines, "-A "+name+" "+strings.Join(rule, " "))
			}
		}
		return strings.Join(lines, "\n"), nil
	}
	name := args[1]
	rule := args[2:]
	if args[0] == "-I" {
		rule = args[3:]
	}
	index := -1
	for i, existing := range table[name] {
		if reflect.DeepEqual(existing, rule) {
			index = i
			break
		}
	}
	if args[0] == "-C" {
		if index < 0 {
			return "", fmt.Errorf("not found")
		}
		return "", nil
	}
	f.writes = append(f.writes, cmd)
	switch args[0] {
	case "-N":
		table[name] = nil
	case "-I":
		table[name] = append([][]string{append([]string(nil), rule...)}, table[name]...)
	case "-A":
		table[name] = append(table[name], append([]string(nil), rule...))
	case "-D":
		if index < 0 {
			return "", fmt.Errorf("delete missing rule")
		}
		table[name] = append(table[name][:index], table[name][index+1:]...)
	case "-F":
		table[name] = nil
	case "-X":
		delete(table, name)
	default:
		return "", fmt.Errorf("unexpected command %s", cmd)
	}
	return "", nil
}

func TestPortAccessLimitsShareCountersAndPreserveThemWhenAddingPorts(t *testing.T) {
	fw := newFakePortLimitFirewall()
	specs := []portAccessLimitSpec{{UserID: 7, MaxIPs: 2, Ports: []int{22001, 22002}}}
	if err := syncPortAccessLimits(fw, specs, false); err != nil {
		t.Fatal(err)
	}
	for _, binary := range []string{"iptables", "ip6tables"} {
		_, desired := portLimitRules(specs, binary == "ip6tables")
		for name := range desired {
			rules := fw.tables[binary][name]
			if !reflect.DeepEqual(rules[len(rules)-1], []string{"-j", "RETURN"}) {
				t.Fatalf("RETURN must be last: %v", rules)
			}
		}
		for _, base := range []string{"PREROUTING", "OUTPUT"} {
			hook := strings.Join(fw.tables[binary][base][0], " ")
			if strings.Contains(hook, "! -i lo") != (base == "PREROUTING") {
				t.Fatalf("local connections may be counted twice: %s", hook)
			}
			for _, want := range []string{"--syn", "--ctstate NEW", "--ctdir ORIGINAL", "--dst-type LOCAL"} {
				if !strings.Contains(hook, want) {
					t.Fatalf("hook missing %s: %s", want, hook)
				}
			}
		}
	}
	fw.writes = nil
	if err := syncPortAccessLimits(fw, specs, false); err != nil {
		t.Fatal(err)
	}
	if len(fw.writes) != 0 {
		t.Fatalf("unchanged sync modified counters: %v", fw.writes)
	}
	specs[0].Ports = append(specs[0].Ports, 22003)
	if err := syncPortAccessLimits(fw, specs, false); err != nil {
		t.Fatal(err)
	}
	for _, write := range fw.writes {
		if strings.Contains(write, "FWX_PC_") && (strings.Contains(write, " -F ") || strings.Contains(write, " -X ") || strings.Contains(write, " -N ")) {
			t.Fatalf("adding a port reset shared counter: %s", write)
		}
		if strings.Contains(write, "nat") || strings.Contains(write, "systemctl") {
			t.Fatalf("disruptive sync: %s", write)
		}
	}
	fw.writes = nil
	if err := syncPortAccessLimits(fw, specs, true); err != nil {
		t.Fatal(err)
	}
	if len(fw.writes) > 0 {
		t.Fatal("readiness wrote firewall state")
	}
}

func TestPortAccessLimitIPv4IPv6AndChunks(t *testing.T) {
	ports := make([]int, 31)
	for i := range ports {
		ports[i] = 22000 + i
	}
	for _, ipv6 := range []bool{false, true} {
		dispatch, rules := portLimitRules([]portAccessLimitSpec{{UserID: 7, MaxIPs: 3, Ports: ports}}, ipv6)
		if len(rules[dispatch]) != 4 {
			t.Fatalf("multiport chunks=%d want=3 + return", len(rules[dispatch]))
		}
		mask := "32"
		if ipv6 {
			mask = "128"
		}
		for name, rules := range rules {
			if name == dispatch {
				continue
			}
			text := strings.Join(rules[0], " ")
			if !strings.Contains(text, "--connlimit-mask "+mask) || !strings.Contains(text, "-j DROP") {
				t.Fatalf("bad limit: %s", text)
			}
		}
	}
}

func TestPortAccessLimitCleanupAndThresholdChangesOnlyTouchOwnedChains(t *testing.T) {
	fw := newFakePortLimitFirewall()
	fw.Run("iptables", "-N", "OTHER_APP")
	fw.Run("iptables", "-N", "FWX_PC_not_our_generated_chain")
	specs := []portAccessLimitSpec{{UserID: 1, MaxIPs: 2, Ports: []int{22}}}
	if err := syncPortAccessLimits(fw, specs, false); err != nil {
		t.Fatal(err)
	}
	specs[0].MaxIPs = 4
	if err := syncPortAccessLimits(fw, specs, false); err != nil {
		t.Fatal(err)
	}
	if err := syncPortAccessLimits(fw, nil, false); err != nil {
		t.Fatal(err)
	}
	for _, table := range fw.tables {
		for name := range table {
			if managedPortLimitChain(name) {
				t.Fatalf("stale limit chain %s", name)
			}
		}
		if len(table["PREROUTING"]) > 0 || len(table["OUTPUT"]) > 0 {
			t.Fatal("stale limit hook")
		}
	}
	if _, exists := fw.tables["iptables"]["OTHER_APP"]; !exists {
		t.Fatal("unrelated chain removed")
	}
	if _, exists := fw.tables["iptables"]["FWX_PC_not_our_generated_chain"]; !exists {
		t.Fatal("foreign prefixed chain removed")
	}
}

func TestPortAccessLimitFailureDoesNotReplacePreviousHooks(t *testing.T) {
	fw := newFakePortLimitFirewall()
	specs := []portAccessLimitSpec{{UserID: 1, MaxIPs: 2, Ports: []int{22}}}
	if err := syncPortAccessLimits(fw, specs, false); err != nil {
		t.Fatal(err)
	}
	before := append([]string(nil), fw.tables["iptables"]["PREROUTING"][0]...)
	specs[0].MaxIPs = 4
	fw.failContains = "--connlimit-above 4"
	if err := syncPortAccessLimits(fw, specs, false); err == nil {
		t.Fatal("swallowed firewall failure")
	}
	if !reflect.DeepEqual(before, fw.tables["iptables"]["PREROUTING"][0]) {
		t.Fatal("failed preparation replaced working hook")
	}
	fw.failContains = ""
	if err := syncPortAccessLimits(fw, specs, false); err != nil {
		t.Fatal(err)
	}
	if err := syncPortAccessLimits(fw, specs, true); err != nil {
		t.Fatal(err)
	}
}

func TestPortAccessLimitMissingDependenciesAndValidation(t *testing.T) {
	fw := newFakePortLimitFirewall()
	fw.missing["ip6tables"] = true
	specs := []portAccessLimitSpec{{UserID: 1, MaxIPs: 2, Ports: []int{22}}}
	if err := syncPortAccessLimits(fw, specs, false); err == nil || !strings.Contains(err.Error(), "ip6tables missing") {
		t.Fatalf("missing IPv6 dependency not reported: %v", err)
	}
	fw.ipv6 = false
	if err := syncPortAccessLimits(fw, specs, false); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range [][]portAccessLimitSpec{
		{{UserID: 1, MaxIPs: -1, Ports: []int{22}}},
		{{UserID: 1, MaxIPs: 2, Ports: []int{65536}}},
		{{UserID: 1, MaxIPs: 2, Ports: []int{22}}, {UserID: 2, MaxIPs: 2, Ports: []int{22}}},
	} {
		fw.writes = nil
		if err := syncPortAccessLimits(fw, invalid, false); err == nil {
			t.Fatal("invalid config accepted")
		}
		if len(fw.writes) > 0 {
			t.Fatal("invalid input changed firewall")
		}
	}
}

func TestPortAccessLimitDesiredSignaturesIncludeLimitsAndPorts(t *testing.T) {
	a := action{StatusType: "runtime", ForwardType: "port-access-limit-sync", Op: "apply", PortAccessLimits: []portAccessLimitSpec{{UserID: 1, MaxIPs: 2, Ports: []int{22}}}}
	first := desiredActionSignature(a)
	a.PortAccessLimits[0].MaxIPs = 3
	if first == desiredActionSignature(a) {
		t.Fatal("threshold change lost")
	}
	second := desiredActionSignature(a)
	a.PortAccessLimits[0].Ports = append(a.PortAccessLimits[0].Ports, 23)
	if second == desiredActionSignature(a) {
		t.Fatal("port membership change lost")
	}
	if !reflect.DeepEqual(actionSerialKeys(a), []string{"runtime:port-access-limit-sync"}) {
		t.Fatal("sync is not serialized")
	}
}
