package main

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

func collectTraffic(cfg Config) {
	files, _ := os.ReadDir("/var/lib/forwardx-agent")
	stats := []map[string]any{}
	watched := 0
	for _, f := range files {
		name := f.Name()
		if !strings.HasPrefix(name, "port_") || !strings.HasSuffix(name, ".rule") {
			continue
		}
		watched++
		port := strings.TrimSuffix(strings.TrimPrefix(name, "port_"), ".rule")
		ridBytes, err := os.ReadFile("/var/lib/forwardx-agent/" + name)
		if err != nil {
			continue
		}
		ruleID, _ := strconv.Atoi(strings.TrimSpace(string(ridBytes)))
		if ruleID <= 0 {
			continue
		}
		forwardType := readForwardTypeByPort(port)
		if forwardType == "forwardx" {
			continue
		}
		in, out := iptablesBytes(port, "in"), iptablesBytes(port, "out")
		if forwardType == "nftables" {
			in, out = nftablesBytes(ruleID, port)
		}
		curConns := conntrackConnections(port)
		prevRuleID, prevIn, prevOut, prevConns := readPrev(port)
		if prevRuleID <= 0 || prevRuleID != ruleID {
			prevIn, prevOut = in, out
			prevConns = curConns
		}
		din, dout, dconns := delta(in, prevIn), delta(out, prevOut), delta(curConns, prevConns)
		writePrev(port, ruleID, in, out, curConns)
		if din > 0 || dout > 0 || dconns > 0 {
			stats = append(stats, map[string]any{"ruleId": ruleID, "bytesIn": din, "bytesOut": dout, "connections": dconns})
		}
	}
	if len(stats) > 0 {
		if err := post(cfg, "/api/agent/traffic", map[string]any{"stats": stats}, &map[string]any{}); err != nil {
			logf("traffic report failed watched=%d stats=%d: %v", watched, len(stats), err)
		} else {
			logf("traffic report ok watched=%d stats=%d", watched, len(stats))
		}
	}
}

func collectTCPing(cfg Config, probes []tunnelProbe, groupProbes []forwardGroupProbe) {
	files, _ := os.ReadDir("/var/lib/forwardx-agent")
	results := []map[string]any{}
	for _, f := range files {
		name := f.Name()
		if !strings.HasPrefix(name, "port_") || !strings.HasSuffix(name, ".rule") {
			continue
		}
		port := strings.TrimSuffix(strings.TrimPrefix(name, "port_"), ".rule")
		ridBytes, err := os.ReadFile("/var/lib/forwardx-agent/" + name)
		if err != nil {
			continue
		}
		ruleID, _ := strconv.Atoi(strings.TrimSpace(string(ridBytes)))
		targetIP, targetPort, ok := readTargetInfo(port)
		if !ok || ruleID <= 0 {
			continue
		}
		if readForwardTypeByPort(port) == "forwardx" {
			continue
		}
		latency, reachable := tcpLatency(targetIP, targetPort, 3*time.Second)
		result := map[string]any{"ruleId": ruleID}
		if reachable {
			result["latencyMs"] = latency
			result["isTimeout"] = false
		} else {
			result["latencyMs"] = 0
			result["isTimeout"] = true
		}
		results = append(results, result)
	}
	tunnels := []map[string]any{}
	for _, probe := range probes {
		if probe.TunnelID <= 0 || probe.TargetIP == "" || probe.TargetPort <= 0 {
			continue
		}
		latency, reachable := tcpLatency(probe.TargetIP, probe.TargetPort, 3*time.Second)
		result := map[string]any{"tunnelId": probe.TunnelID}
		if probe.HopCount > 0 {
			result["hopIndex"] = probe.HopIndex
			result["hopCount"] = probe.HopCount
		}
		if reachable {
			result["latencyMs"] = latency
			result["isTimeout"] = false
		} else {
			result["latencyMs"] = 0
			result["isTimeout"] = true
		}
		tunnels = append(tunnels, result)
	}
	forwardGroups := []map[string]any{}
	for _, probe := range groupProbes {
		if probe.GroupID <= 0 || probe.TargetIP == "" || probe.HopCount <= 0 {
			continue
		}
		method := strings.ToLower(strings.TrimSpace(probe.Method))
		if method == "ping" {
			latency, reachable, _ := pingLatency(probe.TargetIP, 3*time.Second)
			result := map[string]any{
				"groupId":  probe.GroupID,
				"method":   "ping",
				"hopIndex": probe.HopIndex,
				"hopCount": probe.HopCount,
			}
			if reachable {
				result["latencyMs"] = latency
				result["isTimeout"] = false
			} else {
				result["latencyMs"] = 0
				result["isTimeout"] = true
			}
			forwardGroups = append(forwardGroups, result)
			continue
		}
		if probe.TargetPort <= 0 {
			continue
		}
		latency, reachable := tcpLatency(probe.TargetIP, probe.TargetPort, 3*time.Second)
		result := map[string]any{
			"groupId":  probe.GroupID,
			"method":   "tcp",
			"hopIndex": probe.HopIndex,
			"hopCount": probe.HopCount,
		}
		if reachable {
			result["latencyMs"] = latency
			result["isTimeout"] = false
		} else {
			result["latencyMs"] = 0
			result["isTimeout"] = true
		}
		forwardGroups = append(forwardGroups, result)
	}
	if len(results) > 0 || len(tunnels) > 0 || len(forwardGroups) > 0 {
		_ = post(cfg, "/api/agent/tcping", map[string]any{"results": results, "tunnels": tunnels, "forwardGroups": forwardGroups}, &map[string]any{})
	}
}

