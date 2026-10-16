package main

// Optional, read-only connection sampling. It never installs firewall rules or
// changes nf_conntrack_acct. Closed-between-samples flows cannot be observed.
import (
	"bufio"
	"context"
	"io"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

var sourceAnalyticsEnabled atomic.Bool

type sourceFlowCounter struct {
	in, out    uint64
	accounting bool
}
type sourceAnalyticsSampler struct {
	previous map[string]sourceFlowCounter
	seen     map[string]bool
	day      string
}

var sourceSampler = sourceAnalyticsSampler{}

func updateSourceAnalyticsPolicy(response map[string]any) {
	if enabled, ok := response["sourceAnalyticsEnabled"].(bool); ok {
		sourceAnalyticsEnabled.Store(enabled)
	}
}

func normalizedSourceIP(raw string) string {
	ip := net.ParseIP(raw)
	if ip == nil {
		return ""
	}
	return ip.String()
}

func localAnalyticsAddresses() map[string]bool {
	out := map[string]bool{}
	addresses, _ := net.InterfaceAddrs()
	for _, addr := range addresses {
		if ip, _, err := net.ParseCIDR(addr.String()); err == nil {
			out[ip.String()] = true
		}
	}
	return out
}

func sourceAccounting(line string) sourceFlowCounter {
	values := []uint64{}
	for _, field := range strings.Fields(line) {
		if strings.HasPrefix(field, "bytes=") {
			value, err := strconv.ParseUint(strings.TrimPrefix(field, "bytes="), 10, 64)
			if err != nil {
				return sourceFlowCounter{}
			}
			values = append(values, value)
		}
	}
	if len(values) != 2 {
		return sourceFlowCounter{}
	}
	return sourceFlowCounter{values[0], values[1], true}
}

func (sampler *sourceAnalyticsSampler) scan(reader io.Reader, states []localRuleState, local map[string]bool, now time.Time) ([]map[string]any, string) {
	day := now.UTC().Add(8 * time.Hour).Format("2006-01-02")
	if sampler.day != day {
		sampler.day = day
		sampler.seen = map[string]bool{}
	}
	byPort := map[string]localRuleState{}
	for _, state := range states {
		if shouldCollectRuleTraffic(state) {
			byPort[state.Port] = state
		}
	}
	protocols := collectableRuleTrafficProtocols(states)
	current := map[string]sourceFlowCounter{}
	rows := map[string]map[string]any{}
	limited := false
	const maxBytes = 8 * 1024 * 1024
	bounded := &io.LimitedReader{R: reader, N: maxBytes}
	scanner := bufio.NewScanner(bounded)
	scanner.Buffer(make([]byte, 4096), 65536)
	lines := 0
	for scanner.Scan() {
		lines++
		if lines > 100000 {
			limited = true
			break
		}
		line := scanner.Text()
		protocol, src, dst, sport, port, ok := conntrackOriginalTuple(line)
		src, dst = normalizedSourceIP(src), normalizedSourceIP(dst)
		state, found := byPort[port]
		// Do not mistake the process's outgoing connection for a visitor.
		if !ok || !found || !protocols[port][protocol] || src == "" || !local[dst] || local[src] {
			continue
		}
		ip := net.ParseIP(src)
		if ip.IsLoopback() || ip.IsUnspecified() || ip.IsMulticast() {
			continue
		}
		if len(current) >= 20000 {
			limited = true
			break
		}
		flow := strconv.Itoa(state.RuleID) + "|" + protocol + "|" + src + "|" + dst + "|" + sport + "|" + port
		counter := sourceAccounting(line)
		if _, duplicate := current[flow]; duplicate {
			continue
		}
		current[flow] = counter
		key := strconv.Itoa(state.RuleID) + "|" + src
		if !sampler.seen[key] && len(sampler.seen) >= 5000 {
			limited = true
			continue
		}
		if rows[key] == nil && len(rows) >= 1000 {
			limited = true
			continue
		}
		sampler.seen[key] = true
		row := rows[key]
		if row == nil {
			row = map[string]any{"ruleId": state.RuleID, "ip": src, "bytesIn": uint64(0), "bytesOut": uint64(0), "accounting": counter.accounting}
			rows[key] = row
		}
		row["accounting"] = row["accounting"].(bool) && counter.accounting
		if previous, exists := sampler.previous[flow]; exists && previous.accounting && counter.accounting {
			// Counter resets/restarts establish a new baseline, not a huge delta.
			if counter.in >= previous.in {
				row["bytesIn"] = row["bytesIn"].(uint64) + counter.in - previous.in
			}
			if counter.out >= previous.out {
				row["bytesOut"] = row["bytesOut"].(uint64) + counter.out - previous.out
			}
		}
	}
	if scanner.Err() != nil || bounded.N == 0 {
		limited = true
	}
	sampler.previous = current
	result := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		result = append(result, row)
	}
	if limited {
		return result, "limited"
	}
	return result, "sampled"
}

func collectSourceAnalytics(states []localRuleState) ([]map[string]any, string) {
	if !sourceAnalyticsEnabled.Load() {
		sourceSampler = sourceAnalyticsSampler{}
		return nil, "disabled"
	}
	if len(collectableRuleTrafficStates(states)) == 0 {
		sourceSampler = sourceAnalyticsSampler{}
		return nil, "no_rules"
	}
	local := localAnalyticsAddresses()
	for _, path := range []string{"/proc/net/nf_conntrack", "/proc/net/ip_conntrack"} {
		if file, err := os.Open(path); err == nil {
			defer file.Close()
			return sourceSampler.scan(file, states, local, time.Now())
		}
	}
	// Modern kernels often expose conntrack only over netlink. One bounded CLI
	// snapshot per report is the fallback; absence is reported, never hidden.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "conntrack", "-L", "-o", "extended")
	pipe, err := cmd.StdoutPipe()
	if err != nil || cmd.Start() != nil {
		if shouldLogAgentReport("source-analytics-unavailable", 5*time.Minute) {
			logf("source analytics unavailable: proc conntrack absent and conntrack CLI cannot start")
		}
		return nil, "unavailable"
	}
	rows, status := sourceSampler.scan(pipe, states, local, time.Now())
	// Stop a producer that exceeded the scanner's limits before waiting on it.
	if status == "limited" {
		_ = cmd.Process.Kill()
	}
	if err := cmd.Wait(); err != nil && status != "limited" {
		return nil, "unavailable"
	}
	if status != "sampled" && shouldLogAgentReport("source-analytics-status", 5*time.Minute) {
		logf("source analytics status=%s samples=%d", status, len(rows))
	}
	return rows, status
}
