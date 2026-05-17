package main

import (
	"bufio"
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var Version = "2.2.35"
var upgradeStarted int32
var fxpMu sync.Mutex
var fxpServers = map[string]*fxpProcess{}
var lastTCPingAt time.Time

type Config struct {
	PanelURL string `json:"panelUrl"`
	Token    string `json:"token"`
	Interval int    `json:"interval"`
}

type envelope struct {
	V   int    `json:"v"`
	IV  string `json:"iv"`
	CT  string `json:"ct"`
	MAC string `json:"mac"`
	TS  int64  `json:"ts"`
}

type heartbeatResp struct {
	Actions      []action      `json:"actions"`
	SelfTests    []selfTest    `json:"selfTests"`
	RunningRules []runningRule `json:"runningRules"`
	TunnelProbes []tunnelProbe `json:"tunnelProbes"`
	AgentUpgrade *agentUpgrade `json:"agentUpgrade"`
	NextInterval int           `json:"nextInterval"`
}

type selfTestResp struct {
	SelfTests []selfTest `json:"selfTests"`
}

type action struct {
	TunnelID         int      `json:"tunnelId"`
	StatusType       string   `json:"statusType"`
	RuleID           int      `json:"ruleId"`
	Op               string   `json:"op"`
	ForwardType      string   `json:"forwardType"`
	SourcePort       int      `json:"sourcePort"`
	TargetIP         string   `json:"targetIp"`
	TargetPort       int      `json:"targetPort"`
	Protocol         string   `json:"protocol"`
	ServiceName      string   `json:"svcName"`
	ServiceNameExtra string   `json:"svcNameExtra"`
	Unit             string   `json:"unit"`
	UnitExtra        string   `json:"unitExtra"`
	Commands         []string `json:"commands"`
	Fxp              *fxpSpec `json:"fxp,omitempty"`
}

type runningRule struct {
	RuleID      int    `json:"ruleId"`
	SourcePort  int    `json:"sourcePort"`
	TargetIP    string `json:"targetIp"`
	TargetPort  int    `json:"targetPort"`
	Protocol    string `json:"protocol"`
	ForwardType string `json:"forwardType"`
}

type tunnelProbe struct {
	TunnelID   int    `json:"tunnelId"`
	TargetIP   string `json:"targetIp"`
	TargetPort int    `json:"targetPort"`
	Protocol   string `json:"protocol"`
}

type agentUpgrade struct {
	TargetVersion string `json:"targetVersion"`
	PanelURL      string `json:"panelUrl"`
}

type selfTest struct {
	TestID      int    `json:"testId"`
	RuleID      int    `json:"ruleId"`
	ForwardType string `json:"forwardType"`
	SourcePort  int    `json:"sourcePort"`
	Protocol    string `json:"protocol"`
	TargetIP    string `json:"targetIp"`
	TargetPort  int    `json:"targetPort"`
}

type fxpSpec struct {
	Role       string `json:"role"`
	TunnelID   int    `json:"tunnelId"`
	RuleID     int    `json:"ruleId"`
	ListenPort int    `json:"listenPort"`
	Protocol   string `json:"protocol"`
	ExitHost   string `json:"exitHost"`
	ExitPort   int    `json:"exitPort"`
	TargetIP   string `json:"targetIp"`
	TargetPort int    `json:"targetPort"`
	Key        string `json:"key"`
	LimitIn    int64  `json:"limitIn"`
	LimitOut   int64  `json:"limitOut"`
	MaxConnections int `json:"maxConnections"`
	MaxIPs         int `json:"maxIPs"`
	AccessScope    string `json:"accessScope"`
}

func main() {
	configPath := flag.String("config", "/etc/forwardx-agent/config.json", "config file")
	onceRegister := flag.Bool("register", false, "register and exit")
	flag.Parse()

	cfg, err := loadConfig(*configPath)
	if err != nil {
		fatal("load config: %v", err)
	}
	if cfg.Interval <= 0 {
		cfg.Interval = 30
	}
	cfg.PanelURL = strings.TrimRight(cfg.PanelURL, "/")

	if *onceRegister {
		if err := register(cfg); err != nil {
			fatal("register: %v", err)
		}
		return
	}

	_ = register(cfg)
	go selfTestPoller(cfg)
	go agentEventStream(cfg)
	for {
		nextInterval, err := heartbeat(cfg)
		if err != nil {
			logf("heartbeat error: %v", err)
		}
		if nextInterval <= 0 {
			nextInterval = cfg.Interval
		}
		if nextInterval < 2 {
			nextInterval = 2
		}
		time.Sleep(time.Duration(nextInterval) * time.Second)
	}
}

func loadConfig(path string) (Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	if err := json.Unmarshal(b, &cfg); err != nil {
		return Config{}, err
	}
	if cfg.PanelURL == "" || cfg.Token == "" {
		return Config{}, fmt.Errorf("panelUrl/token required")
	}
	return cfg, nil
}

func register(cfg Config) error {
	ipv4, ipv6 := publicIPs()
	primaryIP := ipv4
	if primaryIP == "" {
		primaryIP = ipv6
	}
	if primaryIP == "" {
		primaryIP = "unknown"
	}
	payload := map[string]any{
		"token":        cfg.Token,
		"ip":           primaryIP,
		"ipv4":         ipv4,
		"ipv6":         ipv6,
		"osInfo":       osInfo(),
		"cpuInfo":      cpuInfo(),
		"memoryTotal":  memTotal(),
		"agentVersion": Version,
	}
	var out map[string]any
	return post(cfg, "/api/agent/register", payload, &out)
}

func heartbeat(cfg Config) (int, error) {
	payload := map[string]any{
		"cpuUsage":     cpuUsage(),
		"memoryUsage":  memUsagePercent(),
		"memoryUsed":   memUsed(),
		"memoryTotal":  memTotal(),
		"networkIn":    netBytes(0),
		"networkOut":   netBytes(1),
		"diskUsage":    diskUsage(),
		"diskUsed":     diskBytes("used"),
		"diskTotal":    diskBytes("total"),
		"uptime":       uptime(),
		"cpuInfo":      cpuInfo(),
		"agentVersion": Version,
	}
	var resp heartbeatResp
	if err := post(cfg, "/api/agent/heartbeat", payload, &resp); err != nil {
		return cfg.Interval, err
	}
	for _, a := range resp.Actions {
		go handleAction(cfg, a)
	}
	for _, t := range resp.SelfTests {
		go handleSelfTest(cfg, t)
	}
	syncRunningRuleState(resp.RunningRules)
	for _, r := range resp.RunningRules {
		writeRunningRuleState(r)
		ensureCountingChains(r.SourcePort)
	}
	collectTraffic(cfg)
	if lastTCPingAt.IsZero() || time.Since(lastTCPingAt) >= time.Minute {
		collectTCPing(cfg, resp.TunnelProbes)
		lastTCPingAt = time.Now()
	}
	if resp.AgentUpgrade != nil {
		go selfUpgrade(cfg, resp.AgentUpgrade)
	}
	return resp.NextInterval, nil
}

func selfTestPoller(cfg Config) {
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		var resp selfTestResp
		if err := post(cfg, "/api/agent/selftest-pull", map[string]any{}, &resp); err != nil {
			logf("selftest pull error: %v", err)
			continue
		}
		for _, t := range resp.SelfTests {
			go handleSelfTest(cfg, t)
		}
	}
}