func readTargetInfo(port string) (string, int, bool) {
	b, err := os.ReadFile("/var/lib/forwardx-agent/target_" + port + ".info")
	if err != nil {
		return "", 0, false
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) < 2 {
		return "", 0, false
	}
	targetIP := strings.TrimSpace(lines[0])
	targetPort, _ := strconv.Atoi(strings.TrimSpace(lines[1]))
	return targetIP, targetPort, targetIP != "" && targetPort > 0
}

func tcpLatency(ip string, port int, timeout time.Duration) (int, bool) {
	start := time.Now()
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(ip, strconv.Itoa(port)), timeout)
	if err != nil {
		return 0, false
	}
	_ = conn.Close()
	latency := int(time.Since(start).Milliseconds())
	if latency < 1 {
		latency = 1
	}
	return latency, true
}

func pingLatency(host string, timeout time.Duration) (int, bool, string) {
	target := strings.TrimSpace(host)
	if target == "" {
		return 0, false, "目标为空"
	}
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), timeout+time.Second)
	defer cancel()
	args := []string{"-c", "1", "-W", strconv.Itoa(int(timeout.Seconds())), target}
	if runtime.GOOS == "windows" {
		args = []string{"-n", "1", "-w", strconv.Itoa(int(timeout.Milliseconds())), target}
	}
	output, err := exec.CommandContext(ctx, "ping", args...).CombinedOutput()
	elapsed := int(time.Since(start).Milliseconds())
	if elapsed < 1 {
		elapsed = 1
	}
	text := string(output)
	if ctx.Err() == context.DeadlineExceeded {
		return 0, false, "timeout"
	}
	if err != nil {
		detail := strings.TrimSpace(text)
		if detail == "" {
			detail = err.Error()
		}
		return 0, false, detail
	}
	if parsed := parsePingLatencyMs(text); parsed > 0 {
		return parsed, true, ""
	}
	return elapsed, true, ""
}

func parsePingLatencyMs(output string) int {
	patterns := []*regexp.Regexp{
		regexp.MustCompile(`time[=<]\s*([0-9]+(?:\.[0-9]+)?)\s*ms`),
		regexp.MustCompile(`Average\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*ms`),
		regexp.MustCompile(`avg[/=]\s*([0-9]+(?:\.[0-9]+)?)`),
	}
	for _, pattern := range patterns {
		matches := pattern.FindStringSubmatch(output)
		if len(matches) < 2 {
			continue
		}
		value, err := strconv.ParseFloat(matches[1], 64)
		if err != nil || value <= 0 {
			continue
		}
		latency := int(value + 0.5)
		if latency < 1 {
			latency = 1
		}
		return latency
	}
	return 0
}

func conntrackConnections(port string) uint64 {
	cmd := fmt.Sprintf(`awk -v p="dport=%s" 'index($0,p" ")>0 {c++} END{print c+0}' /proc/net/nf_conntrack 2>/dev/null`, port)
	out, err := exec.Command("sh", "-lc", cmd).Output()
	if err != nil {
		return 0
	}
	v, _ := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
	return v
}

func iptablesBytes(port string, direction string) uint64 {
	marker := "fwx-stat-" + port + ":" + direction
	parentChains := "PREROUTING INPUT FORWARD OUTPUT POSTROUTING"
	cmd := fmt.Sprintf(`for c in %s; do iptables -t mangle -nvxL "$c" 2>/dev/null | awk -v marker=%s '$0 ~ marker {s+=$2} END{print s+0}'; done | sort -nr | head -n1`, parentChains, shellQuote(marker))
	out, err := exec.Command("sh", "-lc", cmd).Output()
	if err == nil {
		if v, parseErr := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64); parseErr == nil && v > 0 {
			return v
		}
	}
	legacyChain := "FWX_IN_" + port
	if direction == "out" {
		legacyChain = "FWX_OUT_" + port
	}
	return iptablesLegacyBytes(legacyChain)
}

