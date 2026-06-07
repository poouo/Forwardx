package main

import (
	"bufio"
	"bytes"
	"context"
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
	"hash/fnv"
	"io"
	mathrand "math/rand"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var Version = "2.2.88"

const selfUpgradeLockTimeout = 10 * time.Minute
const iperf3IdleTimeout = 3 * time.Minute
const selfTestIdlePollInterval = time.Minute
const selfTestActivePollInterval = 3 * time.Second
const selfTestActiveWindow = 2 * time.Minute
const agentClockSyncCooldown = 10 * time.Minute

var upgradeStarted int32
var upgradeStartedAt int64
var clockSyncRunning int32
var lastClockSyncAttemptAt int64
var fxpMu sync.Mutex
var fxpServers = map[string]*fxpProcess{}
var protocolGuardMu sync.Mutex
var protocolGuards = map[string]*protocolGuardServer{}
var failoverMu sync.Mutex
var failoverProxies = map[string]*failoverProxy{}
var lastTCPingAt time.Time
var agentLogUploadEnabled atomic.Bool
var agentLogMu sync.Mutex
var agentLogPrunedAt time.Time
var actionQueue = make(chan actionJob, 128)
var actionEpochMu sync.Mutex
var latestActionIssuedAt = map[string]int64{}
var iperf3Mu sync.Mutex
var iperf3Server *iperf3Process

type actionJob struct {
	cfg    Config
	action action
}

type agentLogEntry struct {
	Level     string `json:"level"`
	Message   string `json:"message"`
	CreatedAt string `json:"createdAt"`
}

type agentLogUploadResp struct {
	Accepted int  `json:"accepted"`
	Disabled bool `json:"disabled"`
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
	Actions            []action            `json:"actions"`
	SelfTests          []selfTest          `json:"selfTests"`
	RunningRules       []runningRule       `json:"runningRules"`
	TunnelProbes       []tunnelProbe       `json:"tunnelProbes"`
	ForwardGroupProbes []forwardGroupProbe `json:"forwardGroupProbes"`
	GuardRules         []guardRule         `json:"guardRules"`
	LookingGlassTests  []lookingGlassTask  `json:"lookingGlassTests"`
	Iperf3Tasks        []iperf3Task        `json:"iperf3Tasks"`
	AgentUpgrade       *agentUpgrade       `json:"agentUpgrade"`
	LogUpload          bool                `json:"agentLogUploadEnabled"`
	NextInterval       int                 `json:"nextInterval"`
}

type selfTestResp struct {
	SelfTests []selfTest `json:"selfTests"`
}

type action struct {
	TunnelID         int           `json:"tunnelId"`
	StatusType       string        `json:"statusType"`
	RuleID           int           `json:"ruleId"`
	IssuedAt         int64         `json:"issuedAt,omitempty"`
	Op               string        `json:"op"`
	ForwardType      string        `json:"forwardType"`
	SourcePort       int           `json:"sourcePort"`
	TargetIP         string        `json:"targetIp"`
	TargetPort       int           `json:"targetPort"`
	Protocol         string        `json:"protocol"`
	PreCommands      []string      `json:"preCommands"`
	ServiceName      string        `json:"svcName"`
	ServiceNameExtra string        `json:"svcNameExtra"`
	Unit             string        `json:"unit"`
	UnitExtra        string        `json:"unitExtra"`
	Commands         []string      `json:"commands"`
	PostCommands     []string      `json:"postCommands"`
	Fxp              *fxpSpec      `json:"fxp,omitempty"`
	Failover         *failoverSpec `json:"failover,omitempty"`
}

type runningRule struct {
	RuleID      int           `json:"ruleId"`
	SourcePort  int           `json:"sourcePort"`
	TargetIP    string        `json:"targetIp"`
	TargetPort  int           `json:"targetPort"`
	Protocol    string        `json:"protocol"`
	ForwardType string        `json:"forwardType"`
	Failover    *failoverSpec `json:"failover,omitempty"`
}

type failoverTarget struct {
	TargetIP   string `json:"targetIp"`
	TargetPort int    `json:"targetPort"`
}

type failoverSpec struct {
	Enabled         bool             `json:"enabled"`
	ListenPort      int              `json:"listenPort"`
	BindAddress     string           `json:"bindAddress"`
	Protocol        string           `json:"protocol"`
	Strategy        string           `json:"strategy"`
	Targets         []failoverTarget `json:"targets"`
	FailoverSeconds int              `json:"failoverSeconds"`
	RecoverSeconds  int              `json:"recoverSeconds"`
	AutoFailback    bool             `json:"autoFailback"`
}

type tunnelProbe struct {
	TunnelID   int    `json:"tunnelId"`
	TargetIP   string `json:"targetIp"`
	TargetPort int    `json:"targetPort"`
	Protocol   string `json:"protocol"`
	HopIndex   int    `json:"hopIndex"`
	HopCount   int    `json:"hopCount"`
}

type forwardGroupProbe struct {
	GroupID    int    `json:"groupId"`
	TargetIP   string `json:"targetIp"`
	TargetPort int    `json:"targetPort"`
	Method     string `json:"method"`
	HopIndex   int    `json:"hopIndex"`
	HopCount   int    `json:"hopCount"`
}

type agentUpgrade struct {
	TargetVersion string `json:"targetVersion"`
	PanelURL      string `json:"panelUrl"`
}

type agentEventMessage struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
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
	Method      string `json:"method"`
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
	go actionWorker()
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
	pendingActionPorts := map[string]bool{}
	for _, a := range resp.Actions {
		if a.SourcePort > 0 {
			pendingActionPorts[strconv.Itoa(a.SourcePort)] = true
		}
		enqueueAction(cfg, a)
	}
	for _, t := range resp.SelfTests {
		go handleSelfTest(cfg, t)
	}
	for _, task := range resp.LookingGlassTests {
		go handleLookingGlassTask(cfg, task)
	}
	for _, task := range resp.Iperf3Tasks {
		go handleIperf3Task(cfg, task)
	}
	syncRunningRuleState(resp.RunningRules, pendingActionPorts)
	for _, r := range resp.RunningRules {
		writeRunningRuleState(r)
		if r.ForwardType != "nftables" {
			ensureCountingChains(r.SourcePort, r.TargetIP, r.TargetPort, r.Protocol)
		}
	}
	syncProtocolGuards(cfg, resp.GuardRules)
	collectTraffic(cfg)
	if lastTCPingAt.IsZero() || time.Since(lastTCPingAt) >= time.Minute {
		collectTCPing(cfg, resp.TunnelProbes, resp.ForwardGroupProbes)
		lastTCPingAt = time.Now()
	}
	flushAgentLogs(cfg)
	return resp.NextInterval, nil
}

func enqueueAction(cfg Config, a action) {
	if isOlderAction(a, true) {
		return
	}
	actionQueue <- actionJob{cfg: cfg, action: a}
}

func actionWorker() {
	for job := range actionQueue {
		if isOlderAction(job.action, false) {
			continue
		}
		handleAction(job.cfg, job.action)
	}
}

func actionStaleKeys(a action) []string {
	keys := []string{}
	statusType := strings.TrimSpace(a.StatusType)
	if statusType == "" {
		if a.RuleID > 0 {
			statusType = "rule"
		} else if a.TunnelID > 0 {
			statusType = "tunnel"
		}
	}
	if statusType == "tunnel" && a.TunnelID > 0 {
		keys = append(keys, fmt.Sprintf("tunnel:%d:%d", a.TunnelID, a.SourcePort))
	}
	if a.RuleID > 0 {
		keys = append(keys, fmt.Sprintf("rule:%d:%d", a.RuleID, a.SourcePort))
	}
	if a.SourcePort > 0 {
		keys = append(keys, fmt.Sprintf("port:%d", a.SourcePort))
	}
	return keys
}

func isOlderAction(a action, remember bool) bool {
	if a.IssuedAt <= 0 {
		return false
	}
	keys := actionStaleKeys(a)
	if len(keys) == 0 {
		return false
	}
	actionEpochMu.Lock()
	latest := int64(0)
	for _, key := range keys {
		if ts := latestActionIssuedAt[key]; ts > latest {
			latest = ts
		}
	}
	if remember {
		for _, key := range keys {
			if a.IssuedAt > latestActionIssuedAt[key] {
				latestActionIssuedAt[key] = a.IssuedAt
			}
		}
		if a.IssuedAt > latest {
			latest = a.IssuedAt
		}
	}
	actionEpochMu.Unlock()
	if a.IssuedAt < latest {
		logf("action stale drop op=%s statusType=%s rule=%d tunnel=%d port=%d issuedAt=%d latest=%d", a.Op, a.StatusType, a.RuleID, a.TunnelID, a.SourcePort, a.IssuedAt, latest)
		return true
	}
	return false
}

func selfTestPoller(cfg Config) {
	activeUntil := time.Time{}
	for {
		interval := selfTestIdlePollInterval
		if time.Now().Before(activeUntil) {
			interval = selfTestActivePollInterval
		}
		time.Sleep(interval)
		var resp selfTestResp
		if err := post(cfg, "/api/agent/selftest-pull", map[string]any{}, &resp); err != nil {
			logf("selftest pull error: %v", err)
			continue
		}
		if len(resp.SelfTests) > 0 {
			activeUntil = time.Now().Add(selfTestActiveWindow)
		}
		for _, t := range resp.SelfTests {
			go handleSelfTest(cfg, t)
		}
	}
}