func handleSelfTest(cfg Config, t selfTest) {
	start := time.Now()
	target := net.JoinHostPort(t.TargetIP, strconv.Itoa(t.TargetPort))
	conn, err := net.DialTimeout("tcp", target, 3*time.Second)
	latency := int(time.Since(start).Milliseconds())
	reachable := err == nil
	msg := ""
	if err == nil {
		_ = conn.Close()
		if latency < 1 {
			latency = 1
		}
		msg = fmt.Sprintf("目标 %s TCP可达, 延迟 %dms", target, latency)
	} else {
		latency = 0
		msg = fmt.Sprintf("目标 %s TCP不可�? %v", target, err)
	}
	payload := map[string]any{
		"testId":          t.TestID,
		"targetReachable": reachable,
		"latencyMs":       latency,
		"message":         msg,
	}
	if err := post(cfg, "/api/agent/selftest-result", payload, &map[string]any{}); err != nil {
		logf("selftest report failed test=%d target=%s: %v", t.TestID, target, err)
	}
}

func agentEventStream(cfg Config) {
	for {
		if err := runAgentEventStream(cfg); err != nil {
			logf("agent event stream error: %v", err)
			time.Sleep(3 * time.Second)
		}
	}
}

func runAgentEventStream(cfg Config) error {
	req, err := http.NewRequest("GET", cfg.PanelURL+"/api/agent/events", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("X-Agent-Version", Version)

	client := &http.Client{Timeout: 0}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("event stream status: %s", resp.Status)
	}

	scanner := bufio.NewScanner(resp.Body)
	var eventName string
	var data strings.Builder
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if eventName == "agent-upgrade" && data.Len() > 0 {
				var up agentUpgrade
				if err := json.Unmarshal([]byte(data.String()), &up); err != nil {
					logf("decode agent upgrade event: %v", err)
				} else {
					go selfUpgrade(cfg, &up)
				}
			} else if eventName == "agent-refresh" {
				go func() {
					if _, err := heartbeat(cfg); err != nil {
						logf("agent refresh heartbeat error: %v", err)
					}
				}()
			}
			eventName = ""
			data.Reset()
			continue
		}
		if strings.HasPrefix(line, "event:") {
			eventName = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		} else if strings.HasPrefix(line, "data:") {
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	return scanner.Err()
}

