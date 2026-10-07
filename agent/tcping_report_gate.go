package main

import (
	"container/list"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	tcpingSteadyReportEvery = 5 * time.Minute
	tcpingHealthReportEvery = time.Minute
	tcpingReportStateTTL    = 30 * time.Minute
	tcpingCounterCapacity   = 32768
	tcpingCounterMax        = 1000000000
)

type tcpingProbeCounter struct {
	key, epoch       string
	count, successes int
	seenAt           time.Time
}

type tcpingReportGateState struct {
	signature  string
	reportedAt time.Time
	lastSeenAt time.Time
}

type tcpingReportGate struct {
	mu           sync.Mutex
	states       map[string]tcpingReportGateState
	counters     map[string]*list.Element
	counterOrder *list.List
}

type tcpingReportGatePlan struct {
	results       []map[string]any
	tunnels       []map[string]any
	forwardGroups []map[string]any
	services      []map[string]any
	updates       map[string]tcpingReportGateState
}

var agentTCPingReportGate = newTCPingReportGate()

func newTCPingReportGate() *tcpingReportGate {
	return &tcpingReportGate{states: map[string]tcpingReportGateState{}, counters: map[string]*list.Element{}, counterOrder: list.New()}
}

// Called once per completed collection, not once per HTTP retry. Counters
// survive unacknowledged reports; the panel deduplicates cumulative snapshots.
// LRU/TTL eviction rotates epochs, so resetting a counter cannot subtract
// previously recorded attempts or merge two unrelated generations.
func (gate *tcpingReportGate) countReports(kind string, reports []map[string]any, now time.Time) []map[string]any {
	output := make([]map[string]any, 0, len(reports))
	for _, report := range reports {
		if tcpingReportText(report, "method") == "self" {
			// A synthetic local hop is health bookkeeping, not a network probe.
			output = append(output, report)
			continue
		}
		identity, _ := json.Marshal([]string{kind, tcpingReportText(report, "ruleId"), tcpingReportText(report, "tunnelId"),
			tcpingReportText(report, "groupId"), tcpingReportText(report, "memberId"), tcpingProbeStateKey(kind, report),
			tcpingReportText(report, "topologyKey"), tcpingReportText(report, "targetIp"), tcpingReportText(report, "targetPort"),
			tcpingReportText(report, "sourcePort"), tcpingReportText(report, "method"), tcpingReportText(report, "hopIndex"),
			tcpingReportText(report, "hopCount"), tcpingReportText(report, "seriesKey"), tcpingReportText(report, "probeType")})
		digest := sha256.Sum256(identity)
		key := hex.EncodeToString(digest[:])
		count := tcpingReportInt(report, "probeCount")
		if count < 1 || count > 1024 {
			count = 1
		}
		successes := count
		if tcpingReportStatus(report) {
			successes = 0
		}
		if _, ok := report["probeSuccesses"]; ok {
			successes = tcpingReportInt(report, "probeSuccesses")
		}
		if successes < 0 {
			successes = 0
		}
		if successes > count {
			successes = count
		}
		element := gate.counters[key]
		if element != nil && element.Value.(*tcpingProbeCounter).count > tcpingCounterMax-count {
			gate.counterOrder.Remove(element)
			delete(gate.counters, key)
			element = nil
		}
		if element == nil {
			var random [16]byte
			if _, err := rand.Read(random[:]); err != nil {
				// Entropy failure must not prevent forwarding or health reports.
				output = append(output, report)
				continue
			}
			element = gate.counterOrder.PushBack(&tcpingProbeCounter{key: key, epoch: hex.EncodeToString(random[:])})
			gate.counters[key] = element
		}
		counter := element.Value.(*tcpingProbeCounter)
		counter.count += count
		counter.successes += successes
		counter.seenAt = now
		gate.counterOrder.MoveToBack(element)
		clone := make(map[string]any, len(report)+3)
		for field, value := range report {
			clone[field] = value
		}
		clone["probeCounterEpoch"] = counter.epoch
		clone["probeTotalCount"] = counter.count
		clone["probeTotalSuccesses"] = counter.successes
		output = append(output, clone)
		for gate.counterOrder.Len() > tcpingCounterCapacity {
			oldest := gate.counterOrder.Front()
			delete(gate.counters, oldest.Value.(*tcpingProbeCounter).key)
			gate.counterOrder.Remove(oldest)
		}
	}
	return output
}