func handleSelfTest(cfg Config, t selfTest) {
	method := strings.ToLower(strings.TrimSpace(t.Method))
	if method == "" {
		method = strings.ToLower(strings.TrimSpace(t.Protocol))
	}
	if method == "ping" {
		latency, reachable, detail := pingLatency(t.TargetIP, 3*time.Second)
		msg := ""
		if reachable {
			msg = fmt.Sprintf("目标 %s Ping可达，延迟 %dms", t.TargetIP, latency)
		} else {
			msg = fmt.Sprintf("目标 %s Ping不可达：%s", t.TargetIP, detail)
		}
		payload := map[string]any{
			"testId":          t.TestID,
			"targetReachable": reachable,
			"latencyMs":       latency,
			"message":         msg,
		}
		if err := post(cfg, "/api/agent/selftest-result", payload, &map[string]any{}); err != nil {
			logf("selftest report failed test=%d target=%s: %v", t.TestID, t.TargetIP, err)
		}
		return
	}

	latency, reachable := tcpLatency(t.TargetIP, t.TargetPort, 3*time.Second)
	target := net.JoinHostPort(t.TargetIP, strconv.Itoa(t.TargetPort))
	msg := ""
	if reachable {
		msg = fmt.Sprintf("目标 %s TCP可达，延迟 %dms", target, latency)
	} else {
		latency = 0
		msg = fmt.Sprintf("目标 %s TCP不可达或超时", target)
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

func handleLookingGlassTask(cfg Config, task lookingGlassTask) {
	result := runLookingGlassTask(cfg, task)
	if err := post(cfg, "/api/agent/looking-glass-result", map[string]any{"result": result}, &map[string]any{}); err != nil {
		logf("looking glass result report failed task=%s method=%s target=%s: %v", task.TaskID, task.Method, task.ResolvedAddress, err)
	}
}

func reportLookingGlassProgress(cfg Config, result lookingGlassResult) {
	if err := post(cfg, "/api/agent/looking-glass-progress", map[string]any{"result": result}, &map[string]any{}); err != nil {
		logf("looking glass progress report failed task=%s method=%s target=%s: %v", result.TaskID, result.Method, result.ResolvedAddress, err)
	}
}

func handleIperf3Task(cfg Config, task iperf3Task) {
	result := runIperf3Task(cfg, task)
	if err := post(cfg, "/api/agent/iperf3-result", map[string]any{"result": result}, &map[string]any{}); err != nil {
		logf("iperf3 result report failed task=%s op=%s port=%d: %v", task.TaskID, task.Op, task.Port, err)
	}
}

func reportIperf3Result(cfg Config, result iperf3Result) {
	if result.UpdatedAt == "" {
		result.UpdatedAt = time.Now().Format(time.RFC3339Nano)
	}
	if err := post(cfg, "/api/agent/iperf3-result", map[string]any{"result": result}, &map[string]any{}); err != nil {
		logf("iperf3 status report failed task=%s op=%s port=%d: %v", result.TaskID, result.Op, result.Port, err)
	}
}

func runIperf3Task(cfg Config, task iperf3Task) iperf3Result {
	port := task.Port
	if port < 0 || port > 65535 {
		return iperf3Result{
			TaskID:    task.TaskID,
			Op:        task.Op,
			Port:      port,
			Status:    "error",
			Output:    "iperf3 端口必须在 1-65535 之间",
			Error:     "invalid iperf3 port",
			UpdatedAt: time.Now().Format(time.RFC3339Nano),
		}
	}
	if task.Op == "stop" {
		output := stopIperf3Server("用户从面板停止 iperf3 服务端")
		return iperf3Result{
			TaskID:    task.TaskID,
			Op:        task.Op,
			Port:      port,
			Status:    "stopped",
			Output:    output,
			UpdatedAt: time.Now().Format(time.RFC3339Nano),
		}
	}
	if port == 0 {
		selectedPort, err := pickAvailableIperf3Port()
		if err != nil {
			message := fmt.Sprintf("Agent 无法自动分配 iperf3 监听端口：%v", err)
			return iperf3Result{
				TaskID:    task.TaskID,
				Op:        task.Op,
				Port:      port,
				Status:    "error",
				Output:    message,
				Error:     message,
				UpdatedAt: time.Now().Format(time.RFC3339Nano),
			}
		}
		port = selectedPort
	}
	if _, err := exec.LookPath("iperf3"); err != nil {
		message := "Agent 未安装 iperf3，请重新运行安装脚本或手动安装 iperf3"
		return iperf3Result{
			TaskID:    task.TaskID,
			Op:        task.Op,
			Port:      port,
			Status:    "error",
			Output:    message,
			Error:     message,
			UpdatedAt: time.Now().Format(time.RFC3339Nano),
		}
	}
	return startIperf3Server(cfg, task, port)
}

func startIperf3Server(cfg Config, task iperf3Task, port int) iperf3Result {
	iperf3Mu.Lock()
	if iperf3Server != nil {
		iperf3Server.stopLocked("启动新的 iperf3 服务端，已停止旧实例")
	}
	if err := checkIperf3PortAvailable(port); err != nil {
		iperf3Mu.Unlock()
		message := formatIperf3PortError(port, err)
		return iperf3Result{
			TaskID:    task.TaskID,
			Op:        task.Op,
			Port:      port,
			Status:    "error",
			Output:    message,
			Error:     message,
			UpdatedAt: time.Now().Format(time.RFC3339Nano),
		}
	}
	cmd := exec.Command("iperf3", "-s", "-p", strconv.Itoa(port))
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		iperf3Mu.Unlock()
		return iperf3StartError(task, port, err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		iperf3Mu.Unlock()
		return iperf3StartError(task, port, err)
	}
	if err := cmd.Start(); err != nil {
		iperf3Mu.Unlock()
		return iperf3StartError(task, port, err)
	}
	startedAt := time.Now()
	process := &iperf3Process{
		taskID:    task.TaskID,
		port:      port,
		cfg:       cfg,
		cmd:       cmd,
		startedAt: startedAt,
		output:    "iperf3 服务端已启动，等待客户端连接...",
		done:      make(chan struct{}),
	}
	process.lastActivity.Store(startedAt.UnixNano())
	iperf3Server = process
	iperf3Mu.Unlock()

	var wg sync.WaitGroup
	wg.Add(2)
	go process.readPipe(stdout, &wg)
	go process.readPipe(stderr, &wg)
	go process.watchIdleTimeout()
	go func() {
		err := cmd.Wait()
		wg.Wait()
		process.markExited(err)
	}()

	return iperf3Result{
		TaskID:    task.TaskID,
		Op:        "start",
		Port:      port,
		Status:    "running",
		Output:    process.currentOutput(),
		PID:       cmd.Process.Pid,
		StartedAt: startedAt.Format(time.RFC3339Nano),
		UpdatedAt: time.Now().Format(time.RFC3339Nano),
	}
}

func iperf3StartError(task iperf3Task, port int, err error) iperf3Result {
	message := fmt.Sprintf("iperf3 服务端启动失败：%v", err)
	return iperf3Result{
		TaskID:    task.TaskID,
		Op:        task.Op,
		Port:      port,
		Status:    "error",
		Output:    message,
		Error:     message,
		UpdatedAt: time.Now().Format(time.RFC3339Nano),
	}
}

func checkIperf3PortAvailable(port int) error {
	ln, err := net.Listen("tcp", net.JoinHostPort("", strconv.Itoa(port)))
	if err != nil {
		return err
	}
	return ln.Close()
}

func pickAvailableIperf3Port() (int, error) {
	ln, err := net.Listen("tcp", ":0")
	if err != nil {
		return 0, err
	}
	defer ln.Close()
	addr, ok := ln.Addr().(*net.TCPAddr)
	if !ok || addr.Port <= 0 {
		return 0, fmt.Errorf("无法读取自动分配的端口")
	}
	return addr.Port, nil
}

func formatIperf3PortError(port int, err error) string {
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "address already in use") || strings.Contains(message, "only one usage of each socket address") {
		return fmt.Sprintf("iperf3 监听端口 %d 已被占用，请换一个端口，或在服务器上停止占用该端口的进程后重试。", port)
	}
	return fmt.Sprintf("iperf3 监听端口 %d 不可用：%v", port, err)
}

func stopIperf3Server(reason string) string {
	iperf3Mu.Lock()
	defer iperf3Mu.Unlock()
	if iperf3Server == nil {
		return "iperf3 服务端未在运行"
	}
	output := iperf3Server.stopLocked(reason)
	iperf3Server = nil
	return output
}

func runLookingGlassTask(cfg Config, task lookingGlassTask) lookingGlassResult {
	started := time.Now()
	result := lookingGlassResult{
		TaskID:            task.TaskID,
		Method:            task.Method,
		Target:            task.Target,
		ResolvedAddress:   task.ResolvedAddress,
		ResolvedAddresses: task.ResolvedAddresses,
		StartedAt:         started.Format(time.RFC3339Nano),
	}
	result.Output = fmt.Sprintf("Agent 已开始执行 %s 测试\n目标: %s", task.Method, task.ResolvedAddress)
	reportLookingGlassProgress(cfg, result)
	if task.Method == "tcp" {
		port := task.Port
		if port <= 0 {
			port = 443
		}
		result.Port = port
		result.Output = fmt.Sprintf("正在测试 TCP %s ...", net.JoinHostPort(task.ResolvedAddress, strconv.Itoa(port)))
		result.DurationMs = int(time.Since(started).Milliseconds())
		reportLookingGlassProgress(cfg, result)
		latency, ok := tcpLatency(task.ResolvedAddress, port, 10*time.Second)
		result.DurationMs = int(time.Since(started).Milliseconds())
		if ok {
			code := 0
			result.ExitCode = &code
			result.Output = fmt.Sprintf("TCP %s 连接成功\n耗时: %d ms", net.JoinHostPort(task.ResolvedAddress, strconv.Itoa(port)), latency)
		} else {
			code := 1
			result.ExitCode = &code
			result.Output = fmt.Sprintf("TCP %s 连接失败或超时\n耗时: %d ms", net.JoinHostPort(task.ResolvedAddress, strconv.Itoa(port)), result.DurationMs)
		}
		result.FinishedAt = time.Now().Format(time.RFC3339Nano)
		return result
	}

	command, args, err := lookingGlassCommand(task.Method, task.ResolvedAddress)
	if err != nil {
		code := 1
		result.ExitCode = &code
		result.Error = err.Error()
		result.Output = err.Error()
		result.DurationMs = int(time.Since(started).Milliseconds())
		result.FinishedAt = time.Now().Format(time.RFC3339Nano)
		return result
	}
	progress := func(output string, durationMs int) {
		result.Output = output
		result.DurationMs = durationMs
		reportLookingGlassProgress(cfg, result)
	}
	output, exitCode, timedOut := runLookingGlassCommand(command, args, 30*time.Second, progress)
	result.Output = output
	if strings.TrimSpace(result.Output) == "" {
		result.Output = "命令没有返回输出"
	}
	result.ExitCode = exitCode
	result.TimedOut = timedOut
	result.DurationMs = int(time.Since(started).Milliseconds())
	result.FinishedAt = time.Now().Format(time.RFC3339Nano)
	return result
}

func lookingGlassCommand(method string, host string) (string, []string, error) {
	ipv6 := strings.HasSuffix(method, "6")
	switch method {
	case "ping", "ping6":
		return "ping", []string{mapBool(ipv6, "-6", "-4"), "-c", "4", "-W", "3", host}, nil
	case "traceroute", "traceroute6":
		return "traceroute", []string{mapBool(ipv6, "-6", "-4"), "-n", "-m", "20", "-w", "2", host}, nil
	case "mtr", "mtr6":
		return "mtr", []string{mapBool(ipv6, "-6", "-4"), "--report", "--report-cycles", "10", "--no-dns", host}, nil
	default:
		return "", nil, fmt.Errorf("不支持的网络测试方法: %s", method)
	}
}

func runLookingGlassCommand(name string, args []string, timeout time.Duration, onProgress func(string, int)) (string, *int, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	started := time.Now()
	cmd := exec.CommandContext(ctx, name, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		code := 1
		return err.Error(), &code, false
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		code := 1
		return err.Error(), &code, false
	}

	var mu sync.Mutex
	var output strings.Builder
	appendLine := func(line string) {
		mu.Lock()
		defer mu.Unlock()
		if output.Len() >= 32000 {
			return
		}
		if output.Len() > 0 {
			output.WriteByte('\n')
		}
		output.WriteString(line)
		if output.Len() > 32000 {
			text := output.String()
			output.Reset()
			output.WriteString(text[:32000])
			output.WriteString("\n... 输出已截断")
		}
	}
	currentOutput := func() string {
		mu.Lock()
		defer mu.Unlock()
		return strings.TrimSpace(output.String())
	}
	report := func(fallback string) {
		text := currentOutput()
		if text == "" {
			text = fallback
		}
		onProgress(text, int(time.Since(started).Milliseconds()))
	}

	if err := cmd.Start(); err != nil {
		code := 1
		return err.Error(), &code, false
	}

	var wg sync.WaitGroup
	readPipe := func(r io.Reader) {
		defer wg.Done()
		scanner := bufio.NewScanner(r)
		scanner.Buffer(make([]byte, 0, 4096), 1024*1024)
		for scanner.Scan() {
			appendLine(scanner.Text())
			report("命令正在执行，等待输出...")
		}
	}
	wg.Add(2)
	go readPipe(stdout)
	go readPipe(stderr)

	ticker := time.NewTicker(time.Second)
	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()

	var waitErr error
	running := true
	for running {
		select {
		case <-ticker.C:
			report(fmt.Sprintf("命令正在执行，已运行 %ds...", int(time.Since(started).Seconds())))
		case waitErr = <-done:
			running = false
		}
	}
	ticker.Stop()
	wg.Wait()

	outputText := currentOutput()
	timedOut := ctx.Err() == context.DeadlineExceeded
	code := 0
	if waitErr != nil {
		code = 1
		if exitErr, ok := waitErr.(*exec.ExitError); ok {
			code = exitErr.ExitCode()
		}
		if strings.TrimSpace(outputText) == "" {
			outputText = waitErr.Error()
		}
	}
	if timedOut && !strings.Contains(outputText, "超时") {
		if outputText != "" {
			outputText += "\n"
		}
		outputText += "命令执行超时"
	}
	report(outputText)
	return strings.TrimSpace(outputText), &code, timedOut
}

func mapBool(ok bool, yes string, no string) string {
	if ok {
		return yes
	}
	return no
}

func agentEventStream(cfg Config) {
	for {
		if err := runAgentEventStream(cfg); err != nil {
			logf("agent event stream error: %v", err)
			syncSystemTimeForCommError(err)
			time.Sleep(3 * time.Second)
		}
	}
}

func runAgentEventStream(cfg Config) error {
	env, err := encrypt(map[string]any{"agentVersion": Version}, cfg.Token)
	if err != nil {
		return err
	}
	query, _ := json.Marshal(env)
	req, err := http.NewRequest("GET", cfg.PanelURL+"/api/stream?e="+url.QueryEscape(string(query)), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")

	client := &http.Client{Timeout: 0}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("event stream status: %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}

	scanner := bufio.NewScanner(resp.Body)
	var data strings.Builder
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if data.Len() > 0 {
				var msg agentEventMessage
				if err := decodeEventData(data.String(), cfg.Token, &msg); err != nil {
					logf("decode agent upgrade event: %v", err)
				} else if msg.Type == "agent-upgrade" {
					var up agentUpgrade
					if err := json.Unmarshal(msg.Data, &up); err != nil {
						logf("decode agent upgrade payload: %v", err)
					} else {
						go selfUpgrade(cfg, &up)
					}
				} else if msg.Type == "agent-refresh" {
					go func() {
						if _, err := heartbeat(cfg); err != nil {
							logf("agent refresh heartbeat error: %v", err)
						}
					}()
				}
			}
			data.Reset()
			continue
		}
		if strings.HasPrefix(line, "data:") {
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	return scanner.Err()
}

func decodeEventData(raw string, token string, out any) error {
	var env envelope
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		return err
	}
	plain, err := decrypt(env, token)
	if err != nil {
		return err
	}
	return json.Unmarshal(plain, out)
}

func handleAction(cfg Config, a action) {
	ok := true
	actionMessage := &actionMessage{}
	logf("action start op=%s statusType=%s rule=%d tunnel=%d forwardType=%s port=%d protocol=%s", a.Op, a.StatusType, a.RuleID, a.TunnelID, a.ForwardType, a.SourcePort, a.Protocol)
	if strings.TrimSpace(a.StatusType) == "runtime" {
		for _, cmd := range append(append([]string{}, a.PreCommands...), append(a.Commands, a.PostCommands...)...) {
			ok = runShell(cmd) && ok
		}
		logf("runtime action complete forwardType=%s ok=%v", a.ForwardType, ok)
		return
	}
	logActionPortHandoff(a)
	if a.Op == "apply" {
		preserveRunningFXP := cleanupStaleRuntimeBeforeApply(a)
		if preserveRunningFXP {
			logf("action preserves already-running fxp rule=%d tunnel=%d port=%d; skipping disruptive apply commands", a.RuleID, a.TunnelID, a.SourcePort)
		} else {
			for _, cmd := range a.PreCommands {
				ok = runShell(cmd) && ok
			}
			if a.Unit != "" && a.ServiceName != "" {
				ok = writeUnitAndRestart(a.ServiceName, a.Unit) && ok
			}
			if a.UnitExtra != "" && a.ServiceNameExtra != "" {
				ok = writeUnitAndRestart(a.ServiceNameExtra, a.UnitExtra) && ok
			}
			for _, cmd := range a.Commands {
				ok = runShell(cmd) && ok
			}
		}
		if a.Fxp != nil {
			fxpOK := startFXP(cfg, *a.Fxp, actionMessage)
			logf("action fxp role=%s tunnel=%d rule=%d listen=%d protocol=%s ok=%v", a.Fxp.Role, a.Fxp.TunnelID, a.Fxp.RuleID, a.Fxp.ListenPort, a.Fxp.Protocol, fxpOK)
			ok = fxpOK && ok
		}
		if a.Failover != nil && a.Failover.Enabled {
			failoverOK := startFailoverProxy(a.RuleID, a.SourcePort, *a.Failover, actionMessage)
			logf("action failover rule=%d listen=%d targets=%d ok=%v", a.RuleID, a.Failover.ListenPort, len(a.Failover.Targets), failoverOK)
			ok = failoverOK && ok
		}
		runPostCommands(a.PostCommands, actionMessage)
		writeState(a)
	} else {
		stopFailoverProxy(a.RuleID, a.SourcePort)
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

func logActionPortHandoff(a action) {
	if a.SourcePort <= 0 {
		return
	}
	port := strconv.Itoa(a.SourcePort)
	localRuleID := readRuleIDByPort(port)
	localForwardType := readForwardTypeByPort(port)
	if localRuleID <= 0 && localForwardType == "" {
		return
	}
	if a.Op == "apply" && (localRuleID != a.RuleID || (localForwardType != "" && localForwardType != a.ForwardType)) {
		logf(
			"runtime handoff port=%d oldRule=%d oldForwardType=%s newRule=%d newForwardType=%s tunnel=%d hasFXP=%v commands=%d",
			a.SourcePort,
			localRuleID,
			localForwardType,
			a.RuleID,
			a.ForwardType,
			a.TunnelID,
			a.Fxp != nil,
			len(a.Commands),
		)
	}
	if a.Op == "remove" {
		logf(
			"runtime remove port=%d localRule=%d localForwardType=%s rule=%d forwardType=%s tunnel=%d hasFXP=%v commands=%d",
			a.SourcePort,
			localRuleID,
			localForwardType,
			a.RuleID,
			a.ForwardType,
			a.TunnelID,
			a.Fxp != nil,
			len(a.Commands),
		)
	}
}

func cleanupStaleRuntimeBeforeApply(a action) bool {
	if a.Op != "apply" || a.SourcePort <= 0 {
		return false
	}
	port := strconv.Itoa(a.SourcePort)
	if a.StatusType == "tunnel" && a.TunnelID > 0 {
		localTunnelID := readTunnelIDByPort(port)
		localForwardType := readTunnelForwardTypeByPort(port)
		if localTunnelID <= 0 && localForwardType == "" {
			if fxpMatchesRunning(a.Fxp) {
				writeState(a)
				return true
			}
			if actionUsesManagedListener(a) {
				cleanupUnknownManagedListener(port, a.SourcePort, a.ForwardType)
				waitForActionListenPortFree(a, 2*time.Second)
			}
			return false
		}
		if localTunnelID == a.TunnelID && (localForwardType == "" || localForwardType == a.ForwardType) {
			if fxpMatchesRunning(a.Fxp) {
				writeState(a)
				return true
			}
			return false
		}
		logf(
			"tunnel runtime cleanup before apply port=%d oldTunnel=%d oldForwardType=%s newTunnel=%d newForwardType=%s",
			a.SourcePort,
			localTunnelID,
			localForwardType,
			a.TunnelID,
			a.ForwardType,
		)
		if localForwardType == "forwardx-tunnel" && localTunnelID > 0 {
			stopFXPByPort(localTunnelID, a.SourcePort)
		}
		if a.Fxp != nil {
			stopFXPByListenPort(a.SourcePort)
		}
		for _, cmd := range managedPortCleanupCmds(port) {
			_ = runShell(cmd)
		}
		waitForActionListenPortFree(a, 2*time.Second)
		removeTunnelStateByPort(port)
		return false
	}
	if a.RuleID <= 0 {
		return false
	}
	localRuleID := readRuleIDByPort(port)
	localForwardType := readForwardTypeByPort(port)
	if localRuleID <= 0 && localForwardType == "" {
		if fxpMatchesRunning(a.Fxp) {
			writeState(a)
			return true
		}
		if actionUsesManagedListener(a) {
			cleanupUnknownManagedListener(port, a.SourcePort, a.ForwardType)
			waitForActionListenPortFree(a, 2*time.Second)
		}
		return false
	}
	if localRuleID == a.RuleID && (localForwardType == "" || localForwardType == a.ForwardType) {
		if fxpMatchesRunning(a.Fxp) {
			writeState(a)
			return true
		}
		return false
	}
	logf(
		"runtime cleanup before apply port=%d oldRule=%d oldForwardType=%s newRule=%d newForwardType=%s",
		a.SourcePort,
		localRuleID,
		localForwardType,
		a.RuleID,
		a.ForwardType,
	)
	if localForwardType == "forwardx" && localRuleID > 0 {
		stopFXP(fxpSpec{Role: "entry", RuleID: localRuleID, ListenPort: a.SourcePort, Protocol: "both"})
	}
	if a.Fxp != nil {
		stopFXPByListenPort(a.SourcePort)
	}
	if localRuleID > 0 {
		stopFailoverProxy(localRuleID, a.SourcePort)
	}
	if localForwardType == "nftables" && localRuleID > 0 {
		_ = runShell(nftRuleCleanupCmd(localRuleID))
	}
	for _, cmd := range managedPortCleanupCmds(port) {
		_ = runShell(cmd)
	}
	waitForActionListenPortFree(a, 2*time.Second)
	return false
}

func actionUsesManagedListener(a action) bool {
	if a.Fxp != nil {
		return true
	}
	switch a.ForwardType {
	case "realm", "socat", "gost", "forwardx", "forwardx-tunnel", "gost-tunnel":
		return true
	default:
		return false
	}
}

func cleanupUnknownManagedListener(port string, listenPort int, forwardType string) {
	logf("runtime cleanup unknown local state port=%s newForwardType=%s", port, forwardType)
	stopFXPByListenPort(listenPort)
	for _, cmd := range managedListenerCleanupCmds(port) {
		_ = runShell(cmd)
	}
}

func fxpMatchesRunning(spec *fxpSpec) bool {
	if spec == nil {
		return false
	}
	normalized := *spec
	normalized.Role = strings.ToLower(strings.TrimSpace(normalized.Role))
	normalized.Protocol = normalizeRuntimeProtocol(normalized.Protocol)
	id := fxpServerID(normalized)
	signature := fxpServerSignature(normalized)
	configPath := fxpConfigPath(normalized)
	fxpMu.Lock()
	existing := fxpServers[id]
	matches := existing != nil && existing.signature == signature && fxpProcessActive(existing)
	if existing != nil && !matches {
		delete(fxpServers, id)
	}
	fxpMu.Unlock()
	if !matches {
		matches = adoptExistingFXP(normalized, signature, configPath)
	}
	if matches {
		logf("fxp %s already running with matching runtime tunnel=%d rule=%d listen=:%d protocol=%s", normalized.Role, normalized.TunnelID, normalized.RuleID, normalized.ListenPort, normalized.Protocol)
	}
	return matches
}

func waitForActionListenPortFree(a action, timeout time.Duration) bool {
	spec := a.Fxp
	if spec == nil && a.SourcePort > 0 {
		spec = &fxpSpec{ListenPort: a.SourcePort, Protocol: a.Protocol}
	}
	return waitForFXPListenPortFree(spec, a.SourcePort, timeout)
}

func runPostCommands(commands []string, actionMessage *actionMessage) {
	if len(commands) == 0 {
		return
	}
	failed := 0
	for _, cmd := range commands {
		if !runShell(cmd) {
			failed++
		}
	}
	if failed > 0 {
		actionMessage.remember("non-critical post apply commands failed=%d; forwarding service may still be running", failed)
		logf("post apply commands completed with failures=%d total=%d", failed, len(commands))
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
	if a.StatusType == "tunnel" && a.TunnelID > 0 && a.SourcePort > 0 {
		writeTunnelState(a)
		return
	}
	if a.RuleID <= 0 {
		return
	}
	_ = os.MkdirAll("/var/lib/forwardx-agent", 0755)
	port := strconv.Itoa(a.SourcePort)
	resetTrafficStateIfRuleChanged(port, a.RuleID)
	_ = os.WriteFile("/var/lib/forwardx-agent/port_"+port+".rule", []byte(strconv.Itoa(a.RuleID)), 0644)
	_ = os.WriteFile("/var/lib/forwardx-agent/port_"+port+".fwtype", []byte(a.ForwardType), 0644)
	if a.TargetIP != "" && a.TargetPort > 0 {
		_ = os.WriteFile("/var/lib/forwardx-agent/target_"+port+".info", []byte(fmt.Sprintf("%s\n%d\n", a.TargetIP, a.TargetPort)), 0644)
	}
}

func writeTunnelState(a action) {
	_ = os.MkdirAll("/var/lib/forwardx-agent", 0755)
	port := strconv.Itoa(a.SourcePort)
	_ = os.WriteFile("/var/lib/forwardx-agent/tunnel_"+port+".id", []byte(strconv.Itoa(a.TunnelID)), 0644)
	_ = os.WriteFile("/var/lib/forwardx-agent/tunnel_"+port+".fwtype", []byte(a.ForwardType), 0644)
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

func readTunnelIDByPort(port string) int {
	b, err := os.ReadFile("/var/lib/forwardx-agent/tunnel_" + port + ".id")
	if err != nil {
		return 0
	}
	id, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return id
}

func readTunnelForwardTypeByPort(port string) string {
	b, err := os.ReadFile("/var/lib/forwardx-agent/tunnel_" + port + ".fwtype")
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

func syncRunningRuleState(rules []runningRule, protectedPorts map[string]bool) {
	wanted := map[string]bool{}
	wantedFailover := map[string]bool{}
	for _, r := range rules {
		if r.RuleID <= 0 || r.SourcePort <= 0 {
			continue
		}
		wanted[strconv.Itoa(r.SourcePort)] = true
		if r.Failover != nil && r.Failover.Enabled {
			wantedFailover[failoverID(r.RuleID, r.SourcePort)] = true
			startFailoverProxy(r.RuleID, r.SourcePort, *r.Failover, nil)
		}
	}
	failoverMu.Lock()
	staleFailovers := make([]*failoverProxy, 0)
	for id, proxy := range failoverProxies {
		if !wantedFailover[id] {
			staleFailovers = append(staleFailovers, proxy)
		}
	}
	failoverMu.Unlock()
	for _, proxy := range staleFailovers {
		stopFailoverProxy(proxy.ruleID, proxy.sourcePort)
	}
	files, _ := os.ReadDir("/var/lib/forwardx-agent")
	for _, f := range files {
		name := f.Name()
		if !strings.HasPrefix(name, "port_") || !strings.HasSuffix(name, ".rule") {
			continue
		}
		port := strings.TrimSuffix(strings.TrimPrefix(name, "port_"), ".rule")
		if !wanted[port] {
			if protectedPorts[port] {
				logf("reconcile skip pending action port=%s", port)
				continue
			}
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
	if ruleID > 0 {
		stopFailoverProxy(ruleID, atoi(port))
	}
	if forwardType == "nftables" && ruleID > 0 {
		_ = runShell(nftRuleCleanupCmd(ruleID))
	}
	for _, cmd := range managedPortCleanupCmds(port) {
		_ = runShell(cmd)
	}
}

func nftRuleCleanupCmd(ruleID int) string {
	id := strconv.Itoa(ruleID)
	comment := "fwx-rule-" + id
	return "nft list table inet forwardx >/dev/null 2>&1 && { for c in prerouting postrouting forward traffic_prerouting traffic_postrouting; do for h in $(nft -a list chain inet forwardx \"$c\" 2>/dev/null | awk -v marker=\"" + comment + "\" '$0 ~ marker {print $NF}'); do nft delete rule inet forwardx \"$c\" handle \"$h\" 2>/dev/null || true; done; done; nft flush chain inet forwardx in_" + id + " 2>/dev/null || true; nft delete chain inet forwardx in_" + id + " 2>/dev/null || true; nft flush chain inet forwardx out_" + id + " 2>/dev/null || true; nft delete chain inet forwardx out_" + id + " 2>/dev/null || true; } || true"
}

func managedPortCleanupCmds(port string) []string {
	cmds := append(managedListenerCleanupCmds(port),
		"systemctl stop forwardx-socat-"+port+".service forwardx-socat-tcp-"+port+".service forwardx-socat-udp-"+port+".service forwardx-realm-"+port+".service 2>/dev/null || true",
		"systemctl disable forwardx-socat-"+port+".service forwardx-socat-tcp-"+port+".service forwardx-socat-udp-"+port+".service forwardx-realm-"+port+".service 2>/dev/null || true",
		"rm -f /etc/systemd/system/forwardx-socat-"+port+".service /etc/systemd/system/forwardx-socat-tcp-"+port+".service /etc/systemd/system/forwardx-socat-udp-"+port+".service /etc/systemd/system/forwardx-realm-"+port+".service",
		"systemctl daemon-reload",
		"iptables -t mangle -D PREROUTING -p tcp --dport "+port+" -m comment --comment \"fwx-stat-"+port+":in\" 2>/dev/null || true",
		"iptables -t mangle -D PREROUTING -p udp --dport "+port+" -m comment --comment \"fwx-stat-"+port+":in\" 2>/dev/null || true",
		"iptables -t mangle -D INPUT -p tcp --dport "+port+" -m comment --comment \"fwx-stat-"+port+":in\" 2>/dev/null || true",
		"iptables -t mangle -D INPUT -p udp --dport "+port+" -m comment --comment \"fwx-stat-"+port+":in\" 2>/dev/null || true",
		"iptables -t mangle -D POSTROUTING -p tcp --sport "+port+" -m comment --comment \"fwx-stat-"+port+":out\" 2>/dev/null || true",
		"iptables -t mangle -D POSTROUTING -p udp --sport "+port+" -m comment --comment \"fwx-stat-"+port+":out\" 2>/dev/null || true",
		"iptables -t mangle -D OUTPUT -p tcp --sport "+port+" -m comment --comment \"fwx-stat-"+port+":out\" 2>/dev/null || true",
		"iptables -t mangle -D OUTPUT -p udp --sport "+port+" -m comment --comment \"fwx-stat-"+port+":out\" 2>/dev/null || true",
		"iptables -t mangle -D PREROUTING -p tcp --dport "+port+" -j FWX_IN_"+port+" 2>/dev/null || true",
		"iptables -t mangle -D PREROUTING -p udp --dport "+port+" -j FWX_IN_"+port+" 2>/dev/null || true",
		"iptables -t mangle -D POSTROUTING -p tcp --sport "+port+" -j FWX_OUT_"+port+" 2>/dev/null || true",
		"iptables -t mangle -D POSTROUTING -p udp --sport "+port+" -j FWX_OUT_"+port+" 2>/dev/null || true",
		"iptables -t mangle -D INPUT -p tcp --dport "+port+" -j FWX_IN_"+port+" 2>/dev/null || true",
		"iptables -t mangle -D INPUT -p udp --dport "+port+" -j FWX_IN_"+port+" 2>/dev/null || true",
		"iptables -t mangle -D OUTPUT -p tcp --sport "+port+" -j FWX_OUT_"+port+" 2>/dev/null || true",
		"iptables -t mangle -D OUTPUT -p udp --sport "+port+" -j FWX_OUT_"+port+" 2>/dev/null || true",
		"iptables -t mangle -D FORWARD -p tcp -j FWX_IN_"+port+" 2>/dev/null || true",
		"iptables -t mangle -D FORWARD -p udp -j FWX_IN_"+port+" 2>/dev/null || true",
		"iptables -t mangle -D FORWARD -p tcp -j FWX_OUT_"+port+" 2>/dev/null || true",
		"iptables -t mangle -D FORWARD -p udp -j FWX_OUT_"+port+" 2>/dev/null || true",
		"iptables -t mangle -F FWX_IN_"+port+" 2>/dev/null || true",
		"iptables -t mangle -X FWX_IN_"+port+" 2>/dev/null || true",
		"iptables -t mangle -F FWX_OUT_"+port+" 2>/dev/null || true",
		"iptables -t mangle -X FWX_OUT_"+port+" 2>/dev/null || true",
		"rm -f /var/lib/forwardx-agent/traffic_"+port+".prev /var/lib/forwardx-agent/port_"+port+".rule /var/lib/forwardx-agent/port_"+port+".fwtype /var/lib/forwardx-agent/target_"+port+".info 2>/dev/null || true",
	)
	if targetIP, targetPort, ok := readTargetInfo(port); ok {
		tp := strconv.Itoa(targetPort)
		targetCmds := []string{
			"iptables -t nat -D PREROUTING -p tcp --dport " + port + " -j DNAT --to-destination " + targetIP + ":" + tp + " 2>/dev/null || true",
			"iptables -t nat -D PREROUTING -p udp --dport " + port + " -j DNAT --to-destination " + targetIP + ":" + tp + " 2>/dev/null || true",
			"iptables -t nat -D POSTROUTING -p tcp -d " + targetIP + " --dport " + tp + " -j MASQUERADE 2>/dev/null || true",
			"iptables -t nat -D POSTROUTING -p udp -d " + targetIP + " --dport " + tp + " -j MASQUERADE 2>/dev/null || true",
			"iptables -D FORWARD -p tcp -d " + targetIP + " --dport " + tp + " -j ACCEPT 2>/dev/null || true",
			"iptables -D FORWARD -p udp -d " + targetIP + " --dport " + tp + " -j ACCEPT 2>/dev/null || true",
			"iptables -D FORWARD -p tcp -s " + targetIP + " --sport " + tp + " -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true",
			"iptables -D FORWARD -p udp -s " + targetIP + " --sport " + tp + " -j ACCEPT 2>/dev/null || true",
			"iptables -t mangle -D FORWARD -p tcp -d " + targetIP + " --dport " + tp + " -m comment --comment \"fwx-stat-" + port + ":in\" 2>/dev/null || true",
			"iptables -t mangle -D FORWARD -p udp -d " + targetIP + " --dport " + tp + " -m comment --comment \"fwx-stat-" + port + ":in\" 2>/dev/null || true",
			"iptables -t mangle -D FORWARD -p tcp -s " + targetIP + " --sport " + tp + " -m comment --comment \"fwx-stat-" + port + ":out\" 2>/dev/null || true",
			"iptables -t mangle -D FORWARD -p udp -s " + targetIP + " --sport " + tp + " -m comment --comment \"fwx-stat-" + port + ":out\" 2>/dev/null || true",
			"iptables -t mangle -D FORWARD -p tcp -d " + targetIP + " --dport " + tp + " -j FWX_IN_" + port + " 2>/dev/null || true",
			"iptables -t mangle -D FORWARD -p udp -d " + targetIP + " --dport " + tp + " -j FWX_IN_" + port + " 2>/dev/null || true",
			"iptables -t mangle -D FORWARD -p tcp -s " + targetIP + " --sport " + tp + " -j FWX_OUT_" + port + " 2>/dev/null || true",
			"iptables -t mangle -D FORWARD -p udp -s " + targetIP + " --sport " + tp + " -j FWX_OUT_" + port + " 2>/dev/null || true",
		}
		cmds = append(targetCmds, cmds...)
	}
	return cmds
}

func managedListenerCleanupCmds(port string) []string {
	cmds := append([]string{}, fxpPortCleanupCmds(port)...)
	cmds = append(cmds,
		"for pid in $(pgrep -f '[s]ocat .*LISTEN:"+port+"' 2>/dev/null || true); do if [ \"$pid\" = \"$$\" ] || [ \"$pid\" = \"$PPID\" ]; then continue; fi; kill \"$pid\" 2>/dev/null || true; done",
		"for pid in $(pgrep -f '[r]ealm .*:"+port+"' 2>/dev/null || true); do if [ \"$pid\" = \"$$\" ] || [ \"$pid\" = \"$PPID\" ]; then continue; fi; kill \"$pid\" 2>/dev/null || true; done",
	)
	return cmds
}

func fxpPortCleanupCmds(port string) []string {
	return []string{
		"for pid in $(pgrep -f '[f]orwardx-fxp.*fxp-.*-" + port + "\\.json' 2>/dev/null || true); do if [ \"$pid\" = \"$$\" ] || [ \"$pid\" = \"$PPID\" ]; then continue; fi; kill \"$pid\" 2>/dev/null || true; done",
		"rm -f /run/forwardx-agent/fxp-*-" + port + ".json 2>/dev/null || true",
	}
}

func removeStateByPort(port string) {
	_ = os.Remove("/var/lib/forwardx-agent/port_" + port + ".rule")
	_ = os.Remove("/var/lib/forwardx-agent/port_" + port + ".fwtype")
	_ = os.Remove("/var/lib/forwardx-agent/target_" + port + ".info")
	_ = os.Remove("/var/lib/forwardx-agent/traffic_" + port + ".prev")
	removeTunnelStateByPort(port)
}

func removeTunnelStateByPort(port string) {
	_ = os.Remove("/var/lib/forwardx-agent/tunnel_" + port + ".id")
	_ = os.Remove("/var/lib/forwardx-agent/tunnel_" + port + ".fwtype")
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
	inMarker := "fwx-stat-" + p + ":in"
	outMarker := "fwx-stat-" + p + ":out"
	protos := []string{"tcp", "udp"}
	if protocol == "tcp" || protocol == "udp" {
		protos = []string{protocol}
	}
	commands := []string{
		"iptables -t mangle -D PREROUTING -p tcp --dport " + p + " -j FWX_IN_" + p + " 2>/dev/null || true",
		"iptables -t mangle -D PREROUTING -p udp --dport " + p + " -j FWX_IN_" + p + " 2>/dev/null || true",
		"iptables -t mangle -D INPUT -p tcp --dport " + p + " -j FWX_IN_" + p + " 2>/dev/null || true",
		"iptables -t mangle -D INPUT -p udp --dport " + p + " -j FWX_IN_" + p + " 2>/dev/null || true",
		"iptables -t mangle -D POSTROUTING -p tcp --sport " + p + " -j FWX_OUT_" + p + " 2>/dev/null || true",
		"iptables -t mangle -D POSTROUTING -p udp --sport " + p + " -j FWX_OUT_" + p + " 2>/dev/null || true",
		"iptables -t mangle -D OUTPUT -p tcp --sport " + p + " -j FWX_OUT_" + p + " 2>/dev/null || true",
		"iptables -t mangle -D OUTPUT -p udp --sport " + p + " -j FWX_OUT_" + p + " 2>/dev/null || true",
	}
	for _, proto := range protos {
		commands = append(commands,
			"iptables -t mangle -C PREROUTING -p "+proto+" --dport "+p+" -m comment --comment \""+inMarker+"\" 2>/dev/null || iptables -t mangle -A PREROUTING -p "+proto+" --dport "+p+" -m comment --comment \""+inMarker+"\"",
			"iptables -t mangle -C INPUT -p "+proto+" --dport "+p+" -m comment --comment \""+inMarker+"\" 2>/dev/null || iptables -t mangle -A INPUT -p "+proto+" --dport "+p+" -m comment --comment \""+inMarker+"\"",
			"iptables -t mangle -C POSTROUTING -p "+proto+" --sport "+p+" -m comment --comment \""+outMarker+"\" 2>/dev/null || iptables -t mangle -A POSTROUTING -p "+proto+" --sport "+p+" -m comment --comment \""+outMarker+"\"",
			"iptables -t mangle -C OUTPUT -p "+proto+" --sport "+p+" -m comment --comment \""+outMarker+"\" 2>/dev/null || iptables -t mangle -A OUTPUT -p "+proto+" --sport "+p+" -m comment --comment \""+outMarker+"\"",
		)
		if targetIP != "" && targetPort > 0 {
			tp := strconv.Itoa(targetPort)
			commands = append(commands,
				"iptables -t mangle -D OUTPUT -p "+proto+" -d "+targetIP+" --dport "+tp+" -j FWX_IN_"+p+" 2>/dev/null || true",
				"iptables -t mangle -D POSTROUTING -p "+proto+" -d "+targetIP+" --dport "+tp+" -j FWX_IN_"+p+" 2>/dev/null || true",
				"iptables -t mangle -D PREROUTING -p "+proto+" -s "+targetIP+" --sport "+tp+" -j FWX_OUT_"+p+" 2>/dev/null || true",
				"iptables -t mangle -D INPUT -p "+proto+" -s "+targetIP+" --sport "+tp+" -j FWX_OUT_"+p+" 2>/dev/null || true",
				"iptables -t mangle -D FORWARD -p "+proto+" -d "+targetIP+" --dport "+tp+" -j FWX_IN_"+p+" 2>/dev/null || true",
				"iptables -t mangle -D FORWARD -p "+proto+" -s "+targetIP+" --sport "+tp+" -j FWX_OUT_"+p+" 2>/dev/null || true",
				"iptables -t mangle -C FORWARD -p "+proto+" -d "+targetIP+" --dport "+tp+" -m comment --comment \""+inMarker+"\" 2>/dev/null || iptables -t mangle -A FORWARD -p "+proto+" -d "+targetIP+" --dport "+tp+" -m comment --comment \""+inMarker+"\"",
				"iptables -t mangle -C FORWARD -p "+proto+" -s "+targetIP+" --sport "+tp+" -m comment --comment \""+outMarker+"\" 2>/dev/null || iptables -t mangle -A FORWARD -p "+proto+" -s "+targetIP+" --sport "+tp+" -m comment --comment \""+outMarker+"\"",
			)
		}
	}
	commands = append(commands,
		"iptables -t mangle -F FWX_IN_"+p+" 2>/dev/null || true",
		"iptables -t mangle -X FWX_IN_"+p+" 2>/dev/null || true",
		"iptables -t mangle -F FWX_OUT_"+p+" 2>/dev/null || true",
		"iptables -t mangle -X FWX_OUT_"+p+" 2>/dev/null || true",
	)
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
	removeTunnelStateByPort(p)
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

func fxpConfigPath(spec fxpSpec) string {
	role := strings.ToLower(strings.TrimSpace(spec.Role))
	return fmt.Sprintf("/run/forwardx-agent/fxp-%s-%d-%d-%d.json", role, spec.TunnelID, spec.RuleID, spec.ListenPort)
}

func fxpProcessActive(process *fxpProcess) bool {
	if process == nil {
		return false
	}
	if process.cmd != nil && process.cmd.Process != nil {
		return true
	}
	if process.configPath != "" {
		return fxpRuntimeProcessExists(process.configPath)
	}
	return false
}

func fxpRuntimePIDs(configPath string) []int {
	configPath = strings.TrimSpace(configPath)
	if configPath == "" {
		return nil
	}
	patterns := []string{
		`[f]orwardx-fxp.*` + regexp.QuoteMeta(configPath),
		`[f]orwardx-fxp.*` + regexp.QuoteMeta(filepath.Base(configPath)),
	}
	seen := map[int]bool{}
	pids := []int{}
	for _, pattern := range patterns {
		out, err := exec.Command("pgrep", "-f", pattern).Output()
		if err != nil {
			continue
		}
		for _, line := range strings.Fields(string(out)) {
			pid, err := strconv.Atoi(strings.TrimSpace(line))
			if err != nil || pid <= 0 || pid == os.Getpid() || seen[pid] {
				continue
			}
			seen[pid] = true
			pids = append(pids, pid)
		}
	}
	return pids
}

func fxpRuntimeProcessExists(configPath string) bool {
	return len(fxpRuntimePIDs(configPath)) > 0
}

func killFXPByConfigPath(configPath string) {
	for _, pid := range fxpRuntimePIDs(configPath) {
		if proc, err := os.FindProcess(pid); err == nil {
			_ = proc.Kill()
		}
	}
}

func adoptExistingFXP(spec fxpSpec, signature string, configPath string) bool {
	raw, err := os.ReadFile(configPath)
	if err != nil {
		return false
	}
	var existing fxpSpec
	if err := json.Unmarshal(raw, &existing); err != nil {
		return false
	}
	existing.Role = strings.ToLower(strings.TrimSpace(existing.Role))
	existing.Protocol = normalizeRuntimeProtocol(existing.Protocol)
	if fxpServerSignature(existing) != signature {
		return false
	}
	if !fxpRuntimeProcessExists(configPath) {
		return false
	}
	id := fxpServerID(spec)
	fxpMu.Lock()
	fxpServers[id] = &fxpProcess{signature: signature, configPath: configPath}
	fxpMu.Unlock()
	logf("fxp %s adopted existing runtime tunnel=%d rule=%d listen=:%d protocol=%s config=%s", spec.Role, spec.TunnelID, spec.RuleID, spec.ListenPort, spec.Protocol, configPath)
	return true
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
	spec.Role = strings.ToLower(strings.TrimSpace(spec.Role))
	spec.Protocol = normalizeRuntimeProtocol(spec.Protocol)

	id := fxpServerID(spec)
	signature := fxpServerSignature(spec)
	configPath := fxpConfigPath(spec)
	fxpMu.Lock()
	existing := fxpServers[id]
	if existing != nil && existing.signature == signature && fxpProcessActive(existing) {
		fxpMu.Unlock()
		logf("fxp %s already running tunnel=%d rule=%d listen=:%d protocol=%s", spec.Role, spec.TunnelID, spec.RuleID, spec.ListenPort, spec.Protocol)
		return true
	}
	if existing != nil {
		delete(fxpServers, id)
	}
	fxpMu.Unlock()
	if adoptExistingFXP(spec, signature, configPath) {
		return true
	}
	stopFXP(spec)
	stopFXPByListenPort(spec.ListenPort)
	for _, cmd := range fxpPortCleanupCmds(strconv.Itoa(spec.ListenPort)) {
		_ = runShell(cmd)
	}
	if !waitForFXPListenPortFree(&spec, spec.ListenPort, 3*time.Second) {
		owner := listenPortOwnerSummary(spec.ListenPort)
		actionMessage.set("fxp listen port still busy role=%s tunnel=%d rule=%d listen=:%d owner=%s", spec.Role, spec.TunnelID, spec.RuleID, spec.ListenPort, owner)
		return false
	}

	if err := os.MkdirAll("/run/forwardx-agent", 0700); err != nil {
		actionMessage.set("fxp create runtime dir failed: %v", err)
		return false
	}
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

	exited := make(chan error, 1)
	go func() {
		exited <- cmd.Wait()
	}()
	select {
	case err := <-exited:
		_ = os.Remove(configPath)
		if err != nil {
			actionMessage.set("fxp runtime exited immediately: %v", err)
		} else {
			actionMessage.set("fxp runtime exited immediately")
		}
		if owner := listenPortOwnerSummary(spec.ListenPort); owner != "" {
			logf("fxp listen port owner role=%s tunnel=%d rule=%d listen=:%d owner=%s", spec.Role, spec.TunnelID, spec.RuleID, spec.ListenPort, owner)
		}
		return false
	case <-time.After(300 * time.Millisecond):
	}

	fxpMu.Lock()
	fxpServers[id] = &fxpProcess{signature: signature, cmd: cmd, configPath: configPath}
	fxpMu.Unlock()
	go func() {
		err := <-exited
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
	spec.Role = strings.ToLower(strings.TrimSpace(spec.Role))
	spec.Protocol = normalizeRuntimeProtocol(spec.Protocol)
	id := fxpServerID(spec)
	fxpMu.Lock()
	s := fxpServers[id]
	if s != nil {
		delete(fxpServers, id)
	}
	fxpMu.Unlock()
	if s == nil {
		configPath := fxpConfigPath(spec)
		killFXPByConfigPath(configPath)
		_ = os.Remove(configPath)
		return
	}
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Signal(os.Interrupt)
		time.Sleep(500 * time.Millisecond)
		_ = s.cmd.Process.Kill()
	} else if s.configPath != "" {
		killFXPByConfigPath(s.configPath)
	}
	if s.configPath != "" {
		_ = os.Remove(s.configPath)
	}
}

func stopFXPByPort(tunnelID int, listenPort int) {
	if tunnelID <= 0 || listenPort <= 0 {
		return
	}
	prefix := ":" + strconv.Itoa(tunnelID) + ":"
	suffix := ":" + strconv.Itoa(listenPort)
	var specs []fxpSpec
	fxpMu.Lock()
	for id := range fxpServers {
		if strings.Contains(id, prefix) && strings.HasSuffix(id, suffix) {
			parts := strings.Split(id, ":")
			if len(parts) != 4 {
				continue
			}
			ruleID, _ := strconv.Atoi(parts[2])
			specs = append(specs, fxpSpec{
				Role:       parts[0],
				TunnelID:   tunnelID,
				RuleID:     ruleID,
				ListenPort: listenPort,
			})
		}
	}
	fxpMu.Unlock()
	for _, spec := range specs {
		stopFXP(spec)
	}
}

func stopFXPByListenPort(listenPort int) {
	if listenPort <= 0 {
		return
	}
	suffix := ":" + strconv.Itoa(listenPort)
	var specs []fxpSpec
	fxpMu.Lock()
	for id := range fxpServers {
		if !strings.HasSuffix(id, suffix) {
			continue
		}
		parts := strings.Split(id, ":")
		if len(parts) != 4 {
			continue
		}
		tunnelID, _ := strconv.Atoi(parts[1])
		ruleID, _ := strconv.Atoi(parts[2])
		specs = append(specs, fxpSpec{
			Role:       parts[0],
			TunnelID:   tunnelID,
			RuleID:     ruleID,
			ListenPort: listenPort,
		})
	}
	fxpMu.Unlock()
	for _, spec := range specs {
		stopFXP(spec)
	}
}

func waitForFXPListenPortFree(spec *fxpSpec, listenPort int, timeout time.Duration) bool {
	if spec == nil || listenPort <= 0 {
		return true
	}
	protos := runtimeProtocols(spec.Protocol)
	if len(protos) == 0 {
		protos = []string{"tcp"}
	}
	deadline := time.Now().Add(timeout)
	for {
		busy := false
		for _, proto := range protos {
			if listenPortBusy(proto, listenPort) {
				busy = true
				break
			}
		}
		if !busy {
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func listenPortBusy(proto string, port int) bool {
	if port <= 0 {
		return false
	}
	switch proto {
	case "udp":
		conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4zero, Port: port})
		if err != nil {
			return true
		}
		_ = conn.Close()
		return false
	default:
		ln, err := net.Listen("tcp", ":"+strconv.Itoa(port))
		if err != nil {
			return true
		}
		_ = ln.Close()
		return false
	}
}

func runtimeProtocols(protocol string) []string {
	switch normalizeRuntimeProtocol(protocol) {
	case "udp":
		return []string{"udp"}
	case "both":
		return []string{"tcp", "udp"}
	default:
		return []string{"tcp"}
	}
}

func normalizeRuntimeProtocol(protocol string) string {
	switch strings.ToLower(strings.TrimSpace(protocol)) {
	case "udp":
		return "udp"
	case "both", "tcp+udp":
		return "both"
	default:
		return "tcp"
	}
}

type protocolGuardServer struct {
	rule guardRule
	ln   net.Listener
	done chan struct{}
}

type lookingGlassTask struct {
	TaskID            string   `json:"taskId"`
	Method            string   `json:"method"`
	Target            string   `json:"target"`
	ResolvedAddress   string   `json:"resolvedAddress"`
	ResolvedAddresses []string `json:"resolvedAddresses"`
	Family            int      `json:"family"`
	Port              int      `json:"port"`
	CreatedAt         string   `json:"createdAt"`
}

type lookingGlassResult struct {
	TaskID            string   `json:"taskId"`
	Method            string   `json:"method"`
	Target            string   `json:"target"`
	Port              int      `json:"port,omitempty"`
	ResolvedAddress   string   `json:"resolvedAddress"`
	ResolvedAddresses []string `json:"resolvedAddresses"`
	Output            string   `json:"output"`
	ExitCode          *int     `json:"exitCode"`
	TimedOut          bool     `json:"timedOut"`
	DurationMs        int      `json:"durationMs"`
	StartedAt         string   `json:"startedAt"`
	FinishedAt        string   `json:"finishedAt"`
	Error             string   `json:"error,omitempty"`
}

type iperf3Task struct {
	TaskID    string `json:"taskId"`
	Op        string `json:"op"`
	Port      int    `json:"port"`
	CreatedAt string `json:"createdAt"`
}

type iperf3Result struct {
	TaskID    string `json:"taskId"`
	Op        string `json:"op"`
	Port      int    `json:"port"`
	Status    string `json:"status"`
	Output    string `json:"output"`
	PID       int    `json:"pid,omitempty"`
	StartedAt string `json:"startedAt,omitempty"`
	UpdatedAt string `json:"updatedAt,omitempty"`
	Error     string `json:"error,omitempty"`
}

type iperf3Process struct {
	taskID       string
	port         int
	cfg          Config
	cmd          *exec.Cmd
	startedAt    time.Time
	outputMu     sync.Mutex
	output       string
	done         chan struct{}
	doneOnce     sync.Once
	lastActivity atomic.Int64
}

func (p *iperf3Process) appendLine(line string) {
	line = strings.TrimSpace(line)
	if line == "" {
		return
	}
	p.lastActivity.Store(time.Now().UnixNano())
	p.outputMu.Lock()
	defer p.outputMu.Unlock()
	if p.output == "" {
		p.output = line
		return
	}
	if len(p.output) > 32000 {
		p.output = p.output[len(p.output)-24000:]
		p.output = "... 输出已截断\n" + p.output
	}
	p.output += "\n" + line
}

func (p *iperf3Process) currentOutput() string {
	p.outputMu.Lock()
	defer p.outputMu.Unlock()
	return strings.TrimSpace(p.output)
}

func (p *iperf3Process) readPipe(r io.Reader, wg *sync.WaitGroup) {
	defer wg.Done()
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 4096), 1024*1024)
	for scanner.Scan() {
		p.appendLine(scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		message := strings.ToLower(err.Error())
		if strings.Contains(message, "file already closed") || strings.Contains(message, "closed pipe") {
			return
		}
		p.appendLine(fmt.Sprintf("读取 iperf3 输出失败：%v", err))
	}
}

func (p *iperf3Process) watchIdleTimeout() {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			last := time.Unix(0, p.lastActivity.Load())
			if time.Since(last) < iperf3IdleTimeout {
				continue
			}
			var result *iperf3Result
			iperf3Mu.Lock()
			if iperf3Server == p {
				p.stopLocked("3 分钟无客户端测试，已自动停止 iperf3 服务端")
				iperf3Server = nil
				result = &iperf3Result{
					TaskID:    p.taskID,
					Op:        "stop",
					Port:      p.port,
					Status:    "stopped",
					Output:    p.currentOutput(),
					StartedAt: p.startedAt.Format(time.RFC3339Nano),
				}
			}
			iperf3Mu.Unlock()
			if result != nil {
				reportIperf3Result(p.cfg, *result)
			}
			return
		case <-p.done:
			return
		}
	}
}

func (p *iperf3Process) stopLocked(reason string) string {
	p.appendLine(reason)
	if p.cmd != nil && p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
	p.doneOnce.Do(func() { close(p.done) })
	return p.currentOutput()
}

func (p *iperf3Process) markExited(err error) {
	status := "stopped"
	errText := ""
	if err != nil && !strings.Contains(err.Error(), "killed") {
		status = "error"
		errText = fmt.Sprintf("iperf3 服务端异常退出：%v", err)
		p.appendLine(errText)
	} else {
		p.appendLine("iperf3 服务端已停止")
	}
	p.doneOnce.Do(func() { close(p.done) })
	var result *iperf3Result
	iperf3Mu.Lock()
	if iperf3Server == p {
		iperf3Server = nil
		result = &iperf3Result{
			TaskID:    p.taskID,
			Op:        "stop",
			Port:      p.port,
			Status:    status,
			Output:    p.currentOutput(),
			StartedAt: p.startedAt.Format(time.RFC3339Nano),
			Error:     errText,
		}
	}
	iperf3Mu.Unlock()
	if result != nil {
		reportIperf3Result(p.cfg, *result)
	}
}

type failoverProxy struct {
	ruleID         int
	sourcePort     int
	spec           failoverSpec
	signature      string
	activeIndex    int
	roundRobinNext int
	targetHealth   []bool
	failureSince   []time.Time
	recoveredSince []time.Time
	rng            *mathrand.Rand
	ln             net.Listener
	done           chan struct{}
	mu             sync.RWMutex
}

func failoverID(ruleID int, sourcePort int) string {
	return strconv.Itoa(ruleID) + ":" + strconv.Itoa(sourcePort)
}

func failoverSignature(spec failoverSpec) string {
	parts := []string{
		strconv.Itoa(spec.ListenPort),
		spec.BindAddress,
		spec.Protocol,
		spec.Strategy,
		strconv.Itoa(spec.FailoverSeconds),
		strconv.Itoa(spec.RecoverSeconds),
		strconv.FormatBool(spec.AutoFailback),
	}
	for _, target := range spec.Targets {
		parts = append(parts, target.TargetIP, strconv.Itoa(target.TargetPort))
	}
	return strings.Join(parts, "|")
}

func normalizeFailoverSpec(spec failoverSpec) failoverSpec {
	if spec.BindAddress == "" {
		spec.BindAddress = "127.0.0.1"
	}
	switch strings.TrimSpace(spec.Strategy) {
	case "round_robin", "random", "ip_hash", "fallback":
		spec.Strategy = strings.TrimSpace(spec.Strategy)
	default:
		spec.Strategy = "fallback"
	}
	if spec.FailoverSeconds <= 0 {
		spec.FailoverSeconds = 60
	}
	if spec.RecoverSeconds <= 0 {
		spec.RecoverSeconds = 120
	}
	cleaned := make([]failoverTarget, 0, len(spec.Targets))
	for _, target := range spec.Targets {
		target.TargetIP = strings.TrimSpace(target.TargetIP)
		if target.TargetIP == "" || target.TargetPort <= 0 || target.TargetPort > 65535 {
			continue
		}
		cleaned = append(cleaned, target)
		if len(cleaned) >= 11 {
			break
		}
	}
	spec.Targets = cleaned
	return spec
}

func startFailoverProxy(ruleID int, sourcePort int, spec failoverSpec, actionMessage *actionMessage) bool {
	spec = normalizeFailoverSpec(spec)
	if !spec.Enabled || spec.ListenPort <= 0 || len(spec.Targets) < 2 {
		return true
	}
	id := failoverID(ruleID, sourcePort)
	signature := failoverSignature(spec)
	failoverMu.Lock()
	existing := failoverProxies[id]
	if existing != nil && existing.signature == signature {
		failoverMu.Unlock()
		return true
	}
	failoverMu.Unlock()
	stopFailoverProxy(ruleID, sourcePort)

	addr := net.JoinHostPort(spec.BindAddress, strconv.Itoa(spec.ListenPort))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		if actionMessage != nil {
			actionMessage.set("failover proxy listen failed rule=%d addr=%s: %v", ruleID, addr, err)
		} else {
			logf("failover proxy listen failed rule=%d addr=%s: %v", ruleID, addr, err)
		}
		return false
	}
	p := &failoverProxy{
		ruleID:     ruleID,
		sourcePort: sourcePort,
		spec:       spec,
		signature:  signature,
		targetHealth: func() []bool {
			health := make([]bool, len(spec.Targets))
			for i := range health {
				health[i] = true
			}
			return health
		}(),
		failureSince:   make([]time.Time, len(spec.Targets)),
		recoveredSince: make([]time.Time, len(spec.Targets)),
		rng:            mathrand.New(mathrand.NewSource(time.Now().UnixNano() + int64(ruleID*100000+sourcePort))),
		ln:             ln,
		done:           make(chan struct{}),
	}
	failoverMu.Lock()
	failoverProxies[id] = p
	failoverMu.Unlock()
	go p.healthLoop()
	go p.acceptLoop()
	logf("failover proxy started rule=%d source=%d listen=%s strategy=%s targets=%d", ruleID, sourcePort, addr, spec.Strategy, len(spec.Targets))
	return true
}

func stopFailoverProxy(ruleID int, sourcePort int) {
	if ruleID <= 0 || sourcePort <= 0 {
		return
	}
	id := failoverID(ruleID, sourcePort)
	failoverMu.Lock()
	p := failoverProxies[id]
	if p != nil {
		delete(failoverProxies, id)
	}
	failoverMu.Unlock()
	if p == nil {
		return
	}
	close(p.done)
	_ = p.ln.Close()
}

func (p *failoverProxy) ensureHealthStateLocked() {
	n := len(p.spec.Targets)
	if len(p.targetHealth) != n {
		p.targetHealth = make([]bool, n)
		for i := range p.targetHealth {
			p.targetHealth[i] = true
		}
	}
	if len(p.failureSince) != n {
		p.failureSince = make([]time.Time, n)
	}
	if len(p.recoveredSince) != n {
		p.recoveredSince = make([]time.Time, n)
	}
	if p.activeIndex < 0 || p.activeIndex >= n {
		p.activeIndex = 0
	}
}

func failoverRemoteIP(conn net.Conn) string {
	if conn == nil || conn.RemoteAddr() == nil {
		return ""
	}
	host, _, err := net.SplitHostPort(conn.RemoteAddr().String())
	if err == nil {
		return host
	}
	return conn.RemoteAddr().String()
}

func failoverHashIndex(key string, count int) int {
	if count <= 0 {
		return 0
	}
	h := fnv.New32a()
	_, _ = h.Write([]byte(key))
	return int(h.Sum32() % uint32(count))
}

func (p *failoverProxy) candidateIndicesLocked(exclude map[int]bool, healthyOnly bool) []int {
	indices := make([]int, 0, len(p.spec.Targets))
	for i := range p.spec.Targets {
		if exclude != nil && exclude[i] {
			continue
		}
		if healthyOnly && !p.targetHealth[i] {
			continue
		}
		indices = append(indices, i)
	}
	return indices
}

func (p *failoverProxy) pickTarget(client net.Conn, exclude map[int]bool) (failoverTarget, int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ensureHealthStateLocked()
	if len(p.spec.Targets) == 0 {
		return failoverTarget{}, -1
	}
	candidates := p.candidateIndicesLocked(exclude, true)
	if len(candidates) == 0 {
		candidates = p.candidateIndicesLocked(exclude, false)
	}
	if len(candidates) == 0 {
		return failoverTarget{}, -1
	}
	index := candidates[0]
	switch p.spec.Strategy {
	case "round_robin":
		index = candidates[p.roundRobinNext%len(candidates)]
		p.roundRobinNext = (p.roundRobinNext + 1) % 1000000
	case "random":
		if p.rng == nil {
			p.rng = mathrand.New(mathrand.NewSource(time.Now().UnixNano()))
		}
		index = candidates[p.rng.Intn(len(candidates))]
	case "ip_hash":
		key := failoverRemoteIP(client)
		if key == "" {
			key = strconv.Itoa(p.sourcePort)
		}
		index = candidates[failoverHashIndex(key, len(candidates))]
	default:
		if !p.targetHealth[p.activeIndex] || (exclude != nil && exclude[p.activeIndex]) {
			index = candidates[0]
		} else {
			index = p.activeIndex
		}
	}
	return p.spec.Targets[index], index
}

func (p *failoverProxy) setActiveLocked(index int, reason string) {
	if index < 0 || index >= len(p.spec.Targets) || p.activeIndex == index {
		return
	}
	old := p.activeIndex
	p.activeIndex = index
	next := p.spec.Targets[index]
	logf("failover switch rule=%d source=%d %d->%d target=%s:%d reason=%s", p.ruleID, p.sourcePort, old, index, next.TargetIP, next.TargetPort, reason)
}

func (p *failoverProxy) updateFallbackActiveLocked(reason string) {
	if len(p.spec.Targets) == 0 || p.spec.Strategy != "fallback" {
		return
	}
	p.ensureHealthStateLocked()
	if p.targetHealth[p.activeIndex] {
		if !p.spec.AutoFailback {
			return
		}
		for i := 0; i < p.activeIndex; i++ {
			if p.targetHealth[i] {
				p.setActiveLocked(i, reason)
				return
			}
		}
		return
	}
	for i := range p.spec.Targets {
		if p.targetHealth[i] {
			p.setActiveLocked(i, reason)
			return
		}
	}
}

func (p *failoverProxy) markTargetFailure(index int, reason string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ensureHealthStateLocked()
	if index < 0 || index >= len(p.spec.Targets) {
		return
	}
	if p.targetHealth[index] {
		target := p.spec.Targets[index]
		p.targetHealth[index] = false
		p.failureSince[index] = time.Now()
		p.recoveredSince[index] = time.Time{}
		logf("failover target unhealthy rule=%d source=%d index=%d target=%s:%d reason=%s", p.ruleID, p.sourcePort, index, target.TargetIP, target.TargetPort, reason)
	}
	p.updateFallbackActiveLocked(reason)
}

func (p *failoverProxy) healthLoop() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-p.done:
			return
		case <-ticker.C:
			p.checkHealth()
		}
	}
}

func (p *failoverProxy) checkHealth() {
	now := time.Now()
	p.mu.RLock()
	targets := append([]failoverTarget(nil), p.spec.Targets...)
	failoverSeconds := p.spec.FailoverSeconds
	recoverSeconds := p.spec.RecoverSeconds
	p.mu.RUnlock()
	if len(targets) == 0 {
		return
	}
	results := make([]bool, len(targets))
	for i, target := range targets {
		_, results[i] = tcpLatency(target.TargetIP, target.TargetPort, 2*time.Second)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ensureHealthStateLocked()
	for i, ok := range results {
		if i >= len(p.spec.Targets) {
			break
		}
		target := p.spec.Targets[i]
		if ok {
			p.failureSince[i] = time.Time{}
			if !p.targetHealth[i] {
				if p.recoveredSince[i].IsZero() {
					p.recoveredSince[i] = now
				} else if now.Sub(p.recoveredSince[i]) >= time.Duration(recoverSeconds)*time.Second {
					p.targetHealth[i] = true
					p.recoveredSince[i] = time.Time{}
					logf("failover target recovered rule=%d source=%d index=%d target=%s:%d", p.ruleID, p.sourcePort, i, target.TargetIP, target.TargetPort)
				}
			} else {
				p.recoveredSince[i] = time.Time{}
			}
			continue
		}
		p.recoveredSince[i] = time.Time{}
		if p.targetHealth[i] {
			if p.failureSince[i].IsZero() {
				p.failureSince[i] = now
			} else if now.Sub(p.failureSince[i]) >= time.Duration(failoverSeconds)*time.Second {
				p.targetHealth[i] = false
				p.failureSince[i] = time.Time{}
				logf("failover target unhealthy rule=%d source=%d index=%d target=%s:%d reason=health check", p.ruleID, p.sourcePort, i, target.TargetIP, target.TargetPort)
			}
		}
	}
	p.updateFallbackActiveLocked("health check")
}

func (p *failoverProxy) acceptLoop() {
	for {
		client, err := p.ln.Accept()
		if err != nil {
			select {
			case <-p.done:
				return
			default:
				logf("failover accept failed rule=%d: %v", p.ruleID, err)
				continue
			}
		}
		go p.handleConn(client)
	}
}

func (p *failoverProxy) handleConn(client net.Conn) {
	defer client.Close()
	var upstream net.Conn
	var target failoverTarget
	var index int
	var err error
	attempted := map[int]bool{}
	for {
		target, index = p.pickTarget(client, attempted)
		if index < 0 {
			logf("failover no target available rule=%d source=%d", p.ruleID, p.sourcePort)
			return
		}
		upstream, err = net.DialTimeout("tcp", net.JoinHostPort(target.TargetIP, strconv.Itoa(target.TargetPort)), 10*time.Second)
		if err == nil {
			break
		}
		attempted[index] = true
		p.markTargetFailure(index, "dial failed")
		if len(attempted) >= len(p.spec.Targets) {
			break
		}
	}
	if err != nil {
		p.checkHealth()
		target, index = p.pickTarget(client, attempted)
		if index >= 0 {
			upstream, err = net.DialTimeout("tcp", net.JoinHostPort(target.TargetIP, strconv.Itoa(target.TargetPort)), 10*time.Second)
		} else {
			logf("failover dial failed rule=%d no target available after trying %d targets: %v", p.ruleID, len(attempted), err)
			return
		}
		if err != nil {
			logf("failover dial failed rule=%d target=%s:%d: %v", p.ruleID, target.TargetIP, target.TargetPort, err)
			return
		}
	}
	defer upstream.Close()
	copyDone := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(upstream, client)
		if c, ok := upstream.(*net.TCPConn); ok {
			_ = c.CloseWrite()
		}
		copyDone <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(client, upstream)
		if c, ok := client.(*net.TCPConn); ok {
			_ = c.CloseWrite()
		}
		copyDone <- struct{}{}
	}()
	<-copyDone
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
	now := time.Now()
	if !atomic.CompareAndSwapInt32(&upgradeStarted, 0, 1) {
		startedAt := time.Unix(atomic.LoadInt64(&upgradeStartedAt), 0)
		if startedAt.IsZero() || now.Sub(startedAt) < selfUpgradeLockTimeout {
			logf("self-upgrade already started at %s, ignoring duplicate request", startedAt.Format(time.RFC3339))
			return
		}
		logf("self-upgrade lock expired after %s, allowing retry", now.Sub(startedAt).Round(time.Second))
		atomic.StoreInt64(&upgradeStartedAt, now.Unix())
	} else {
		atomic.StoreInt64(&upgradeStartedAt, now.Unix())
	}
	panel := strings.TrimRight(up.PanelURL, "/")
	if panel == "" {
		panel = cfg.PanelURL
	}
	upgradeCmd := fmt.Sprintf(`sleep 1; curl -fsSL --max-time 20 "%s/api/agent/install.sh" | bash -s -- upgrade %s`, panel, shellQuote(cfg.Token))
	cmd := fmt.Sprintf(`if command -v systemd-run >/dev/null 2>&1; then systemd-run --unit=forwardx-agent-upgrade --collect /bin/sh -lc %s; else nohup sh -lc %s >/var/log/forwardx-agent/agent-upgrade.log 2>&1 < /dev/null & fi`, shellQuote(upgradeCmd), shellQuote(upgradeCmd))
	logf("self-upgrade requested target=%s", up.TargetVersion)
	if !runShell(cmd) {
		atomic.StoreInt32(&upgradeStarted, 0)
		atomic.StoreInt64(&upgradeStartedAt, 0)
	}
}

func post(cfg Config, path string, payload any, out any) error {
	err := postOnce(cfg, path, payload, out)
	if err == nil {
		return nil
	}
	if syncSystemTimeForCommError(err) {
		logf("retrying agent request after time sync path=%s", path)
		return postOnce(cfg, path, payload, out)
	}
	return err
}

func postOnce(cfg Config, path string, payload any, out any) error {
	env, err := encrypt(map[string]any{
		"path":    path,
		"payload": payload,
	}, cfg.Token)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(env)
	req, err := http.NewRequest("POST", cfg.PanelURL+"/api/sync", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
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

func isClockSyncCandidateError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "timestamp") || strings.Contains(msg, "replay protection") {
		return true
	}
	if strings.Contains(msg, "400 bad request") || strings.Contains(msg, "401 unauthorized") {
		return true
	}
	if strings.Contains(msg, "event stream status: 400") || strings.Contains(msg, "event stream status: 401") {
		return true
	}
	if strings.Contains(msg, "invalid encrypted request") || strings.Contains(msg, "decryption failed") {
		return true
	}
	return false
}

func syncSystemTimeForCommError(err error) bool {
	if !isClockSyncCandidateError(err) {
		return false
	}
	now := time.Now()
	lastAttempt := atomic.LoadInt64(&lastClockSyncAttemptAt)
	if lastAttempt > 0 && now.Sub(time.Unix(lastAttempt, 0)) < agentClockSyncCooldown {
		return false
	}
	if !atomic.CompareAndSwapInt32(&clockSyncRunning, 0, 1) {
		return false
	}
	atomic.StoreInt64(&lastClockSyncAttemptAt, now.Unix())
	defer atomic.StoreInt32(&clockSyncRunning, 0)
	return syncSystemTime("agent-panel communication failed: " + err.Error())
}

func syncSystemTime(reason string) bool {
	logf("time sync requested: %s", reason)
	commands := []string{
		`command -v timedatectl >/dev/null 2>&1 && timedatectl set-ntp true`,
		`command -v systemctl >/dev/null 2>&1 && { systemctl enable --now chronyd >/dev/null 2>&1 || systemctl enable --now chrony >/dev/null 2>&1 || systemctl enable --now systemd-timesyncd >/dev/null 2>&1 || systemctl restart chronyd >/dev/null 2>&1 || systemctl restart chrony >/dev/null 2>&1 || systemctl restart systemd-timesyncd >/dev/null 2>&1; }`,
		`command -v rc-service >/dev/null 2>&1 && { rc-update add chronyd default >/dev/null 2>&1 || true; rc-service chronyd restart; }`,
		`command -v chronyc >/dev/null 2>&1 && { chronyc -a "burst 4/4" >/dev/null 2>&1 || true; chronyc -a makestep || chronyc tracking; }`,
		`command -v ntpd >/dev/null 2>&1 && ntpd -q -p pool.ntp.org`,
		`command -v busybox >/dev/null 2>&1 && busybox ntpd -q -p pool.ntp.org`,
	}
	ok := false
	for _, cmd := range commands {
		if runClockSyncCommand(cmd) {
			ok = true
		}
	}
	logf("time sync finished ok=%v current_utc=%s", ok, time.Now().UTC().Format(time.RFC3339))
	return ok
}

func runClockSyncCommand(cmd string) bool {
	c := exec.Command("sh", "-lc", cmd)
	out, err := c.CombinedOutput()
	if len(out) > 0 {
		logf("time sync: %s", strings.TrimSpace(string(out)))
	}
	return err == nil
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

func listenPortOwnerSummary(port int) string {
	if port <= 0 {
		return ""
	}
	portText := strconv.Itoa(port)
	type probe struct {
		name       string
		args       []string
		filterPort bool
	}
	probes := []probe{
		{name: "ss", args: []string{"-ltnup"}, filterPort: true},
		{name: "lsof", args: []string{"-nP", "-iTCP:" + portText, "-sTCP:LISTEN"}},
		{name: "lsof", args: []string{"-nP", "-iUDP:" + portText}},
		{name: "fuser", args: []string{"-v", "-n", "tcp", portText}},
		{name: "fuser", args: []string{"-v", "-n", "udp", portText}},
	}
	for _, p := range probes {
		if _, err := exec.LookPath(p.name); err != nil {
			continue
		}
		out, _ := exec.Command(p.name, p.args...).CombinedOutput()
		text := strings.TrimSpace(string(out))
		if p.filterPort {
			text = filterListenPortLines(text, portText)
		}
		if text == "" {
			continue
		}
		return compactLogOutput(p.name + " " + strings.Join(p.args, " ") + ": " + text)
	}
	return ""
}

func filterListenPortLines(text, portText string) string {
	if strings.TrimSpace(text) == "" {
		return ""
	}
	lines := strings.Split(text, "\n")
	matched := []string{}
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if listenPortLineMatches(line, portText) {
			matched = append(matched, line)
		}
	}
	return strings.Join(matched, "\n")
}

func listenPortLineMatches(line, portText string) bool {
	needle := ":" + portText
	offset := 0
	for {
		idx := strings.Index(line[offset:], needle)
		if idx < 0 {
			return false
		}
		end := offset + idx + len(needle)
		if end >= len(line) || line[end] < '0' || line[end] > '9' {
			return true
		}
		offset = end
	}
}

func compactLogOutput(text string) string {
	lines := strings.Split(strings.ReplaceAll(strings.TrimSpace(text), "\r\n", "\n"), "\n")
	parts := []string{}
	for _, line := range lines {
		line = strings.Join(strings.Fields(line), " ")
		if line != "" {
			parts = append(parts, line)
		}
	}
	compact := strings.Join(parts, " | ")
	if len(compact) > 900 {
		return compact[:900] + "..."
	}
	return compact
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
	path := "/var/log/forwardx-agent/agent-go.log"
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err == nil {
		defer f.Close()
		_, _ = f.WriteString(line)
	}
	pruneAgentLocalLog(path)
	rememberAgentLog(message, createdAt)
}

func pruneAgentLocalLog(path string) {
	agentLogMu.Lock()
	if time.Since(agentLogPrunedAt) < time.Hour {
		agentLogMu.Unlock()
		return
	}
	agentLogPrunedAt = time.Now()
	agentLogMu.Unlock()
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-24 * time.Hour)
	lines := strings.Split(string(raw), "\n")
	retained := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.SplitN(line, " ", 2)
		t, err := time.Parse(time.RFC3339, parts[0])
		if err != nil || t.After(cutoff) {
			retained = append(retained, line)
		}
	}
	if len(retained) == 0 {
		_ = os.WriteFile(path, nil, 0644)
		return
	}
	_ = os.WriteFile(path, []byte(strings.Join(retained, "\n")+"\n"), 0644)
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
	appendAgentLogQueueLocked(agentLogEntry{Level: level, Message: message, CreatedAt: createdAt})
	pruneAgentLogQueueLocked()
}

func isImportantAgentLog(message string) bool {
	lower := strings.ToLower(message)
	keywords := []string{"error", "failed", "warn", "timeout", "upgrade", "selftest", "protocol", "fxp", "migrated", "runtime", "handoff"}
	for _, keyword := range keywords {
		if strings.Contains(lower, keyword) {
			return true
		}
	}
	return false
}

func agentLogQueuePath() string {
	return "/var/lib/forwardx-agent/agent-log-queue.jsonl"
}

func appendAgentLogQueueLocked(entry agentLogEntry) {
	_ = os.MkdirAll("/var/lib/forwardx-agent", 0755)
	b, err := json.Marshal(entry)
	if err != nil {
		return
	}
	f, err := os.OpenFile(agentLogQueuePath(), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(b, '\n'))
}

func readAgentLogQueueLocked(limit int) []agentLogEntry {
	raw, err := os.ReadFile(agentLogQueuePath())
	if err != nil {
		return nil
	}
	lines := strings.Split(string(raw), "\n")
	logs := []agentLogEntry{}
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var entry agentLogEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		if !isRecentAgentLog(entry.CreatedAt) {
			continue
		}
		logs = append(logs, entry)
		if limit > 0 && len(logs) >= limit {
			break
		}
	}
	return logs
}

func rewriteAgentLogQueueLocked(logs []agentLogEntry) {
	_ = os.MkdirAll("/var/lib/forwardx-agent", 0755)
	var builder strings.Builder
	for _, entry := range logs {
		if !isRecentAgentLog(entry.CreatedAt) {
			continue
		}
		b, err := json.Marshal(entry)
		if err != nil {
			continue
		}
		builder.Write(b)
		builder.WriteByte('\n')
	}
	_ = os.WriteFile(agentLogQueuePath(), []byte(builder.String()), 0644)
}

func pruneAgentLogQueueLocked() {
	rewriteAgentLogQueueLocked(readAgentLogQueueLocked(0))
}

func removeUploadedAgentLogsLocked(count int) {
	if count <= 0 {
		return
	}
	logs := readAgentLogQueueLocked(0)
	if count >= len(logs) {
		rewriteAgentLogQueueLocked(nil)
		return
	}
	rewriteAgentLogQueueLocked(logs[count:])
}

func isRecentAgentLog(createdAt string) bool {
	t, err := time.Parse(time.RFC3339, createdAt)
	if err != nil {
		return false
	}
	return time.Since(t) <= 24*time.Hour
}

func flushAgentLogs(cfg Config) {
	if !agentLogUploadEnabled.Load() {
		return
	}
	agentLogMu.Lock()
	logs := readAgentLogQueueLocked(100)
	if len(logs) == 0 {
		agentLogMu.Unlock()
		return
	}
	agentLogMu.Unlock()
	var resp agentLogUploadResp
	if err := post(cfg, "/api/agent/logs", map[string]any{"logs": logs}, &resp); err != nil {
		return
	}
	if resp.Disabled {
		agentLogUploadEnabled.Store(false)
		return
	}
	if resp.Accepted <= 0 {
		return
	}
	accepted := resp.Accepted
	if accepted > len(logs) {
		accepted = len(logs)
	}
	agentLogMu.Lock()
	removeUploadedAgentLogsLocked(accepted)
	pruneAgentLogQueueLocked()
	agentLogMu.Unlock()
}

func fatal(format string, args ...any) {
	logf(format, args...)
	os.Exit(1)
}
