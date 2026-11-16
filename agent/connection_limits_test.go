package main

import (
	"strings"
	"testing"
)

func TestConnectionLimitsNormalizeAndRejectAmbiguousPorts(t *testing.T) {
	specs, err := normalizedConnectionLimits([]connectionLimitSpec{
		{UserID: 2, MaxConnections: 4, TCPPorts: []int{82, 80, 82}, UDPPorts: []int{80}},
		{UserID: 1, MaxConnections: 0, TCPPorts: []int{81}},
	})
	if err != nil || len(specs) != 1 || len(specs[0].TCPPorts) != 2 || specs[0].TCPPorts[0] != 80 {
		t.Fatalf("normalize: %#v %v", specs, err)
	}
	for _, invalid := range [][]connectionLimitSpec{
		{{UserID: 1, MaxConnections: -1}},
		{{UserID: 1, MaxConnections: 2, TCPPorts: []int{65536}}},
		{{UserID: 1, MaxConnections: 2, TCPPorts: []int{80}}, {UserID: 2, MaxConnections: 3, TCPPorts: []int{80}}},
	} {
		if _, err := normalizedConnectionLimits(invalid); err == nil {
			t.Fatalf("accepted ambiguous quota: %#v", invalid)
		}
	}
}

func TestConnectionLimitsPreserveCounterWhenPortsChange(t *testing.T) {
	spec := connectionLimitSpec{UserID: 7, MaxConnections: 16, TCPPorts: []int{80}}
	chain := connectionLimitChain(spec)
	current := connectionLimitSnapshot{exists: true, chains: map[string]bool{chain: true}, rules: map[string][]string{chain: {"fwx-" + chain}}}
	spec.TCPPorts = append(spec.TCPPorts, 81)
	plan := connectionLimitPlan([]connectionLimitSpec{spec}, current)
	if strings.Contains(plan, "flush chain inet "+connectionLimitTable+" "+chain) || strings.Contains(plan, "delete chain inet "+connectionLimitTable+" "+chain) {
		t.Fatal("live counter would be reset when adding a rule")
	}
	if !strings.Contains(plan, "tcp dport { 80, 81 }") || !strings.Contains(plan, "priority -140") || !strings.Contains(plan, "ct direction original fib daddr type local") {
		t.Fatalf("missing pre-DNAT dispatch: %s", plan)
	}
	if got := connectionLimitPlan(nil, current); got != "delete table inet "+connectionLimitTable+"\n" {
		t.Fatalf("unsafe quota cleanup: %s", got)
	}
}

func TestConnectionLimitsParticipateInDesiredSignature(t *testing.T) {
	a := action{StatusType: "runtime", ForwardType: "connection-limit-sync", Op: "apply", ConnectionLimits: []connectionLimitSpec{{UserID: 1, MaxConnections: 2, TCPPorts: []int{80}}}}
	first := actionCommandSignature(a)
	a.ConnectionLimits[0].MaxConnections = 3
	if first == actionCommandSignature(a) {
		t.Fatal("threshold change did not invalidate desired action")
	}
	first = actionCommandSignature(a)
	a.ConnectionLimits[0].TCPPorts = append(a.ConnectionLimits[0].TCPPorts, 81)
	if first == actionCommandSignature(a) {
		t.Fatal("port change did not invalidate desired action")
	}
}
