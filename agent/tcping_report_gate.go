package main

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	tcpingSteadyReportEvery = 5 * time.Minute
	tcpingReportStateTTL    = 30 * time.Minute
)

type tcpingReportGateState struct {
	signature  string
	reportedAt time.Time
	lastSeenAt time.Time
}

type tcpingReportGate struct {
	mu     sync.Mutex
	states map[string]tcpingReportGateState
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
	return &tcpingReportGate{states: map[string]tcpingReportGateState{}}
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
		state := fmt.Sprintf("%s=%t", tcpingProbeStateKey(kind, report), tcpingReportStatus(report))
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
	selected := make(map[string]bool, len(signatures))
	updates := make(map[string]tcpingReportGateState, len(signatures))

	gate.mu.Lock()
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
		if force || !exists || state.signature != signature || now.Sub(state.reportedAt) >= tcpingSteadyReportEvery {
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