func handleAction(cfg Config, a action) {
	ok := true
	logf("action start op=%s statusType=%s rule=%d tunnel=%d forwardType=%s port=%d protocol=%s", a.Op, a.StatusType, a.RuleID, a.TunnelID, a.ForwardType, a.SourcePort, a.Protocol)
	if a.Op == "apply" {
		if a.Unit != "" && a.ServiceName != "" {
			ok = writeUnitAndRestart(a.ServiceName, a.Unit) && ok
		}
		if a.UnitExtra != "" && a.ServiceNameExtra != "" {
			ok = writeUnitAndRestart(a.ServiceNameExtra, a.UnitExtra) && ok
		}
		for _, cmd := range a.Commands {
			ok = runShell(cmd) && ok
		}
		if a.Fxp != nil {
			fxpOK := startFXP(*a.Fxp)
			logf("action fxp role=%s tunnel=%d rule=%d listen=%d protocol=%s ok=%v", a.Fxp.Role, a.Fxp.TunnelID, a.Fxp.RuleID, a.Fxp.ListenPort, a.Fxp.Protocol, fxpOK)
			ok = fxpOK && ok
		}
		writeState(a)
	} else {
		if a.Fxp != nil {
			stopFXP(*a.Fxp)
		}
		for _, cmd := range a.Commands {
			ok = runShell(cmd) && ok
		}
		removeState(a.SourcePort)
	}
	running := ok && a.Op == "apply"
	payload := map[string]any{"ruleId": a.RuleID, "tunnelId": a.TunnelID, "statusType": a.StatusType, "isRunning": running}
	var out map[string]any
	if err := post(cfg, "/api/agent/rule-status", payload, &out); err != nil {
		logf("rule-status report failed statusType=%s rule=%d tunnel=%d running=%v: %v", a.StatusType, a.RuleID, a.TunnelID, running, err)
	} else {
		logf("rule-status report ok statusType=%s rule=%d tunnel=%d running=%v", a.StatusType, a.RuleID, a.TunnelID, running)
	}
}

func writeUnitAndRestart(name, unit string) bool {
	path := "/etc/systemd/system/" + name + ".service"
	if err := os.WriteFile(path, []byte(unit), 0644); err != nil {
		logf("write unit %s: %v", name, err)
		return false
	}
	return runShell("systemctl daemon-reload") &&
		runShell("systemctl enable "+name+".service") &&
		runShell("systemctl restart "+name+".service")
}

func writeState(a action) {
	_ = os.MkdirAll("/var/lib/forwardx-agent", 0755)
	port := strconv.Itoa(a.SourcePort)
	_ = os.WriteFile("/var/lib/forwardx-agent/port_"+port+".rule", []byte(strconv.Itoa(a.RuleID)), 0644)
	_ = os.WriteFile("/var/lib/forwardx-agent/port_"+port+".fwtype", []byte(a.ForwardType), 0644)
	if a.TargetIP != "" && a.TargetPort > 0 {
		_ = os.WriteFile("/var/lib/forwardx-agent/target_"+port+".info", []byte(fmt.Sprintf("%s\n%d\n", a.TargetIP, a.TargetPort)), 0644)
	}
}

func writeRunningRuleState(r runningRule) {
	if r.RuleID <= 0 || r.SourcePort <= 0 {
		return
	}
	_ = os.MkdirAll("/var/lib/forwardx-agent", 0755)
	port := strconv.Itoa(r.SourcePort)
	_ = os.WriteFile("/var/lib/forwardx-agent/port_"+port+".rule", []byte(strconv.Itoa(r.RuleID)), 0644)
	_ = os.WriteFile("/var/lib/forwardx-agent/port_"+port+".fwtype", []byte(r.ForwardType), 0644)
	if r.TargetIP != "" && r.TargetPort > 0 {
		_ = os.WriteFile("/var/lib/forwardx-agent/target_"+port+".info", []byte(fmt.Sprintf("%s\n%d\n", r.TargetIP, r.TargetPort)), 0644)
	}
}

func readRuleIDByPort(port string) int {
	b, err := os.ReadFile("/var/lib/forwardx-agent/port_" + port + ".rule")
	if err != nil {
		return 0
	}
	id, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return id
}