func tcpingReportText(payload map[string]any, key string) string {
	value, exists := payload[key]
	if !exists || value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

func tcpingReportInt(payload map[string]any, key string) int {
	value := payload[key]
	switch typed := value.(type) {
	case int:
		return typed
	case int32:
		return int(typed)
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	default:
		var parsed int
		_, _ = fmt.Sscan(strings.TrimSpace(fmt.Sprint(value)), &parsed)
		return parsed
	}
}

func tcpingProbeStateKey(kind string, payload map[string]any) string {
	if probeKey := tcpingReportText(payload, "probeKey"); probeKey != "" {
		return probeKey
	}
	return strings.Join([]string{
		kind,
		tcpingReportText(payload, "ruleId"),
		tcpingReportText(payload, "tunnelId"),
		tcpingReportText(payload, "groupId"),
		tcpingReportText(payload, "memberId"),
		tcpingReportText(payload, "targetIp"),
		tcpingReportText(payload, "targetPort"),
		tcpingReportText(payload, "method"),
		tcpingReportText(payload, "hopIndex"),
		tcpingReportText(payload, "hopCount"),
		tcpingReportText(payload, "seriesKey"),
	}, ":")
}

func tcpingReportUnitKey(kind string, payload map[string]any) string {
	switch kind {
	case "rule":
		return "rule:" + tcpingProbeStateKey(kind, payload)
	case "tunnel":
		return fmt.Sprintf("tunnel:%d:%s", tcpingReportInt(payload, "tunnelId"), tcpingReportText(payload, "topologyKey"))
	case "forwardGroup":
		return fmt.Sprintf("forward-group:%d:%s", tcpingReportInt(payload, "groupId"), tcpingReportText(payload, "topologyKey"))
	default:
		return kind + ":" + tcpingProbeStateKey(kind, payload)
	}
}

func tcpingReportStatus(payload map[string]any) bool {
	timeout, _ := payload["isTimeout"].(bool)
	return timeout
}

func tcpingReportUnitSignatures(groups map[string][]string) map[string]string {
	signatures := make(map[string]string, len(groups))
	for key, values := range groups {
		sort.Strings(values)
		signatures[key] = strings.Join(values, "|")
	}
	return signatures
}

func addTCPingReportUnits(groups map[string][]string, kind string, reports []map[string]any, bypassTunnelRules bool) {
	for _, report := range reports {
		if bypassTunnelRules && tcpingReportInt(report, "tunnelId") > 0 {
			continue
		}
		unitKey := tcpingReportUnitKey(kind, report)
		state := fmt.Sprintf(
			"%s=%t:%s:%d/%d",
			tcpingProbeStateKey(kind, report),
			tcpingReportStatus(report),
			tcpingReportText(report, "healthStatus"),
			tcpingReportInt(report, "probeCount"),
			tcpingReportInt(report, "probeSuccesses"),
		)
		groups[unitKey] = append(groups[unitKey], state)
	}
}

func filterTCPingReports(reports []map[string]any, kind string, selected map[string]bool, bypassTunnelRules bool) []map[string]any {
	filtered := make([]map[string]any, 0, len(reports))
	for _, report := range reports {
		if bypassTunnelRules && tcpingReportInt(report, "tunnelId") > 0 {
			filtered = append(filtered, report)
			continue
		}
		if selected[tcpingReportUnitKey(kind, report)] {
			filtered = append(filtered, report)
		}
	}
	return filtered
}

func (gate *tcpingReportGate) plan(
	results, tunnels, forwardGroups, services []map[string]any,
	force bool,
	now time.Time,
) tcpingReportGatePlan {
	groups := map[string][]string{}
	addTCPingReportUnits(groups, "rule", results, true)
	addTCPingReportUnits(groups, "tunnel", tunnels, false)
	addTCPingReportUnits(groups, "forwardGroup", forwardGroups, false)
	signatures := tcpingReportUnitSignatures(groups)
	healthUnits := map[string]bool{}
	for _, reportGroup := range []struct {
		kind    string
		reports []map[string]any
	}{
		{kind: "rule", reports: results},
		{kind: "forwardGroup", reports: forwardGroups},
	} {
		for _, report := range reportGroup.reports {
			if tcpingReportText(report, "healthStatus") != "" {
				healthUnits[tcpingReportUnitKey(reportGroup.kind, report)] = true
			}
		}
	}
	selected := make(map[string]bool, len(signatures))
	updates := make(map[string]tcpingReportGateState, len(signatures))

	gate.mu.Lock()
	for oldest := gate.counterOrder.Front(); oldest != nil; oldest = gate.counterOrder.Front() {
		if now.Sub(oldest.Value.(*tcpingProbeCounter).seenAt) <= tcpingReportStateTTL {
			break
		}
		delete(gate.counters, oldest.Value.(*tcpingProbeCounter).key)
		gate.counterOrder.Remove(oldest)
	}
	results = gate.countReports("rule", results, now)
	tunnels = gate.countReports("tunnel", tunnels, now)
	forwardGroups = gate.countReports("forwardGroup", forwardGroups, now)
	for key, state := range gate.states {
		if now.Sub(state.lastSeenAt) > tcpingReportStateTTL {
			delete(gate.states, key)
		}
	}
	for key, signature := range signatures {
		state, exists := gate.states[key]
		if exists {
			state.lastSeenAt = now
			gate.states[key] = state
		}
		reportEvery := tcpingSteadyReportEvery
		if healthUnits[key] {
			reportEvery = tcpingHealthReportEvery
		}
		if force || !exists || state.signature != signature || now.Sub(state.reportedAt) >= reportEvery {
			selected[key] = true
			updates[key] = tcpingReportGateState{signature: signature, reportedAt: now, lastSeenAt: now}
		}
	}
	gate.mu.Unlock()

	return tcpingReportGatePlan{
		results:       filterTCPingReports(results, "rule", selected, true),
		tunnels:       filterTCPingReports(tunnels, "tunnel", selected, false),
		forwardGroups: filterTCPingReports(forwardGroups, "forwardGroup", selected, false),
		services:      append([]map[string]any(nil), services...),
		updates:       updates,
	}
}

func (gate *tcpingReportGate) commit(plan tcpingReportGatePlan) {
	gate.mu.Lock()
	for key, update := range plan.updates {
		gate.states[key] = update
	}
	gate.mu.Unlock()
}
