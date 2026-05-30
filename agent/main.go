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
	"errors"
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

var Version = "2.2.57"
var upgradeStarted int32
var fxpMu sync.Mutex
var fxpServers = map[string]*fxpProcess{}
var protocolGuardMu sync.Mutex
var protocolGuards = map[string]*protocolGuardServer{}
var lastTCPingAt time.Time
var agentLogUploadEnabled atomic.Bool
var agentLogMu sync.Mutex
var agentLogBuffer []agentLogEntry

type agentLogEntry struct {
	Level     string `json:"level"`
	Message   string `json:"message"`
	CreatedAt string `json:"createdAt"`
}

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
	GuardRules   []guardRule   `json:"guardRules"`
	AgentUpgrade *agentUpgrade `json:"agentUpgrade"`
	LogUpload    bool          `json:"agentLogUploadEnabled"`
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
	HopIndex   int    `json:"hopIndex"`
	HopCount   int    `json:"hopCount"`
}

type agentUpgrade struct {
	TargetVersion string `json:"targetVersion"`
	PanelURL      string `json:"panelUrl"`
}

type migratedPanelError struct {
	PanelURL string
}

func (e migratedPanelError) Error() string {
	return "panel migrated to " + e.PanelURL
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
	Role           string `json:"role"`
	TunnelID       int    `json:"tunnelId"`
	RuleID         int    `json:"ruleId"`
	ListenPort     int    `json:"listenPort"`
	Protocol       string `json:"protocol"`
	ExitHost       string `json:"exitHost"`
	ExitPort       int    `json:"exitPort"`
	TargetIP       string `json:"targetIp"`
	TargetPort     int    `json:"targetPort"`
	Key            string `json:"key"`
	LimitIn        int64  `json:"limitIn"`
	LimitOut       int64  `json:"limitOut"`
	MaxConnections int    `json:"maxConnections"`
	MaxIPs         int    `json:"maxIPs"`
	AccessScope    string `json:"accessScope"`
	BlockHTTP      bool   `json:"blockHttp"`
	BlockSocks     bool   `json:"blockSocks"`
	BlockTLS       bool   `json:"blockTls"`
	PanelURL       string `json:"panelUrl,omitempty"`
	Token          string `json:"token,omitempty"`
	FXPVersion     int    `json:"fxpVersion,omitempty"`
	RelayExitHost  string `json:"relayExitHost,omitempty"`
	RelayExitPort  int    `json:"relayExitPort,omitempty"`
	RelayKey       string `json:"relayKey,omitempty"`
}

type protocolPolicy struct {
	BlockHTTP  bool `json:"blockHttp"`
	BlockSocks bool `json:"blockSocks"`
	BlockTLS   bool `json:"blockTls"`
}