func iptablesLegacyBytes(chain string) uint64 {
	parentChains := "PREROUTING INPUT FORWARD OUTPUT POSTROUTING"
	cmd := fmt.Sprintf(`for c in %s; do iptables -t mangle -nvxL "$c" 2>/dev/null | awk -v ch=%s '$0 ~ ch {s+=$2} END{print s+0}'; done | sort -nr | head -n1`, parentChains, shellQuote(chain))
	out, err := exec.Command("sh", "-lc", cmd).Output()
	if err != nil {
		return 0
	}
	v, _ := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
	return v
}

func nftablesBytes(ruleID int, port string) (uint64, uint64) {
	in := nftablesRuleBytes("traffic_prerouting", ruleID, "in")
	out := nftablesRuleBytes("traffic_postrouting", ruleID, "out")
	// Older generated nftables rules stored counters in per-rule chains.
	if in == 0 {
		in = nftablesChainBytes("in_" + strconv.Itoa(ruleID))
	}
	if out == 0 {
		out = nftablesChainBytes("out_" + strconv.Itoa(ruleID))
	}
	return in, out
}

func nftablesRuleBytes(chain string, ruleID int, direction string) uint64 {
	marker := fmt.Sprintf("fwx-rule-%d:%s", ruleID, direction)
	cmd := fmt.Sprintf(`nft -a list chain inet forwardx %s 2>/dev/null | awk -v marker=%s '$0 ~ marker && /counter packets/ {for(i=1;i<=NF;i++) if($i=="bytes") {s+=$(i+1)}} END{print s+0}'`, shellQuote(chain), shellQuote(marker))
	out, err := exec.Command("sh", "-lc", cmd).Output()
	if err != nil {
		return 0
	}
	v, _ := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
	return v
}

func nftablesChainBytes(chain string) uint64 {
	cmd := fmt.Sprintf(`nft -a list chain inet forwardx %s 2>/dev/null | awk '/counter packets/ {for(i=1;i<=NF;i++) if($i=="bytes") {s+=$(i+1)}} END{print s+0}'`, shellQuote(chain))
	out, err := exec.Command("sh", "-lc", cmd).Output()
	if err != nil {
		return 0
	}
	v, _ := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
	return v
}

func readPrev(port string) (int, uint64, uint64, uint64) {
	raw, err := os.ReadFile("/var/lib/forwardx-agent/traffic_" + port + ".prev")
	if err != nil {
		return 0, 0, 0, 0
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) < 2 {
		return 0, 0, 0, 0
	}
	// 4-line format (current): ruleID, in, out, conns
	if len(lines) >= 4 {
		rid, _ := strconv.Atoi(strings.TrimSpace(lines[0]))
		prevIn, _ := strconv.ParseUint(strings.TrimSpace(lines[1]), 10, 64)
		prevOut, _ := strconv.ParseUint(strings.TrimSpace(lines[2]), 10, 64)
		prevConns, _ := strconv.ParseUint(strings.TrimSpace(lines[3]), 10, 64)
		return rid, prevIn, prevOut, prevConns
	}
	// 3-line legacy format: ruleID, in, out (no conns)
	if len(lines) >= 3 {
		rid, _ := strconv.Atoi(strings.TrimSpace(lines[0]))
		prevIn, _ := strconv.ParseUint(strings.TrimSpace(lines[1]), 10, 64)
		prevOut, _ := strconv.ParseUint(strings.TrimSpace(lines[2]), 10, 64)
		return rid, prevIn, prevOut, 0
	}
	// 2-line legacy format: in, out (no ruleID, no conns)
	prevIn, _ := strconv.ParseUint(strings.TrimSpace(lines[0]), 10, 64)
	prevOut, _ := strconv.ParseUint(strings.TrimSpace(lines[1]), 10, 64)
	return 0, prevIn, prevOut, 0
}

func writePrev(port string, ruleID int, in, out, conns uint64) {
	_ = os.WriteFile("/var/lib/forwardx-agent/traffic_"+port+".prev", []byte(fmt.Sprintf("%d\n%d\n%d\n%d\n", ruleID, in, out, conns)), 0644)
}

func delta(cur, prev uint64) uint64 {
	if cur >= prev {
		return cur - prev
	}
	return cur
}