func readForwardTypeByPort(port string) string {
	b, err := os.ReadFile("/var/lib/forwardx-agent/port_" + port + ".fwtype")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func syncRunningRuleState(rules []runningRule) {
	wanted := map[string]bool{}
	for _, r := range rules {
		if r.RuleID <= 0 || r.SourcePort <= 0 {
			continue
		}
		wanted[strconv.Itoa(r.SourcePort)] = true
	}
	files, _ := os.ReadDir("/var/lib/forwardx-agent")
	for _, f := range files {
		name := f.Name()
		if !strings.HasPrefix(name, "port_") || !strings.HasSuffix(name, ".rule") {
			continue
		}
		port := strings.TrimSuffix(strings.TrimPrefix(name, "port_"), ".rule")
		if !wanted[port] {
			reconcileRemovePort(port)
			removeStateByPort(port)
		}
	}
}

func reconcileRemovePort(port string) {
	if port == "" {
		return
	}
	ruleID := readRuleIDByPort(port)
	forwardType := readForwardTypeByPort(port)
	logf("reconcile remove stale local rule port=%s rule=%d forwardType=%s", port, ruleID, forwardType)
	if forwardType == "forwardx" && ruleID > 0 {
		stopFXP(fxpSpec{Role: "entry", RuleID: ruleID, ListenPort: atoi(port), Protocol: "both"})
	}
	for _, cmd := range managedPortCleanupCmds(port) {
		_ = runShell(cmd)
	}
}

func managedPortCleanupCmds(port string) []string {
	return []string{
		"systemctl stop forwardx-socat-" + port + ".service forwardx-socat-tcp-" + port + ".service forwardx-socat-udp-" + port + ".service forwardx-realm-" + port + ".service 2>/dev/null || true",
		"systemctl disable forwardx-socat-" + port + ".service forwardx-socat-tcp-" + port + ".service forwardx-socat-udp-" + port + ".service forwardx-realm-" + port + ".service 2>/dev/null || true",
		"rm -f /etc/systemd/system/forwardx-socat-" + port + ".service /etc/systemd/system/forwardx-socat-tcp-" + port + ".service /etc/systemd/system/forwardx-socat-udp-" + port + ".service /etc/systemd/system/forwardx-realm-" + port + ".service",
		"systemctl daemon-reload",
		"rm -f /var/lib/forwardx-agent/traffic_" + port + ".prev /var/lib/forwardx-agent/port_" + port + ".rule /var/lib/forwardx-agent/port_" + port + ".fwtype /var/lib/forwardx-agent/target_" + port + ".info 2>/dev/null || true",
		"iptables -t mangle -D PREROUTING -p tcp --dport " + port + " -j FWX_IN_" + port + " 2>/dev/null || true",
		"iptables -t mangle -D PREROUTING -p udp --dport " + port + " -j FWX_IN_" + port + " 2>/dev/null || true",
		"iptables -t mangle -D POSTROUTING -p tcp --sport " + port + " -j FWX_OUT_" + port + " 2>/dev/null || true",
		"iptables -t mangle -D POSTROUTING -p udp --sport " + port + " -j FWX_OUT_" + port + " 2>/dev/null || true",
		"iptables -t mangle -D INPUT -p tcp --dport " + port + " -j FWX_IN_" + port + " 2>/dev/null || true",
		"iptables -t mangle -D INPUT -p udp --dport " + port + " -j FWX_IN_" + port + " 2>/dev/null || true",
		"iptables -t mangle -D OUTPUT -p tcp --sport " + port + " -j FWX_OUT_" + port + " 2>/dev/null || true",
		"iptables -t mangle -D OUTPUT -p udp --sport " + port + " -j FWX_OUT_" + port + " 2>/dev/null || true",
		"iptables -t mangle -F FWX_IN_" + port + " 2>/dev/null || true",
		"iptables -t mangle -X FWX_IN_" + port + " 2>/dev/null || true",
		"iptables -t mangle -F FWX_OUT_" + port + " 2>/dev/null || true",
		"iptables -t mangle -X FWX_OUT_" + port + " 2>/dev/null || true",
	}
}

func removeStateByPort(port string) {
	_ = os.Remove("/var/lib/forwardx-agent/port_" + port + ".rule")
	_ = os.Remove("/var/lib/forwardx-agent/port_" + port + ".fwtype")
	_ = os.Remove("/var/lib/forwardx-agent/target_" + port + ".info")
	_ = os.Remove("/var/lib/forwardx-agent/traffic_" + port + ".prev")
}

func atoi(s string) int {
	v, _ := strconv.Atoi(strings.TrimSpace(s))
	return v
}

func ensureCountingChains(port int) {
	if port <= 0 {
		return
	}
	p := strconv.Itoa(port)
	commands := []string{
		"iptables -t mangle -N FWX_IN_" + p + " 2>/dev/null || true",
		"iptables -t mangle -N FWX_OUT_" + p + " 2>/dev/null || true",
		"iptables -t mangle -C PREROUTING -p tcp --dport " + p + " -j FWX_IN_" + p + " 2>/dev/null || iptables -t mangle -A PREROUTING -p tcp --dport " + p + " -j FWX_IN_" + p,
		"iptables -t mangle -C PREROUTING -p udp --dport " + p + " -j FWX_IN_" + p + " 2>/dev/null || iptables -t mangle -A PREROUTING -p udp --dport " + p + " -j FWX_IN_" + p,
		"iptables -t mangle -C POSTROUTING -p tcp --sport " + p + " -j FWX_OUT_" + p + " 2>/dev/null || iptables -t mangle -A POSTROUTING -p tcp --sport " + p + " -j FWX_OUT_" + p,
		"iptables -t mangle -C POSTROUTING -p udp --sport " + p + " -j FWX_OUT_" + p + " 2>/dev/null || iptables -t mangle -A POSTROUTING -p udp --sport " + p + " -j FWX_OUT_" + p,
		"iptables -t mangle -C INPUT -p tcp --dport " + p + " -j FWX_IN_" + p + " 2>/dev/null || iptables -t mangle -A INPUT -p tcp --dport " + p + " -j FWX_IN_" + p,
		"iptables -t mangle -C INPUT -p udp --dport " + p + " -j FWX_IN_" + p + " 2>/dev/null || iptables -t mangle -A INPUT -p udp --dport " + p + " -j FWX_IN_" + p,
		"iptables -t mangle -C OUTPUT -p tcp --sport " + p + " -j FWX_OUT_" + p + " 2>/dev/null || iptables -t mangle -A OUTPUT -p tcp --sport " + p + " -j FWX_OUT_" + p,
		"iptables -t mangle -C OUTPUT -p udp --sport " + p + " -j FWX_OUT_" + p + " 2>/dev/null || iptables -t mangle -A OUTPUT -p udp --sport " + p + " -j FWX_OUT_" + p,
	}
	for _, cmd := range commands {
		_ = runShell(cmd)
	}
}

func removeState(port int) {
	p := strconv.Itoa(port)
	_ = os.Remove("/var/lib/forwardx-agent/port_" + p + ".rule")
	_ = os.Remove("/var/lib/forwardx-agent/port_" + p + ".fwtype")
	_ = os.Remove("/var/lib/forwardx-agent/target_" + p + ".info")
	_ = os.Remove("/var/lib/forwardx-agent/traffic_" + p + ".prev")
}

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
		in := iptablesBytes("FWX_IN_" + port)
		out := iptablesBytes("FWX_OUT_" + port)
		prevIn, prevOut := readPrev(port)
		din, dout := delta(in, prevIn), delta(out, prevOut)
		writePrev(port, in, out)
		conns := conntrackConnections(port)
		if din > 0 || dout > 0 || conns > 0 {
			stats = append(stats, map[string]any{"ruleId": ruleID, "bytesIn": din, "bytesOut": dout, "connections": conns})
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

func collectTCPing(cfg Config, probes []tunnelProbe) {
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
		if reachable {
			result["latencyMs"] = latency
			result["isTimeout"] = false
		} else {
			result["latencyMs"] = 0
			result["isTimeout"] = true
		}
		tunnels = append(tunnels, result)
	}
	if len(results) > 0 || len(tunnels) > 0 {
		_ = post(cfg, "/api/agent/tcping", map[string]any{"results": results, "tunnels": tunnels}, &map[string]any{})
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

func conntrackConnections(port string) uint64 {
	cmd := fmt.Sprintf(`awk -v p="dport=%s" 'index($0,p" ")>0 {c++} END{print c+0}' /proc/net/nf_conntrack 2>/dev/null`, port)
	out, err := exec.Command("sh", "-lc", cmd).Output()
	if err != nil {
		return 0
	}
	v, _ := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
	return v
}

func iptablesBytes(chain string) uint64 {
	parentChains := "PREROUTING INPUT"
	if strings.HasPrefix(chain, "FWX_OUT_") {
		parentChains = "POSTROUTING OUTPUT"
	}
	cmd := fmt.Sprintf(`for c in %s; do iptables -t mangle -nvxL "$c" 2>/dev/null; done | awk -v ch=%s '$0 ~ ch {s+=$2} END{print s+0}'`, parentChains, shellQuote(chain))
	out, err := exec.Command("sh", "-lc", cmd).Output()
	if err != nil {
		return 0
	}
	v, _ := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
	return v
}

func readPrev(port string) (uint64, uint64) {
	b, err := os.ReadFile("/var/lib/forwardx-agent/traffic_" + port + ".prev")
	if err != nil {
		return 0, 0
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) < 2 {
		return 0, 0
	}
	a, _ := strconv.ParseUint(strings.TrimSpace(lines[0]), 10, 64)
	c, _ := strconv.ParseUint(strings.TrimSpace(lines[1]), 10, 64)
	return a, c
}

func writePrev(port string, in, out uint64) {
	_ = os.WriteFile("/var/lib/forwardx-agent/traffic_"+port+".prev", []byte(fmt.Sprintf("%d\n%d\n", in, out)), 0644)
}

func delta(cur, prev uint64) uint64 {
	if cur >= prev {
		return cur - prev
	}
	return cur
}

type fxpProcess struct {
	signature  string
	cmd        *exec.Cmd
	configPath string
}

func fxpServerID(spec fxpSpec) string {
	return spec.Role + ":" + strconv.Itoa(spec.TunnelID) + ":" + strconv.Itoa(spec.RuleID) + ":" + strconv.Itoa(spec.ListenPort)
}

func fxpServerSignature(spec fxpSpec) string {
	return strings.Join([]string{
		spec.Role,
		strconv.Itoa(spec.TunnelID),
		strconv.Itoa(spec.RuleID),
		strconv.Itoa(spec.ListenPort),
		spec.Protocol,
		spec.ExitHost,
		strconv.Itoa(spec.ExitPort),
		spec.TargetIP,
		strconv.Itoa(spec.TargetPort),
		spec.Key,
		strconv.FormatInt(spec.LimitIn, 10),
		strconv.FormatInt(spec.LimitOut, 10),
		strconv.Itoa(spec.MaxConnections),
		strconv.Itoa(spec.MaxIPs),
		spec.AccessScope,
	}, "|")
}

func startFXP(spec fxpSpec) bool {
	if spec.Key == "" || spec.ListenPort <= 0 {
		logf("fxp invalid config role=%s tunnel=%d rule=%d port=%d", spec.Role, spec.TunnelID, spec.RuleID, spec.ListenPort)
		return false
	}
	runtimePath, err := exec.LookPath("forwardx-fxp")
	if err != nil {
		for _, p := range []string{"/usr/local/bin/forwardx-fxp", "/opt/forwardx-agent/forwardx-fxp"} {
			if st, statErr := os.Stat(p); statErr == nil && !st.IsDir() {
				runtimePath = p
				err = nil
				break
			}
		}
	}
	if err != nil || runtimePath == "" {
		logf("fxp runtime missing: install /usr/local/bin/forwardx-fxp to use custom encrypted tunnels")
		return false
	}

	id := fxpServerID(spec)
	signature := fxpServerSignature(spec)
	fxpMu.Lock()
	existing := fxpServers[id]
	if existing != nil && existing.signature == signature && existing.cmd != nil && existing.cmd.Process != nil {
		fxpMu.Unlock()
		logf("fxp %s already running tunnel=%d rule=%d listen=:%d protocol=%s", spec.Role, spec.TunnelID, spec.RuleID, spec.ListenPort, spec.Protocol)
		return true
	}
	fxpMu.Unlock()
	stopFXP(spec)

	if err := os.MkdirAll("/run/forwardx-agent", 0700); err != nil {
		logf("fxp create runtime dir failed: %v", err)
		return false
	}
	configPath := fmt.Sprintf("/run/forwardx-agent/fxp-%s-%d-%d-%d.json", spec.Role, spec.TunnelID, spec.RuleID, spec.ListenPort)
	cfgBytes, err := json.Marshal(spec)
	if err != nil {
		logf("fxp marshal config failed: %v", err)
		return false
	}
	if err := os.WriteFile(configPath, cfgBytes, 0600); err != nil {
		logf("fxp write config failed: %v", err)
		return false
	}

	cmd := exec.Command(runtimePath, "-config", configPath)
	cmd.Stdout = fxpLogWriter{}
	cmd.Stderr = fxpLogWriter{}
	if err := cmd.Start(); err != nil {
		_ = os.Remove(configPath)
		logf("fxp runtime start failed: %v", err)
		return false
	}

	fxpMu.Lock()
	fxpServers[id] = &fxpProcess{signature: signature, cmd: cmd, configPath: configPath}
	fxpMu.Unlock()
	go func() {
		err := cmd.Wait()
		fxpMu.Lock()
		current := fxpServers[id]
		if current != nil && current.cmd == cmd {
			delete(fxpServers, id)
		}
		fxpMu.Unlock()
		if err != nil {
			logf("fxp runtime exited tunnel=%d rule=%d: %v", spec.TunnelID, spec.RuleID, err)
		}
	}()
	logf("fxp %s started tunnel=%d rule=%d listen=:%d protocol=%s runtime=%s", spec.Role, spec.TunnelID, spec.RuleID, spec.ListenPort, spec.Protocol, runtimePath)
	return true
}

func stopFXP(spec fxpSpec) {
	id := fxpServerID(spec)
	fxpMu.Lock()
	s := fxpServers[id]
	if s != nil {
		delete(fxpServers, id)
	}
	fxpMu.Unlock()
	if s == nil {
		return
	}
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Signal(os.Interrupt)
		time.Sleep(500 * time.Millisecond)
		_ = s.cmd.Process.Kill()
	}
	if s.configPath != "" {
		_ = os.Remove(s.configPath)
	}
}

type fxpLogWriter struct{}

func (fxpLogWriter) Write(p []byte) (int, error) {
	msg := strings.TrimSpace(string(p))
	if msg != "" {
		logf("fxp runtime: %s", msg)
	}
	return len(p), nil
}

func selfUpgrade(cfg Config, up *agentUpgrade) {
	if !atomic.CompareAndSwapInt32(&upgradeStarted, 0, 1) {
		logf("self-upgrade already started, ignoring duplicate request")
		return
	}
	panel := strings.TrimRight(up.PanelURL, "/")
	if panel == "" {
		panel = cfg.PanelURL
	}
	upgradeCmd := fmt.Sprintf(`sleep 1; curl -fsSL --max-time 30 "%s/api/agent/install.sh" | PANEL_URL="%s" bash -s -- upgrade %s`, panel, panel, shellQuote(cfg.Token))
	cmd := fmt.Sprintf(`if command -v systemd-run >/dev/null 2>&1; then systemd-run --unit=forwardx-agent-upgrade --collect /bin/sh -lc %s; else nohup sh -lc %s >/var/log/forwardx-agent/agent-upgrade.log 2>&1 < /dev/null & fi`, shellQuote(upgradeCmd), shellQuote(upgradeCmd))
	logf("self-upgrade requested target=%s", up.TargetVersion)
	_ = runShell(cmd)
}

func post(cfg Config, path string, payload any, out any) error {
	env, err := encrypt(payload, cfg.Token)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(env)
	req, err := http.NewRequest("POST", cfg.PanelURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("X-Agent-Encrypted", "1")
	client := &http.Client{Timeout: 60 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	resBody, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 300 {
		return fmt.Errorf("%s: %s", res.Status, string(resBody))
	}
	var respEnv envelope
	if err := json.Unmarshal(resBody, &respEnv); err == nil && respEnv.V == 1 {
		plain, err := decrypt(respEnv, cfg.Token)
		if err != nil {
			return err
		}
		return json.Unmarshal(plain, out)
	}
	return json.Unmarshal(resBody, out)
}

func encrypt(payload any, token string) (envelope, error) {
	plain, _ := json.Marshal(payload)
	keyEnc := sha256.Sum256([]byte(token + "|forwardx-agent-v1"))
	keyMac := sha256.Sum256([]byte(token + "|forwardx-agent-mac"))
	iv := make([]byte, aes.BlockSize)
	if _, err := rand.Read(iv); err != nil {
		return envelope{}, err
	}
	block, err := aes.NewCipher(keyEnc[:])
	if err != nil {
		return envelope{}, err
	}
	ct := make([]byte, len(plain))
	cipher.NewCTR(block, iv).XORKeyStream(ct, plain)
	ts := time.Now().UnixMilli()
	mac := calcMAC(keyMac[:], iv, ct, ts)
	return envelope{V: 1, IV: hex.EncodeToString(iv), CT: hex.EncodeToString(ct), MAC: hex.EncodeToString(mac), TS: ts}, nil
}

func decrypt(env envelope, token string) ([]byte, error) {
	keyEnc := sha256.Sum256([]byte(token + "|forwardx-agent-v1"))
	keyMac := sha256.Sum256([]byte(token + "|forwardx-agent-mac"))
	iv, err := hex.DecodeString(env.IV)
	if err != nil {
		return nil, err
	}
	ct, err := hex.DecodeString(env.CT)
	if err != nil {
		return nil, err
	}
	got, _ := hex.DecodeString(env.MAC)
	want := calcMAC(keyMac[:], iv, ct, env.TS)
	if !hmac.Equal(got, want) {
		return nil, fmt.Errorf("mac verification failed")
	}
	block, err := aes.NewCipher(keyEnc[:])
	if err != nil {
		return nil, err
	}
	plain := make([]byte, len(ct))
	cipher.NewCTR(block, iv).XORKeyStream(plain, ct)
	return plain, nil
}

func calcMAC(key, iv, ct []byte, ts int64) []byte {
	buf := bytes.NewBufferString("v1")
	buf.Write(iv)
	buf.Write(ct)
	tsb := make([]byte, 8)
	binary.BigEndian.PutUint64(tsb, uint64(ts))
	buf.Write(tsb)
	m := hmac.New(sha256.New, key)
	m.Write(buf.Bytes())
	return m.Sum(nil)
}

func runShell(cmd string) bool {
	logf("exec: %s", cmd)
	c := exec.Command("sh", "-lc", cmd)
	out, err := c.CombinedOutput()
	if len(out) > 0 {
		logf("%s", strings.TrimSpace(string(out)))
	}
	if err != nil {
		logf("exec failed: %v", err)
		return false
	}
	return true
}

func osInfo() string {
	if b, err := os.ReadFile("/etc/os-release"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(line, "PRETTY_NAME=") {
				return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"`)
			}
		}
	}
	return runtime.GOOS + "/" + runtime.GOARCH
}

func publicIPs() (string, string) {
	ipv4 := fetchPublicIP([]string{
		"https://api.ipify.org",
		"https://ipv4.icanhazip.com",
		"https://v4.ident.me",
	})
	ipv6 := fetchPublicIP([]string{
		"https://api6.ipify.org",
		"https://ipv6.icanhazip.com",
		"https://v6.ident.me",
	})
	return ipv4, ipv6
}

func fetchPublicIP(urls []string) string {
	for _, u := range urls {
		c := &http.Client{Timeout: 5 * time.Second}
		if res, err := c.Get(u); err == nil {
			b, _ := io.ReadAll(res.Body)
			res.Body.Close()
			ip := strings.TrimSpace(string(b))
			if net.ParseIP(ip) != nil {
				return ip
			}
		}
	}
	return ""
}

func readMeminfo() map[string]uint64 {
	out := map[string]uint64{}
	b, _ := os.ReadFile("/proc/meminfo")
	for _, line := range strings.Split(string(b), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 {
			v, _ := strconv.ParseUint(fields[1], 10, 64)
			out[strings.TrimSuffix(fields[0], ":")] = v * 1024
		}
	}
	return out
}

func memTotal() uint64 { return readMeminfo()["MemTotal"] }
func memUsed() uint64 {
	m := readMeminfo()
	return m["MemTotal"] - m["MemAvailable"]
}
func memUsagePercent() int {
	total := memTotal()
	if total == 0 {
		return 0
	}
	return int(memUsed() * 100 / total)
}

func uptime() int64 {
	b, _ := os.ReadFile("/proc/uptime")
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	return int64(v)
}

func cpuInfo() string {
	model := ""
	cores := runtime.NumCPU()
	if b, err := os.ReadFile("/proc/cpuinfo"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(line, "model name") {
				parts := strings.SplitN(line, ":", 2)
				if len(parts) == 2 {
					model = strings.TrimSpace(parts[1])
				}
				break
			}
		}
	}
	if model == "" {
		model = "Unknown CPU"
	}
	coreLabel := "Virtual Cores"
	if cores == 1 {
		coreLabel = "Virtual Core"
	}
	if cores > 0 {
		return fmt.Sprintf("%s %d %s", model, cores, coreLabel)
	}
	return model
}

func cpuUsage() int {
	b, _ := os.ReadFile("/proc/loadavg")
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	return int(v)
}

func netBytes(idx int) uint64 {
	b, _ := os.ReadFile("/proc/net/dev")
	var total uint64
	for _, line := range strings.Split(string(b), "\n") {
		if !strings.Contains(line, ":") || strings.Contains(line, "lo:") {
			continue
		}
		parts := strings.Fields(strings.ReplaceAll(line, ":", " "))
		if len(parts) > 9 {
			if idx == 0 {
				v, _ := strconv.ParseUint(parts[1], 10, 64)
				total += v
			} else {
				v, _ := strconv.ParseUint(parts[9], 10, 64)
				total += v
			}
		}
	}
	return total
}

func diskUsage() int {
	out, err := exec.Command("sh", "-lc", `df -P / | awk 'NR==2 {gsub("%","",$5); print $5}'`).Output()
	if err != nil {
		return 0
	}
	v, _ := strconv.Atoi(strings.TrimSpace(string(out)))
	return v
}

func diskBytes(kind string) uint64 {
	col := "$2"
	if kind == "used" {
		col = "$3"
	}
	out, err := exec.Command("sh", "-lc", fmt.Sprintf(`df -P -B1 / | awk 'NR==2 {print %s}'`, col)).Output()
	if err != nil {
		return 0
	}
	v, _ := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
	return v
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'"
}

func logf(format string, args ...any) {
	_ = os.MkdirAll("/var/log/forwardx-agent", 0755)
	line := time.Now().Format(time.RFC3339) + " " + fmt.Sprintf(format, args...) + "\n"
	fmt.Print(line)
	f, err := os.OpenFile("/var/log/forwardx-agent/agent-go.log", os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err == nil {
		defer f.Close()
		_, _ = f.WriteString(line)
	}
}

func fatal(format string, args ...any) {
	logf(format, args...)
	os.Exit(1)
}