type guardRule struct {
	RuleID     int            `json:"ruleId"`
	TunnelID   int            `json:"tunnelId"`
	ListenPort int            `json:"listenPort"`
	TargetIP   string         `json:"targetIp"`
	TargetPort int            `json:"targetPort"`
	Policy     protocolPolicy `json:"policy"`
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
		var migrated migratedPanelError
		if errors.As(err, &migrated) {
			go selfUpgrade(cfg, &agentUpgrade{TargetVersion: "9999.0.0", PanelURL: migrated.PanelURL})
			return cfg.Interval, nil
		}
		return cfg.Interval, err
	}
	if resp.AgentUpgrade != nil {
		go selfUpgrade(cfg, resp.AgentUpgrade)
	}
	agentLogUploadEnabled.Store(resp.LogUpload)
	for _, a := range resp.Actions {
		go handleAction(cfg, a)
	}
	for _, t := range resp.SelfTests {
		go handleSelfTest(cfg, t)
	}
	syncRunningRuleState(resp.RunningRules)
	for _, r := range resp.RunningRules {
		writeRunningRuleState(r)
		if r.ForwardType != "nftables" {
			ensureCountingChains(r.SourcePort, r.TargetIP, r.TargetPort, r.Protocol)
		}
	}
	syncProtocolGuards(cfg, resp.GuardRules)
	collectTraffic(cfg)
	if lastTCPingAt.IsZero() || time.Since(lastTCPingAt) >= time.Minute {
		collectTCPing(cfg, resp.TunnelProbes)
		lastTCPingAt = time.Now()
	}
	flushAgentLogs(cfg)
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
		msg = fmt.Sprintf("目标 %s TCP可达，延迟 %dms", target, latency)
	} else {
		latency = 0
		msg = fmt.Sprintf("目标 %s TCP不可达：%v", target, err)
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
	actionMessage := &actionMessage{}
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
			fxpOK := startFXP(cfg, *a.Fxp, actionMessage)
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
	message := actionMessage.get()
	payload := map[string]any{"ruleId": a.RuleID, "tunnelId": a.TunnelID, "statusType": a.StatusType, "isRunning": running, "message": message}
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
	resetTrafficStateIfRuleChanged(port, a.RuleID)
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
	resetTrafficStateIfRuleChanged(port, r.RuleID)
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

func resetTrafficStateIfRuleChanged(port string, nextRuleID int) {
	if port == "" || nextRuleID <= 0 {
		return
	}
	currentRuleID := readRuleIDByPort(port)
	if currentRuleID > 0 && currentRuleID != nextRuleID {
		_ = os.Remove("/var/lib/forwardx-agent/traffic_" + port + ".prev")
		logf("traffic baseline reset port=%s oldRule=%d newRule=%d", port, currentRuleID, nextRuleID)
	}
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
	if forwardType == "nftables" && ruleID > 0 {
		_ = runShell("nft list table inet forwardx >/dev/null 2>&1 && { for h in $(nft -a list chain inet forwardx prerouting 2>/dev/null | awk -v c=\"fwx-rule-" + strconv.Itoa(ruleID) + "\" '$0 ~ c {print $NF}'); do nft delete rule inet forwardx prerouting handle \"$h\" 2>/dev/null || true; done; for h in $(nft -a list chain inet forwardx postrouting 2>/dev/null | awk -v c=\"fwx-rule-" + strconv.Itoa(ruleID) + "\" '$0 ~ c {print $NF}'); do nft delete rule inet forwardx postrouting handle \"$h\" 2>/dev/null || true; done; for h in $(nft -a list chain inet forwardx forward 2>/dev/null | awk -v c=\"fwx-rule-" + strconv.Itoa(ruleID) + "\" '$0 ~ c {print $NF}'); do nft delete rule inet forwardx forward handle \"$h\" 2>/dev/null || true; done; nft flush chain inet forwardx in_" + strconv.Itoa(ruleID) + " 2>/dev/null || true; nft delete chain inet forwardx in_" + strconv.Itoa(ruleID) + " 2>/dev/null || true; nft flush chain inet forwardx out_" + strconv.Itoa(ruleID) + " 2>/dev/null || true; nft delete chain inet forwardx out_" + strconv.Itoa(ruleID) + " 2>/dev/null || true; } || true")
	}
	for _, cmd := range managedPortCleanupCmds(port) {
		_ = runShell(cmd)
	}
}

func managedPortCleanupCmds(port string) []string {
	cmds := []string{
		"systemctl stop forwardx-socat-" + port + ".service forwardx-socat-tcp-" + port + ".service forwardx-socat-udp-" + port + ".service forwardx-realm-" + port + ".service 2>/dev/null || true",
		"systemctl disable forwardx-socat-" + port + ".service forwardx-socat-tcp-" + port + ".service forwardx-socat-udp-" + port + ".service forwardx-realm-" + port + ".service 2>/dev/null || true",
		"rm -f /etc/systemd/system/forwardx-socat-" + port + ".service /etc/systemd/system/forwardx-socat-tcp-" + port + ".service /etc/systemd/system/forwardx-socat-udp-" + port + ".service /etc/systemd/system/forwardx-realm-" + port + ".service",
		"systemctl daemon-reload",
		"iptables -t mangle -D PREROUTING -p tcp --dport " + port + " -j FWX_IN_" + port + " 2>/dev/null || true",
		"iptables -t mangle -D PREROUTING -p udp --dport " + port + " -j FWX_IN_" + port + " 2>/dev/null || true",
		"iptables -t mangle -D POSTROUTING -p tcp --sport " + port + " -j FWX_OUT_" + port + " 2>/dev/null || true",
		"iptables -t mangle -D POSTROUTING -p udp --sport " + port + " -j FWX_OUT_" + port + " 2>/dev/null || true",
		"iptables -t mangle -D INPUT -p tcp --dport " + port + " -j FWX_IN_" + port + " 2>/dev/null || true",
		"iptables -t mangle -D INPUT -p udp --dport " + port + " -j FWX_IN_" + port + " 2>/dev/null || true",
		"iptables -t mangle -D OUTPUT -p tcp --sport " + port + " -j FWX_OUT_" + port + " 2>/dev/null || true",
		"iptables -t mangle -D OUTPUT -p udp --sport " + port + " -j FWX_OUT_" + port + " 2>/dev/null || true",
		"iptables -t mangle -D FORWARD -p tcp -j FWX_IN_" + port + " 2>/dev/null || true",
		"iptables -t mangle -D FORWARD -p udp -j FWX_IN_" + port + " 2>/dev/null || true",
		"iptables -t mangle -D FORWARD -p tcp -j FWX_OUT_" + port + " 2>/dev/null || true",
		"iptables -t mangle -D FORWARD -p udp -j FWX_OUT_" + port + " 2>/dev/null || true",
		"iptables -t mangle -F FWX_IN_" + port + " 2>/dev/null || true",
		"iptables -t mangle -X FWX_IN_" + port + " 2>/dev/null || true",
		"iptables -t mangle -F FWX_OUT_" + port + " 2>/dev/null || true",
		"iptables -t mangle -X FWX_OUT_" + port + " 2>/dev/null || true",
		"rm -f /var/lib/forwardx-agent/traffic_" + port + ".prev /var/lib/forwardx-agent/port_" + port + ".rule /var/lib/forwardx-agent/port_" + port + ".fwtype /var/lib/forwardx-agent/target_" + port + ".info 2>/dev/null || true",
	}
	if targetIP, targetPort, ok := readTargetInfo(port); ok {
		tp := strconv.Itoa(targetPort)
		targetCmds := []string{
			"iptables -t mangle -D FORWARD -p tcp -d " + targetIP + " --dport " + tp + " -j FWX_IN_" + port + " 2>/dev/null || true",
			"iptables -t mangle -D FORWARD -p udp -d " + targetIP + " --dport " + tp + " -j FWX_IN_" + port + " 2>/dev/null || true",
			"iptables -t mangle -D FORWARD -p tcp -s " + targetIP + " --sport " + tp + " -j FWX_OUT_" + port + " 2>/dev/null || true",
			"iptables -t mangle -D FORWARD -p udp -s " + targetIP + " --sport " + tp + " -j FWX_OUT_" + port + " 2>/dev/null || true",
		}
		cmds = append(targetCmds, cmds...)
	}
	return cmds
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

func ensureCountingChains(port int, targetIP string, targetPort int, protocol string) {
	if port <= 0 {
		return
	}
	p := strconv.Itoa(port)
	protos := []string{"tcp", "udp"}
	if protocol == "tcp" || protocol == "udp" {
		protos = []string{protocol}
	}
	commands := []string{
		"iptables -t mangle -N FWX_IN_" + p + " 2>/dev/null || true",
		"iptables -t mangle -N FWX_OUT_" + p + " 2>/dev/null || true",
	}
	for _, proto := range protos {
		commands = append(commands,
			"iptables -t mangle -C PREROUTING -p "+proto+" --dport "+p+" -j FWX_IN_"+p+" 2>/dev/null || iptables -t mangle -A PREROUTING -p "+proto+" --dport "+p+" -j FWX_IN_"+p,
			"iptables -t mangle -C INPUT -p "+proto+" --dport "+p+" -j FWX_IN_"+p+" 2>/dev/null || iptables -t mangle -A INPUT -p "+proto+" --dport "+p+" -j FWX_IN_"+p,
			"iptables -t mangle -C POSTROUTING -p "+proto+" --sport "+p+" -j FWX_OUT_"+p+" 2>/dev/null || iptables -t mangle -A POSTROUTING -p "+proto+" --sport "+p+" -j FWX_OUT_"+p,
			"iptables -t mangle -C OUTPUT -p "+proto+" --sport "+p+" -j FWX_OUT_"+p+" 2>/dev/null || iptables -t mangle -A OUTPUT -p "+proto+" --sport "+p+" -j FWX_OUT_"+p,
		)
		if targetIP != "" && targetPort > 0 {
			tp := strconv.Itoa(targetPort)
			commands = append(commands,
				"iptables -t mangle -C OUTPUT -p "+proto+" -d "+targetIP+" --dport "+tp+" -j FWX_IN_"+p+" 2>/dev/null || iptables -t mangle -A OUTPUT -p "+proto+" -d "+targetIP+" --dport "+tp+" -j FWX_IN_"+p,
				"iptables -t mangle -C POSTROUTING -p "+proto+" -d "+targetIP+" --dport "+tp+" -j FWX_IN_"+p+" 2>/dev/null || iptables -t mangle -A POSTROUTING -p "+proto+" -d "+targetIP+" --dport "+tp+" -j FWX_IN_"+p,
				"iptables -t mangle -C PREROUTING -p "+proto+" -s "+targetIP+" --sport "+tp+" -j FWX_OUT_"+p+" 2>/dev/null || iptables -t mangle -A PREROUTING -p "+proto+" -s "+targetIP+" --sport "+tp+" -j FWX_OUT_"+p,
				"iptables -t mangle -C INPUT -p "+proto+" -s "+targetIP+" --sport "+tp+" -j FWX_OUT_"+p+" 2>/dev/null || iptables -t mangle -A INPUT -p "+proto+" -s "+targetIP+" --sport "+tp+" -j FWX_OUT_"+p,
				"iptables -t mangle -C FORWARD -p "+proto+" -d "+targetIP+" --dport "+tp+" -j FWX_IN_"+p+" 2>/dev/null || iptables -t mangle -A FORWARD -p "+proto+" -d "+targetIP+" --dport "+tp+" -j FWX_IN_"+p,
				"iptables -t mangle -C FORWARD -p "+proto+" -s "+targetIP+" --sport "+tp+" -j FWX_OUT_"+p+" 2>/dev/null || iptables -t mangle -A FORWARD -p "+proto+" -s "+targetIP+" --sport "+tp+" -j FWX_OUT_"+p,
			)
		}
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
		forwardType := readForwardTypeByPort(port)
		if forwardType == "forwardx" {
			continue
		}
		in, out := iptablesBytes("FWX_IN_"+port), iptablesBytes("FWX_OUT_"+port)
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
	in := nftablesChainBytes("in_" + strconv.Itoa(ruleID))
	out := nftablesChainBytes("out_" + strconv.Itoa(ruleID))
	return in, out
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

type fxpProcess struct {
	signature  string
	cmd        *exec.Cmd
	configPath string
}

type actionMessage struct {
	mu  sync.Mutex
	msg string
}

func (m *actionMessage) set(format string, args ...any) {
	if m == nil {
		return
	}
	msg := fmt.Sprintf(format, args...)
	m.mu.Lock()
	m.msg = msg
	m.mu.Unlock()
	logf("%s", msg)
}

func (m *actionMessage) remember(format string, args ...any) {
	if m == nil {
		return
	}
	msg := fmt.Sprintf(format, args...)
	m.mu.Lock()
	m.msg = msg
	m.mu.Unlock()
}

func (m *actionMessage) get() string {
	if m == nil {
		return ""
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.msg
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
		strconv.Itoa(spec.FXPVersion),
		strconv.FormatInt(spec.LimitIn, 10),
		strconv.FormatInt(spec.LimitOut, 10),
		strconv.Itoa(spec.MaxConnections),
		strconv.Itoa(spec.MaxIPs),
		spec.AccessScope,
		strconv.FormatBool(spec.BlockHTTP),
		strconv.FormatBool(spec.BlockSocks),
		strconv.FormatBool(spec.BlockTLS),
		spec.RelayExitHost,
		strconv.Itoa(spec.RelayExitPort),
		spec.RelayKey,
	}, "|")
}

func startFXP(cfg Config, spec fxpSpec, actionMessage *actionMessage) bool {
	if spec.Key == "" || spec.ListenPort <= 0 {
		actionMessage.set("fxp invalid config role=%s tunnel=%d rule=%d port=%d", spec.Role, spec.TunnelID, spec.RuleID, spec.ListenPort)
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
		actionMessage.set("fxp runtime missing: install /usr/local/bin/forwardx-fxp to use custom encrypted tunnels")
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
		actionMessage.set("fxp create runtime dir failed: %v", err)
		return false
	}
	configPath := fmt.Sprintf("/run/forwardx-agent/fxp-%s-%d-%d-%d.json", spec.Role, spec.TunnelID, spec.RuleID, spec.ListenPort)
	if spec.Role == "entry" {
		spec.PanelURL = strings.TrimRight(cfg.PanelURL, "/")
		spec.Token = cfg.Token
	}
	cfgBytes, err := json.Marshal(spec)
	if err != nil {
		actionMessage.set("fxp marshal config failed: %v", err)
		return false
	}
	if err := os.WriteFile(configPath, cfgBytes, 0600); err != nil {
		actionMessage.set("fxp write config failed: %v", err)
		return false
	}

	cmd := exec.Command(runtimePath, "-config", configPath)
	cmd.Stdout = fxpLogWriter{message: actionMessage}
	cmd.Stderr = fxpLogWriter{message: actionMessage}
	if err := cmd.Start(); err != nil {
		_ = os.Remove(configPath)
		actionMessage.set("fxp runtime start failed: %v", err)
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

type protocolGuardServer struct {
	rule guardRule
	ln   net.Listener
	done chan struct{}
}

func guardID(rule guardRule) string {
	return strconv.Itoa(rule.RuleID) + ":" + strconv.Itoa(rule.ListenPort)
}

func guardSignature(rule guardRule) string {
	return strings.Join([]string{
		strconv.Itoa(rule.RuleID),
		strconv.Itoa(rule.TunnelID),
		strconv.Itoa(rule.ListenPort),
		rule.TargetIP,
		strconv.Itoa(rule.TargetPort),
		strconv.FormatBool(rule.Policy.BlockHTTP),
		strconv.FormatBool(rule.Policy.BlockSocks),
		strconv.FormatBool(rule.Policy.BlockTLS),
	}, "|")
}

func syncProtocolGuards(cfg Config, rules []guardRule) {
	wanted := map[string]string{}
	for _, rule := range rules {
		if rule.RuleID <= 0 || rule.ListenPort <= 0 || rule.TargetIP == "" || rule.TargetPort <= 0 {
			continue
		}
		id := guardID(rule)
		sig := guardSignature(rule)
		wanted[id] = sig
		protocolGuardMu.Lock()
		existing := protocolGuards[id]
		protocolGuardMu.Unlock()
		if existing != nil && guardSignature(existing.rule) == sig {
			continue
		}
		stopProtocolGuard(id)
		startProtocolGuard(cfg, rule)
	}

	protocolGuardMu.Lock()
	ids := make([]string, 0, len(protocolGuards))
	for id := range protocolGuards {
		if _, ok := wanted[id]; !ok {
			ids = append(ids, id)
		}
	}
	protocolGuardMu.Unlock()
	for _, id := range ids {
		stopProtocolGuard(id)
	}
}

func startProtocolGuard(cfg Config, rule guardRule) {
	ln, err := net.Listen("tcp", ":"+strconv.Itoa(rule.ListenPort))
	if err != nil {
		logf("protocol guard listen failed rule=%d port=%d: %v", rule.RuleID, rule.ListenPort, err)
		return
	}
	server := &protocolGuardServer{rule: rule, ln: ln, done: make(chan struct{})}
	protocolGuardMu.Lock()
	protocolGuards[guardID(rule)] = server
	protocolGuardMu.Unlock()
	go server.serve(cfg)
	logf("protocol guard started rule=%d tunnel=%d listen=:%d target=%s:%d", rule.RuleID, rule.TunnelID, rule.ListenPort, rule.TargetIP, rule.TargetPort)
}

func stopProtocolGuard(id string) {
	protocolGuardMu.Lock()
	server := protocolGuards[id]
	if server != nil {
		delete(protocolGuards, id)
	}
	protocolGuardMu.Unlock()
	if server == nil {
		return
	}
	close(server.done)
	_ = server.ln.Close()
	logf("protocol guard stopped rule=%d port=%d", server.rule.RuleID, server.rule.ListenPort)
}

func (s *protocolGuardServer) serve(cfg Config) {
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			select {
			case <-s.done:
				return
			default:
				logf("protocol guard accept rule=%d: %v", s.rule.RuleID, err)
				return
			}
		}
		go s.handleConn(cfg, conn)
	}
}

func (s *protocolGuardServer) handleConn(cfg Config, client net.Conn) {
	defer client.Close()
	_ = client.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, 4096)
	n, err := client.Read(buf)
	_ = client.SetReadDeadline(time.Time{})
	if err != nil {
		return
	}
	if proto := detectBlockedProtocol(buf[:n], s.rule.Policy); proto != "" {
		reportProtocolBlock(cfg, s.rule, proto)
		return
	}
	target, err := net.DialTimeout("tcp", net.JoinHostPort(s.rule.TargetIP, strconv.Itoa(s.rule.TargetPort)), 10*time.Second)
	if err != nil {
		logf("protocol guard dial target rule=%d: %v", s.rule.RuleID, err)
		return
	}
	defer target.Close()
	if _, err := target.Write(buf[:n]); err != nil {
		return
	}
	errCh := make(chan error, 2)
	go func() { _, err := io.Copy(target, client); errCh <- err }()
	go func() { _, err := io.Copy(client, target); errCh <- err }()
	<-errCh
}

func detectBlockedProtocol(data []byte, policy protocolPolicy) string {
	if policy.BlockHTTP && detectHTTPProtocol(data) {
		return "http"
	}
	if policy.BlockTLS && detectTLSProtocol(data) {
		return "tls"
	}
	if policy.BlockSocks && detectSocksProtocol(data) {
		return "socks"
	}
	return ""
}

func detectHTTPProtocol(data []byte) bool {
	if len(data) >= 24 && string(data[:24]) == "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n" {
		return true
	}
	methods := []string{"GET ", "POST ", "PUT ", "DELETE ", "HEAD ", "OPTIONS ", "PATCH ", "CONNECT ", "TRACE "}
	upper := strings.ToUpper(string(data[:minInt(len(data), 16)]))
	for _, method := range methods {
		if strings.HasPrefix(upper, method) {
			return true
		}
	}
	return false
}

func detectTLSProtocol(data []byte) bool {
	return len(data) >= 5 && data[0] == 0x16 && data[1] == 0x03 && data[2] >= 0x01 && data[2] <= 0x04
}

func detectSocksProtocol(data []byte) bool {
	if len(data) < 2 {
		return false
	}
	if data[0] == 0x04 {
		return len(data) >= 7 && (data[1] == 0x01 || data[1] == 0x02)
	}
	if data[0] != 0x05 {
		return false
	}
	nMethods := int(data[1])
	if nMethods <= 0 || len(data) < 2+nMethods {
		return false
	}
	for _, method := range data[2 : 2+nMethods] {
		if method == 0x00 || method == 0x02 {
			return true
		}
	}
	return false
}

func reportProtocolBlock(cfg Config, rule guardRule, proto string) {
	payload := map[string]any{
		"ruleId":     rule.RuleID,
		"tunnelId":   rule.TunnelID,
		"sourcePort": rule.ListenPort,
		"protocol":   proto,
	}
	if err := post(cfg, "/api/agent/protocol-block", payload, &map[string]any{}); err != nil {
		logf("protocol block report failed rule=%d protocol=%s: %v", rule.RuleID, proto, err)
	} else {
		logf("protocol block reported rule=%d tunnel=%d protocol=%s", rule.RuleID, rule.TunnelID, proto)
	}
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

type fxpLogWriter struct {
	message *actionMessage
}

func (w fxpLogWriter) Write(p []byte) (int, error) {
	msg := strings.TrimSpace(string(p))
	if msg != "" {
		logf("fxp runtime: %s", msg)
		if w.message != nil {
			w.message.remember("fxp runtime: %s", msg)
		}
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
	decodedBody := resBody
	var respEnv envelope
	var decryptErr error
	if err := json.Unmarshal(resBody, &respEnv); err == nil && respEnv.V == 1 {
		if plain, err := decrypt(respEnv, cfg.Token); err == nil {
			decodedBody = plain
		} else {
			decryptErr = err
		}
	}
	if res.StatusCode >= 300 {
		var migrated struct {
			PanelURL     string        `json:"panelUrl"`
			AgentUpgrade *agentUpgrade `json:"agentUpgrade"`
		}
		if err := json.Unmarshal(decodedBody, &migrated); err == nil {
			panelURL := strings.TrimSpace(migrated.PanelURL)
			if panelURL == "" && migrated.AgentUpgrade != nil {
				panelURL = strings.TrimSpace(migrated.AgentUpgrade.PanelURL)
			}
			if panelURL != "" {
				return migratedPanelError{PanelURL: panelURL}
			}
		}
		if decryptErr != nil {
			return fmt.Errorf("%s: %v", res.Status, decryptErr)
		}
		return fmt.Errorf("%s: %s", res.Status, string(decodedBody))
	}
	if decryptErr != nil {
		return decryptErr
	}
	return json.Unmarshal(decodedBody, out)
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
	message := fmt.Sprintf(format, args...)
	createdAt := time.Now().Format(time.RFC3339)
	line := createdAt + " " + message + "\n"
	fmt.Print(line)
	f, err := os.OpenFile("/var/log/forwardx-agent/agent-go.log", os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err == nil {
		defer f.Close()
		_, _ = f.WriteString(line)
	}
	rememberAgentLog(message, createdAt)
}

func rememberAgentLog(message, createdAt string) {
	if !isImportantAgentLog(message) {
		return
	}
	level := "info"
	lower := strings.ToLower(message)
	if strings.Contains(lower, "error") || strings.Contains(lower, "failed") || strings.Contains(lower, "panic") {
		level = "error"
	} else if strings.Contains(lower, "warn") || strings.Contains(lower, "timeout") {
		level = "warn"
	}
	agentLogMu.Lock()
	defer agentLogMu.Unlock()
	agentLogBuffer = append(agentLogBuffer, agentLogEntry{Level: level, Message: message, CreatedAt: createdAt})
	if len(agentLogBuffer) > 200 {
		agentLogBuffer = agentLogBuffer[len(agentLogBuffer)-200:]
	}
}

func isImportantAgentLog(message string) bool {
	lower := strings.ToLower(message)
	keywords := []string{"error", "failed", "warn", "timeout", "upgrade", "selftest", "protocol", "fxp", "migrated"}
	for _, keyword := range keywords {
		if strings.Contains(lower, keyword) {
			return true
		}
	}
	return false
}

func flushAgentLogs(cfg Config) {
	if !agentLogUploadEnabled.Load() {
		return
	}
	agentLogMu.Lock()
	if len(agentLogBuffer) == 0 {
		agentLogMu.Unlock()
		return
	}
	logs := append([]agentLogEntry(nil), agentLogBuffer...)
	agentLogBuffer = nil
	agentLogMu.Unlock()
	if err := post(cfg, "/api/agent/logs", map[string]any{"logs": logs}, &map[string]any{}); err != nil {
		agentLogMu.Lock()
		agentLogBuffer = append(logs, agentLogBuffer...)
		if len(agentLogBuffer) > 200 {
			agentLogBuffer = agentLogBuffer[len(agentLogBuffer)-200:]
		}
		agentLogMu.Unlock()
	}
}

func fatal(format string, args ...any) {
	logf(format, args...)
	os.Exit(1)
}
