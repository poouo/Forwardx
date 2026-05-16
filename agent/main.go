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

	"github.com/zeebo/blake3"
)

var Version = "2.1.44"
var upgradeStarted int32
var fxpMu sync.Mutex
var fxpServers = map[string]*fxpServer{}

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

type agentUpgrade struct {
	TargetVersion string `json:"targetVersion"`
	PanelURL      string `json:"panelUrl"`
}

type selfTest struct {
	TestID     int    `json:"testId"`
	RuleID     int    `json:"ruleId"`
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
	Key         string `json:"key"`
	LimitIn    int64  `json:"limitIn"`
	LimitOut   int64  `json:"limitOut"`
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
	collectTCPing(cfg)
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
			removeStateByPort(port)
		}
	}
}

func removeStateByPort(port string) {
	_ = os.Remove("/var/lib/forwardx-agent/port_" + port + ".rule")
	_ = os.Remove("/var/lib/forwardx-agent/port_" + port + ".fwtype")
	_ = os.Remove("/var/lib/forwardx-agent/target_" + port + ".info")
	_ = os.Remove("/var/lib/forwardx-agent/traffic_" + port + ".prev")
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

func collectTCPing(cfg Config) {
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
	if len(results) > 0 {
		_ = post(cfg, "/api/agent/tcping", map[string]any{"results": results}, &map[string]any{})
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

type fxpServer struct {
	key string
	ln  net.Listener
	pc  net.PacketConn
}

func fxpServerID(spec fxpSpec) string {
	return spec.Role + ":" + strconv.Itoa(spec.TunnelID) + ":" + strconv.Itoa(spec.RuleID) + ":" + strconv.Itoa(spec.ListenPort)
}

func fxpWantsTCP(spec fxpSpec) bool {
	return spec.Protocol == "" || spec.Protocol == "tcp" || spec.Protocol == "both"
}

func fxpWantsUDP(spec fxpSpec) bool {
	return spec.Protocol == "udp" || spec.Protocol == "both"
}

func startFXP(spec fxpSpec) bool {
	if spec.Key == "" || spec.ListenPort <= 0 {
		logf("fxp invalid config role=%s tunnel=%d rule=%d port=%d", spec.Role, spec.TunnelID, spec.RuleID, spec.ListenPort)
		return false
	}
	id := fxpServerID(spec)
	fxpMu.Lock()
	existing := fxpServers[id]
	if existing != nil && existing.key == spec.Key {
		fxpMu.Unlock()
		logf("fxp %s already running tunnel=%d rule=%d listen=:%d protocol=%s", spec.Role, spec.TunnelID, spec.RuleID, spec.ListenPort, spec.Protocol)
		return true
	}
	fxpMu.Unlock()
	stopFXP(spec)
	addr := ":" + strconv.Itoa(spec.ListenPort)
	var ln net.Listener
	var pc net.PacketConn
	if fxpWantsTCP(spec) {
		var err error
		ln, err = net.Listen("tcp", addr)
		if err != nil {
			logf("fxp tcp listen %s failed: %v", addr, err)
			return false
		}
	}
	if fxpWantsUDP(spec) {
		var err error
		pc, err = net.ListenPacket("udp", addr)
		if err != nil {
			if ln != nil {
				_ = ln.Close()
			}
			logf("fxp udp listen %s failed: %v", addr, err)
			return false
		}
	}
	fxpMu.Lock()
	fxpServers[id] = &fxpServer{key: spec.Key, ln: ln, pc: pc}
	fxpMu.Unlock()
	if ln != nil {
		go fxpAcceptLoop(spec, ln)
	}
	if pc != nil {
		go fxpUDPServe(spec, pc)
	}
	logf("fxp %s started tunnel=%d rule=%d listen=%s protocol=%s", spec.Role, spec.TunnelID, spec.RuleID, addr, spec.Protocol)
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
	if s != nil && s.ln != nil {
		_ = s.ln.Close()
	}
	if s != nil && s.pc != nil {
		_ = s.pc.Close()
	}
}

func fxpAcceptLoop(spec fxpSpec, ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		if spec.Role == "exit" {
			go fxpHandleExit(spec, conn)
		} else {
			go fxpHandleEntry(spec, conn)
		}
	}
}

func fxpHandleEntry(spec fxpSpec, client net.Conn) {
	defer client.Close()
	if spec.ExitHost == "" || spec.ExitPort <= 0 || spec.TargetIP == "" || spec.TargetPort <= 0 {
		return
	}
	exitConn, err := net.DialTimeout("tcp", net.JoinHostPort(spec.ExitHost, strconv.Itoa(spec.ExitPort)), 5*time.Second)
	if err != nil {
		logf("fxp entry dial exit %s:%d failed: %v", spec.ExitHost, spec.ExitPort, err)
		return
	}
	defer exitConn.Close()
	salt, err := fxpClientHandshake(exitConn, spec)
	if err != nil {
		logf("fxp entry handshake failed: %v", err)
		return
	}
	fxpRelayEncrypted(client, exitConn, spec, salt)
}

func fxpHandleExit(spec fxpSpec, conn net.Conn) {
	defer conn.Close()
	target, salt, err := fxpServerHandshake(conn, spec.Key)
	if err != nil {
		logf("fxp exit handshake failed: %v", err)
		return
	}
	targetConn, err := net.DialTimeout("tcp", target, 5*time.Second)
	if err != nil {
		logf("fxp exit dial target %s failed: %v", target, err)
		return
	}
	defer targetConn.Close()
	fxpRelayEncrypted(targetConn, conn, spec, salt)
}

func fxpClientHandshake(conn net.Conn, spec fxpSpec) ([]byte, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	target := net.JoinHostPort(spec.TargetIP, strconv.Itoa(spec.TargetPort))
	targetBytes := []byte(target)
	if len(targetBytes) > 65535 {
		return nil, fmt.Errorf("target too long")
	}
	header := []byte{'F', 'X', 1, 1}
	header = append(header, salt...)
	var lenBuf [2]byte
	binary.BigEndian.PutUint16(lenBuf[:], uint16(len(targetBytes)))
	header = append(header, lenBuf[:]...)
	header = append(header, targetBytes...)
	_, err := conn.Write(header)
	return salt, err
}

func fxpServerHandshake(conn net.Conn, key string) (string, []byte, error) {
	header := make([]byte, 22)
	if _, err := io.ReadFull(conn, header); err != nil {
		return "", nil, err
	}
	if header[0] != 'F' || header[1] != 'X' || header[2] != 1 || header[3] != 1 {
		return "", nil, fmt.Errorf("invalid fxp header")
	}
	salt := append([]byte(nil), header[4:20]...)
	targetLen := int(binary.BigEndian.Uint16(header[20:22]))
	if targetLen <= 0 || targetLen > 1024 {
		return "", nil, fmt.Errorf("invalid fxp target length")
	}
	targetBytes := make([]byte, targetLen)
	if _, err := io.ReadFull(conn, targetBytes); err != nil {
		return "", nil, err
	}
	return string(targetBytes), salt, nil
}

func fxpUDPPacketKey(addr net.Addr) string {
	if addr == nil {
		return ""
	}
	return addr.String()
}

func fxpUDPServe(spec fxpSpec, pc net.PacketConn) {
	if spec.Role == "exit" {
		fxpUDPServeExit(spec, pc)
		return
	}
	fxpUDPServeEntry(spec, pc)
}

func fxpUDPServeEntry(spec fxpSpec, pc net.PacketConn) {
	if spec.ExitHost == "" || spec.ExitPort <= 0 || spec.TargetIP == "" || spec.TargetPort <= 0 {
		return
	}
	exitAddr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(spec.ExitHost, strconv.Itoa(spec.ExitPort)))
	if err != nil {
		logf("fxp udp entry resolve exit failed: %v", err)
		return
	}
	target := net.JoinHostPort(spec.TargetIP, strconv.Itoa(spec.TargetPort))
	sessions := map[string][]byte{}
	var mu sync.Mutex
	var upWindowStart time.Time
	var upWindowBytes int64
	var downWindowStart time.Time
	var downWindowBytes int64
	buf := make([]byte, 64*1024)
	for {
		n, clientAddr, err := pc.ReadFrom(buf)
		if err != nil {
			return
		}
		if clientAddr == nil {
			continue
		}
		clientKey := fxpUDPPacketKey(clientAddr)
		isExitPacket := clientKey == exitAddr.String()
		if isExitPacket {
			client, plain, ok := fxpUDPDecodeDownstream(spec, buf[:n])
			if !ok {
				continue
			}
			fxpThrottle(len(plain), spec.LimitOut, &downWindowStart, &downWindowBytes)
			_, _ = pc.WriteTo(plain, client)
			continue
		}
		mu.Lock()
		salt := sessions[clientKey]
		if salt == nil {
			salt = make([]byte, 16)
			if _, err := rand.Read(salt); err != nil {
				mu.Unlock()
				continue
			}
			sessions[clientKey] = salt
		}
		mu.Unlock()
		fxpThrottle(n, spec.LimitIn, &upWindowStart, &upWindowBytes)
		packet, err := fxpUDPEncodeUpstream(spec.Key, salt, clientKey, target, buf[:n])
		if err != nil {
			continue
		}
		_, _ = pc.WriteTo(packet, exitAddr)
	}
}

func fxpUDPServeExit(spec fxpSpec, pc net.PacketConn) {
	buf := make([]byte, 64*1024)
	for {
		n, entryAddr, err := pc.ReadFrom(buf)
		if err != nil {
			return
		}
		go fxpUDPHandleExitPacket(spec, pc, entryAddr, append([]byte(nil), buf[:n]...))
	}
}

func fxpUDPHandleExitPacket(spec fxpSpec, pc net.PacketConn, entryAddr net.Addr, packet []byte) {
	clientKey, target, plain, salt, err := fxpUDPDecodeUpstream(spec.Key, packet)
	if err != nil {
		logf("fxp udp exit decode failed: %v", err)
		return
	}
	targetAddr, err := net.ResolveUDPAddr("udp", target)
	if err != nil {
		logf("fxp udp exit resolve target %s failed: %v", target, err)
		return
	}
	conn, err := net.DialUDP("udp", nil, targetAddr)
	if err != nil {
		logf("fxp udp exit dial target %s failed: %v", target, err)
		return
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(8 * time.Second))
	if _, err := conn.Write(plain); err != nil {
		return
	}
	reply := make([]byte, 64*1024)
	n, err := conn.Read(reply)
	if err != nil || n <= 0 {
		return
	}
	resp, err := fxpUDPEncodeDownstream(spec.Key, salt, clientKey, reply[:n])
	if err != nil {
		return
	}
	_, _ = pc.WriteTo(resp, entryAddr)
}

func fxpUDPEncodeUpstream(key string, salt []byte, clientKey string, target string, payload []byte) ([]byte, error) {
	aead, err := fxpAEAD(key, salt, "udp-client-to-exit")
	if err != nil {
		return nil, err
	}
	plain, err := fxpUDPPack(clientKey, target, payload)
	if err != nil {
		return nil, err
	}
	sealed := aead.Seal(nil, fxpNonce(0), plain, nil)
	out := []byte{'F', 'X', 'U', 1}
	out = append(out, salt...)
	out = append(out, sealed...)
	return out, nil
}

func fxpUDPDecodeUpstream(key string, packet []byte) (string, string, []byte, []byte, error) {
	if len(packet) < 20 || packet[0] != 'F' || packet[1] != 'X' || packet[2] != 'U' || packet[3] != 1 {
		return "", "", nil, nil, fmt.Errorf("invalid udp header")
	}
	salt := append([]byte(nil), packet[4:20]...)
	aead, err := fxpAEAD(key, salt, "udp-client-to-exit")
	if err != nil {
		return "", "", nil, nil, err
	}
	plain, err := aead.Open(nil, fxpNonce(0), packet[20:], nil)
	if err != nil {
		return "", "", nil, nil, err
	}
	clientKey, target, payload, err := fxpUDPUnpack(plain)
	return clientKey, target, payload, salt, err
}

func fxpUDPEncodeDownstream(key string, salt []byte, clientKey string, payload []byte) ([]byte, error) {
	aead, err := fxpAEAD(key, salt, "udp-exit-to-client")
	if err != nil {
		return nil, err
	}
	plain, err := fxpUDPPack(clientKey, "", payload)
	if err != nil {
		return nil, err
	}
	sealed := aead.Seal(nil, fxpNonce(0), plain, nil)
	out := []byte{'F', 'X', 'D', 1}
	out = append(out, salt...)
	out = append(out, sealed...)
	return out, nil
}

func fxpUDPDecodeDownstream(spec fxpSpec, packet []byte) (net.Addr, []byte, bool) {
	if len(packet) < 20 || packet[0] != 'F' || packet[1] != 'X' || packet[2] != 'D' || packet[3] != 1 {
		return nil, nil, false
	}
	salt := packet[4:20]
	aead, err := fxpAEAD(spec.Key, salt, "udp-exit-to-client")
	if err != nil {
		return nil, nil, false
	}
	plain, err := aead.Open(nil, fxpNonce(0), packet[20:], nil)
	if err != nil {
		return nil, nil, false
	}
	clientKey, _, payload, err := fxpUDPUnpack(plain)
	if err != nil {
		return nil, nil, false
	}
	addr, err := net.ResolveUDPAddr("udp", clientKey)
	if err != nil {
		return nil, nil, false
	}
	return addr, payload, true
}

func fxpUDPPack(clientKey string, target string, payload []byte) ([]byte, error) {
	clientBytes := []byte(clientKey)
	targetBytes := []byte(target)
	if len(clientBytes) > 65535 || len(targetBytes) > 65535 {
		return nil, fmt.Errorf("udp metadata too long")
	}
	out := make([]byte, 0, 4+len(clientBytes)+len(targetBytes)+len(payload))
	var b [2]byte
	binary.BigEndian.PutUint16(b[:], uint16(len(clientBytes)))
	out = append(out, b[:]...)
	binary.BigEndian.PutUint16(b[:], uint16(len(targetBytes)))
	out = append(out, b[:]...)
	out = append(out, clientBytes...)
	out = append(out, targetBytes...)
	out = append(out, payload...)
	return out, nil
}

func fxpUDPUnpack(in []byte) (string, string, []byte, error) {
	if len(in) < 4 {
		return "", "", nil, fmt.Errorf("udp packet too short")
	}
	clientLen := int(binary.BigEndian.Uint16(in[0:2]))
	targetLen := int(binary.BigEndian.Uint16(in[2:4]))
	offset := 4
	if clientLen <= 0 || len(in) < offset+clientLen+targetLen {
		return "", "", nil, fmt.Errorf("invalid udp metadata")
	}
	clientKey := string(in[offset : offset+clientLen])
	offset += clientLen
	target := string(in[offset : offset+targetLen])
	offset += targetLen
	return clientKey, target, append([]byte(nil), in[offset:]...), nil
}

func fxpRelayEncrypted(plain net.Conn, encrypted net.Conn, spec fxpSpec, salt []byte) {
	errc := make(chan error, 2)
	go func() { errc <- fxpEncryptCopy(encrypted, plain, spec.Key, salt, "client-to-exit", spec.LimitIn) }()
	go func() { errc <- fxpDecryptCopy(plain, encrypted, spec.Key, salt, "exit-to-client", spec.LimitOut) }()
	<-errc
}

func fxpAEAD(key string, salt []byte, direction string) (cipher.AEAD, error) {
	seedInput := append([]byte("forwardx-fxp-aes-128-gcm|"+direction+"|"+key+"|"), salt...)
	seed := blake3.Sum256(seedInput)
	block, err := aes.NewCipher(seed[:16])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func fxpNonce(seq uint64) []byte {
	nonce := make([]byte, 12)
	binary.BigEndian.PutUint64(nonce[4:], seq)
	return nonce
}

func fxpThrottle(bytes int, limit int64, windowStart *time.Time, windowBytes *int64) {
	if limit <= 0 || bytes <= 0 {
		return
	}
	now := time.Now()
	if windowStart.IsZero() || now.Sub(*windowStart) >= time.Second {
		*windowStart = now
		*windowBytes = 0
	}
	*windowBytes += int64(bytes)
	if *windowBytes > limit {
		sleepFor := time.Second - time.Since(*windowStart)
		if sleepFor > 0 {
			time.Sleep(sleepFor)
		}
		*windowStart = time.Now()
		*windowBytes = 0
	}
}

func fxpEncryptCopy(dst net.Conn, src net.Conn, key string, salt []byte, direction string, limit int64) error {
	aead, err := fxpAEAD(key, salt, direction)
	if err != nil {
		return err
	}
	buf := make([]byte, 32*1024)
	var seq uint64
	var windowStart time.Time
	var windowBytes int64
	for {
		n, readErr := src.Read(buf)
		if n > 0 {
			fxpThrottle(n, limit, &windowStart, &windowBytes)
			sealed := aead.Seal(nil, fxpNonce(seq), buf[:n], nil)
			var hdr [4]byte
			binary.BigEndian.PutUint32(hdr[:], uint32(len(sealed)))
			if _, err := dst.Write(hdr[:]); err != nil {
				return err
			}
			if _, err := dst.Write(sealed); err != nil {
				return err
			}
			seq++
		}
		if readErr != nil {
			return readErr
		}
	}
}

func fxpDecryptCopy(dst net.Conn, src net.Conn, key string, salt []byte, direction string, limit int64) error {
	aead, err := fxpAEAD(key, salt, direction)
	if err != nil {
		return err
	}
	var seq uint64
	var windowStart time.Time
	var windowBytes int64
	for {
		var hdr [4]byte
		if _, err := io.ReadFull(src, hdr[:]); err != nil {
			return err
		}
		n := binary.BigEndian.Uint32(hdr[:])
		if n == 0 || n > 64*1024 {
			return fmt.Errorf("invalid fxp frame size %d", n)
		}
		frame := make([]byte, n)
		if _, err := io.ReadFull(src, frame); err != nil {
			return err
		}
		plain, err := aead.Open(nil, fxpNonce(seq), frame, nil)
		if err != nil {
			return err
		}
		fxpThrottle(len(plain), limit, &windowStart, &windowBytes)
		if _, err := dst.Write(plain); err != nil {
			return err
		}
		seq++
	}
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
