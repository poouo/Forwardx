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
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var Version = "2.2.122"

const selfUpgradeLockTimeout = 10 * time.Minute
const iperf3IdleTimeout = 3 * time.Minute
const selfTestIdlePollInterval = 10 * time.Second
const selfTestActivePollInterval = 2 * time.Second
const selfTestActiveWindow = 2 * time.Minute
const agentClockSyncCooldown = 10 * time.Minute
const publicIPRefreshInterval = time.Minute
const trafficCollectInterval = 3 * time.Second
const countingChainRefreshInterval = 6 * time.Hour
const runtimeActionRefreshInterval = 5 * time.Minute
const agentLogRetention = 72 * time.Hour
const agentSlowRequestThreshold = 1500 * time.Millisecond
const agentReportLogInterval = 30 * time.Second
const actionBacklogHeartbeatDelay = 30 * time.Second
const actionShellTimeout = 90 * time.Second
const protocolGuardSampleMinBytes = 96
const protocolGuardSampleMaxBytes = 512
const protocolGuardSampleTimeout = 750 * time.Millisecond
const protocolGuardConfirmations = 3
const protocolGuardWindowStep = 64
const protocolGuardTLSMinRecordSize = 64
const protocolGuardSOCKS5MaxMethods = 16
const agentVerboseEnv = "FORWARDX_AGENT_VERBOSE_LOG"

const agentLogDir = "/var/log/forwardx-agent"
const agentLogPath = agentLogDir + "/agent-go.log"
const defaultConfigPath = "/etc/forwardx/agent/config.json"
const legacyConfigPath = "/etc/forwardx-agent/config.json"
const runtimeServiceName = "forwardx-runtime"
const tunnelRuntimeServiceName = "forwardx-tunnel-runtime"
const nginxServiceName = "forwardx-nginx"
const runtimeConfigPath = "/etc/forwardx/runtime/gost.json"
const tunnelRuntimeConfigPath = "/etc/forwardx/runtime/tunnel-gost.json"
const nginxConfigPath = "/etc/forwardx/nginx/nginx.conf"
const legacyGostServiceName = "forwardx-gost"
const legacyTunnelServiceName = "forwardx-tunnels"
const legacyGostConfigPath = "/etc/forwardx-gost/config.json"
const legacyTunnelConfigPath = "/etc/forwardx-tunnels/config.json"
const legacyRuntimeConfigPath = "/etc/forwardx-runtime/config.json"
const legacyTunnelRuntimeConfigPath = "/etc/forwardx-tunnel-runtime/config.json"

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
var agentLogMu sync.Mutex
var agentLogPrunedAt time.Time
var activeConfigPath string
var runtimePanelURL atomic.Value
var actionQueue = make(chan actionJob, 128)
var actionEpochMu sync.Mutex
var latestActionIssuedAt = map[string]int64{}
var iperf3Mu sync.Mutex
var iperf3Server *iperf3Process
var dnsWatchMu sync.Mutex
var dnsWatchSnapshot = map[string][]string{}
var pendingDNSChanges []dnsChangeReport
var publicIPMu sync.Mutex
var publicIPv4Cache string
var publicIPv6Cache string
var publicIPCheckedAt time.Time
var lastTrafficCollectAt time.Time
var countingChainMu sync.Mutex
var countingChainSignatures = map[string]string{}
var countingChainCheckedAt = map[string]time.Time{}
var runtimeActionMu sync.Mutex
var runtimeActionCache = map[string]runtimeActionState{}
var runtimeProxyLogMu sync.Mutex
var runtimeProxyLogSignatures = map[string]string{}
var dnsWatchHostPattern = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9\-_.]*[A-Za-z0-9])?$`)
var agentReportLogMu sync.Mutex
var agentReportLogAt = map[string]time.Time{}
var actionPendingCount int64
var heartbeatWakeCh = make(chan struct{}, 1)
var agentVerboseLogs = isEnvTruthy(os.Getenv(agentVerboseEnv))
var queuedActionMu sync.Mutex
var queuedActionKeys = map[string]int64{}

type actionJob struct {
	cfg    Config
	action action
	done   chan struct{}
}

type runtimeActionState struct {
	Signature string
	CheckedAt time.Time
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
	Actions            []action                `json:"actions"`
	SelfTests          []selfTest              `json:"selfTests"`
	RunningRules       []runningRule           `json:"runningRules"`
	TunnelProbes       []tunnelProbe           `json:"tunnelProbes"`
	ForwardGroupProbes []forwardGroupProbe     `json:"forwardGroupProbes"`
	HostProbeServices  []hostProbeServiceProbe `json:"hostProbeServices"`
	GuardRules         []guardRule             `json:"guardRules"`
	DNSWatch           []dnsWatchItem          `json:"dnsWatch"`
	LookingGlassTests  []lookingGlassTask      `json:"lookingGlassTests"`
	Iperf3Tasks        []iperf3Task            `json:"iperf3Tasks"`
	AgentUpgrade       *agentUpgrade           `json:"agentUpgrade"`
	PanelURL           string                  `json:"panelUrl"`
	ForceTCPing        bool                    `json:"forceTcping"`
	NextInterval       int                     `json:"nextInterval"`
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
	ReportStatus     *bool         `json:"reportStatus,omitempty"`
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
	TunnelID    int    `json:"tunnelId"`
	TargetIP    string `json:"targetIp"`
	TargetPort  int    `json:"targetPort"`
	Protocol    string `json:"protocol"`
	HopIndex    int    `json:"hopIndex"`
	HopCount    int    `json:"hopCount"`
	SeriesKey   string `json:"seriesKey"`
	SeriesLabel string `json:"seriesLabel"`
}

type hostProbeServiceProbe struct {
	ServiceID       int    `json:"serviceId"`
	TargetIP        string `json:"targetIp"`
	TargetPort      int    `json:"targetPort"`
	Method          string `json:"method"`
	IntervalSeconds int    `json:"intervalSeconds"`
}
type forwardGroupProbe struct {
	GroupID    int    `json:"groupId"`
	MemberID   int    `json:"memberId"`
	ProbeType  string `json:"probeType"`
	TargetIP   string `json:"targetIp"`
	TargetPort int    `json:"targetPort"`
	Method     string `json:"method"`
	HopIndex   int    `json:"hopIndex"`
	HopCount   int    `json:"hopCount"`
}

type dnsWatchItem struct {
	Host  string `json:"host"`
	Scope string `json:"scope"`
	RefID int    `json:"refId"`
}

type dnsChangeReport struct {
	Host string   `json:"host"`
	Old  []string `json:"old,omitempty"`
	New  []string `json:"new,omitempty"`
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
	Role                     string            `json:"role"`
	TunnelID                 int               `json:"tunnelId"`
	RuleID                   int               `json:"ruleId"`
	ListenPort               int               `json:"listenPort"`
	Protocol                 string            `json:"protocol"`
	ExitHost                 string            `json:"exitHost"`
	ExitPort                 int               `json:"exitPort"`
	Exits                    []fxpExitEndpoint `json:"exits,omitempty"`
	TargetIP                 string            `json:"targetIp"`
	TargetPort               int               `json:"targetPort"`
	Key                      string            `json:"key"`
	LimitIn                  int64             `json:"limitIn"`
	LimitOut                 int64             `json:"limitOut"`
	MaxConnections           int               `json:"maxConnections"`
	MaxIPs                   int               `json:"maxIPs"`
	AccessScope              string            `json:"accessScope"`
	BlockHTTP                bool              `json:"blockHttp"`
	BlockSocks               bool              `json:"blockSocks"`
	BlockTLS                 bool              `json:"blockTls"`
	ProxyProtocolReceive     bool              `json:"proxyProtocolReceive"`
	ProxyProtocolSend        bool              `json:"proxyProtocolSend"`
	ProxyProtocolExitReceive bool              `json:"proxyProtocolExitReceive"`
	ProxyProtocolExitSend    bool              `json:"proxyProtocolExitSend"`
	ProxyProtocolVersion     int               `json:"proxyProtocolVersion"`
	TCPFastOpen              bool              `json:"tcpFastOpen"`
	PanelURL                 string            `json:"panelUrl,omitempty"`
	Token                    string            `json:"token,omitempty"`
	RelayExitHost            string            `json:"relayExitHost,omitempty"`
	RelayExitPort            int               `json:"relayExitPort,omitempty"`
	RelayKey                 string            `json:"relayKey,omitempty"`
}

type fxpExitEndpoint struct {
	Host string `json:"host"`
	Port int    `json:"port"`
	Key  string `json:"key,omitempty"`
}

type protocolPolicy struct {
	BlockHTTP  bool `json:"blockHttp"`
	BlockSocks bool `json:"blockSocks"`
	BlockTLS   bool `json:"blockTls"`
}

func (p protocolPolicy) enabled() bool {
	return p.BlockHTTP || p.BlockSocks || p.BlockTLS
}

func readProtocolGuardSample(conn net.Conn, initial []byte, minBytes int) []byte {
	sample := append([]byte(nil), initial...)
	if len(sample) >= minBytes {
		return sample
	}
	_ = conn.SetReadDeadline(time.Now().Add(protocolGuardSampleTimeout))
	defer conn.SetReadDeadline(time.Time{})
	for len(sample) < protocolGuardSampleMaxBytes {
		limit := protocolGuardSampleMaxBytes - len(sample)
		if limit > protocolGuardWindowStep {
			limit = protocolGuardWindowStep
		}
		if limit <= 0 {
			break
		}
		tmp := make([]byte, limit)
		n, err := conn.Read(tmp)
		if n > 0 {
			sample = append(sample, tmp[:n]...)
		}
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				break
			}
			break
		}
		if n == 0 {
			break
		}
		if len(sample) >= minBytes {
			break
		}
	}
	return sample
}

func detectBlockedProtocolWithConfirmations(conn net.Conn, first []byte, policy protocolPolicy) ([]byte, string, bool) {
	if len(first) == 0 || !policy.enabled() {
		return first, "", false
	}
	sample := append([]byte(nil), first...)
	candidate := ""
	confirmed := 0
	nextTarget := protocolGuardSampleMinBytes
	for i := 0; i < protocolGuardConfirmations && len(sample) < protocolGuardSampleMaxBytes; i++ {
		sample = readProtocolGuardSample(conn, sample, nextTarget)
		if nextTarget < protocolGuardSampleMaxBytes {
			nextTarget = len(sample) + protocolGuardWindowStep
			if nextTarget > protocolGuardSampleMaxBytes {
				nextTarget = protocolGuardSampleMaxBytes
			}
		}
		proto := detectBlockedProtocol(sample, policy)
		if proto == "" {
			candidate = ""
			confirmed = 0
			continue
		}
		if candidate != proto {
			candidate = proto
			confirmed = 1
			continue
		}
		confirmed++
		if confirmed >= 2 {
			return sample, candidate, true
		}
	}
	return sample, "", false
}

type guardRule struct {
	RuleID               int            `json:"ruleId"`
	TunnelID             int            `json:"tunnelId"`
	ListenPort           int            `json:"listenPort"`
	TargetIP             string         `json:"targetIp"`
	TargetPort           int            `json:"targetPort"`
	Policy               protocolPolicy `json:"policy"`
	ProxyProtocolReceive bool           `json:"proxyProtocolReceive"`
	ProxyProtocolSend    bool           `json:"proxyProtocolSend"`
	ProxyProtocolVersion int            `json:"proxyProtocolVersion"`
}

func main() {
	configPath := flag.String("config", defaultConfigPath, "config file")
	onceRegister := flag.Bool("register", false, "register and exit")
	flag.Parse()

	resolvedConfigPath, cfg, err := loadConfigWithFallback(*configPath)
	if err != nil {
		fatal("load config: %v", err)
	}
	if cfg.Interval <= 0 {
		cfg.Interval = 30
	}
	cfg.PanelURL = strings.TrimRight(cfg.PanelURL, "/")
	activeConfigPath = resolvedConfigPath
	setRuntimePanelURL(cfg.PanelURL)

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
		if pending := atomic.LoadInt64(&actionPendingCount); pending > 0 {
			delay := actionBacklogHeartbeatDelay
			if pending <= 3 {
				delay = 5 * time.Second
			}
			if shouldLogAgentReport("heartbeat-backlog", agentReportLogInterval) {
				logf("heartbeat delayed pendingActions=%d delay=%s", pending, delay)
			}
			select {
			case <-heartbeatWakeCh:
			case <-time.After(delay):
			}
			if atomic.LoadInt64(&actionPendingCount) > 0 {
				continue
			}
		}
		nextInterval, err := heartbeat(cfg)
		if err != nil && shouldLogAgentReport("heartbeat-error", agentReportLogInterval) {
			logf("heartbeat error: %v", err)
		}
		if nextInterval <= 0 {
			nextInterval = cfg.Interval
		}
		if nextInterval < 2 {
			nextInterval = 2
		}
		select {
		case <-heartbeatWakeCh:
		case <-time.After(time.Duration(nextInterval) * time.Second):
		}
	}
}

func loadConfigWithFallback(path string) (string, Config, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		path = defaultConfigPath
	}
	cfg, err := loadConfig(path)
	if err == nil {
		if path == defaultConfigPath {
			migrateLegacyConfigToDefault(path)
		}
		return path, cfg, nil
	}
	if path == defaultConfigPath {
		if legacyCfg, legacyErr := loadConfig(legacyConfigPath); legacyErr == nil {
			if writeConfigFile(defaultConfigPath, legacyCfg) == nil {
				logf("config migrated from %s to %s", legacyConfigPath, defaultConfigPath)
				return defaultConfigPath, legacyCfg, nil
			}
			return legacyConfigPath, legacyCfg, nil
		}
	}
	return path, Config{}, err
}

func migrateLegacyConfigToDefault(path string) {
	if path != defaultConfigPath {
		return
	}
	if _, err := os.Stat(legacyConfigPath); err != nil {
		return
	}
	cfg, err := loadConfig(legacyConfigPath)
	if err != nil {
		return
	}
	_ = writeConfigFile(defaultConfigPath, cfg)
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

func writeConfigFile(path string, cfg Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	if err := os.WriteFile(path, raw, 0600); err != nil {
		return err
	}
	return os.Chmod(path, 0600)
}

func normalizePanelURL(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ""
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return ""
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return strings.TrimRight(parsed.String(), "/")
}

func setRuntimePanelURL(panelURL string) {
	normalized := normalizePanelURL(panelURL)
	if normalized == "" {
		return
	}
	runtimePanelURL.Store(normalized)
}

func currentPanelURL(cfg Config) string {
	if value, ok := runtimePanelURL.Load().(string); ok && value != "" {
		return value
	}
	return strings.TrimRight(cfg.PanelURL, "/")
}

func persistPanelURL(panelURL string) error {
	normalized := normalizePanelURL(panelURL)
	if normalized == "" {
		return fmt.Errorf("invalid panelUrl")
	}
	path := strings.TrimSpace(activeConfigPath)
	if path == "" {
		return fmt.Errorf("config path is empty")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		return err
	}
	if data == nil {
		data = map[string]any{}
	}
	if strings.TrimRight(fmt.Sprint(data["panelUrl"]), "/") == normalized {
		return nil
	}
	data["panelUrl"] = normalized
	next, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	next = append(next, '\n')
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, next, 0600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	_ = os.Chmod(path, 0600)
	return nil
}

func syncPanelURLFromResponse(panelURL string) {
	normalized := normalizePanelURL(panelURL)
	if normalized == "" {
		return
	}
	current := currentPanelURL(Config{})
	if current == normalized {
		return
	}
	setRuntimePanelURL(normalized)
	if err := persistPanelURL(normalized); err != nil {
		logf("panel URL switched to %s for runtime, persist failed: %v", normalized, err)
		return
	}
	logf("panel URL updated to %s", normalized)
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
	ipv4, ipv6 := publicIPs()
	primaryIP := ipv4
	if primaryIP == "" {
		primaryIP = ipv6
	}
	dnsChanges := takePendingDNSChanges()
	memInfo := readMeminfo()
	memoryTotal := memTotalFrom(memInfo)
	memoryUsed := memUsedFrom(memInfo)
	swapTotal := swapTotalFrom(memInfo)
	swapUsed := swapUsedFrom(memInfo)
	payload := map[string]any{
		"cpuUsage":     cpuUsage(),
		"memoryUsage":  usagePercent(memoryUsed, memoryTotal),
		"memoryUsed":   memoryUsed,
		"memoryTotal":  memoryTotal,
		"swapUsage":    usagePercent(swapUsed, swapTotal),
		"swapUsed":     swapUsed,
		"swapTotal":    swapTotal,
		"networkIn":    netBytes(0),
		"networkOut":   netBytes(1),
		"diskUsage":    diskUsage(),
		"diskUsed":     diskBytes("used"),
		"diskTotal":    diskBytes("total"),
		"uptime":       uptime(),
		"cpuInfo":      cpuInfo(),
		"agentVersion": Version,
	}
	if primaryIP != "" {
		payload["ip"] = primaryIP
	}
	if ipv4 != "" {
		payload["ipv4"] = ipv4
	}
	if ipv6 != "" {
		payload["ipv6"] = ipv6
	}
	if len(dnsChanges) > 0 {
		payload["dnsChanged"] = dnsChanges
	}
	var resp heartbeatResp
	if err := post(cfg, "/api/agent/heartbeat", payload, &resp); err != nil {
		queuePendingDNSChanges(dnsChanges)
		var migrated migratedPanelError
		if errors.As(err, &migrated) {
			go selfUpgrade(cfg, &agentUpgrade{TargetVersion: "9999.0.0", PanelURL: migrated.PanelURL})
			return cfg.Interval, nil
		}
		return cfg.Interval, err
	}
	syncPanelURLFromResponse(resp.PanelURL)
	if resp.AgentUpgrade != nil {
		go selfUpgrade(cfg, resp.AgentUpgrade)
	}
	dnsWatchChanged := updateDNSWatch(resp.DNSWatch)
	pendingActionPorts := map[string]bool{}
	actionDone := make([]<-chan struct{}, 0, len(resp.Actions))
	for _, a := range resp.Actions {
		if a.SourcePort > 0 && shouldReportActionStatus(a) {
			pendingActionPorts[strconv.Itoa(a.SourcePort)] = true
		}
		actionDone = append(actionDone, enqueueAction(cfg, a))
	}
	if len(resp.SelfTests) > 0 && len(actionDone) > 0 {
		waitForActionBatch(actionDone, 20*time.Second)
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
		ensureCountingChainsIfNeeded(r)
	}
	syncProtocolGuards(cfg, resp.GuardRules)
	if lastTrafficCollectAt.IsZero() || time.Since(lastTrafficCollectAt) >= trafficCollectInterval {
		collectTraffic(cfg)
		lastTrafficCollectAt = time.Now()
	}
	tcpingInterval := tcpingDueInterval(resp.HostProbeServices)
	if resp.ForceTCPing || lastTCPingAt.IsZero() || time.Since(lastTCPingAt) >= tcpingInterval {
		collectTCPing(cfg, resp.TunnelProbes, resp.ForwardGroupProbes, resp.HostProbeServices, resp.ForceTCPing)
		lastTCPingAt = time.Now()
	}
	if dnsWatchChanged && resp.NextInterval > 2 {
		return 2, nil
	}
	return resp.NextInterval, nil
}

func tcpingDueInterval(serviceProbes []hostProbeServiceProbe) time.Duration {
	if len(serviceProbes) == 0 {
		return time.Minute
	}
	interval := time.Duration(0)
	for _, probe := range serviceProbes {
		seconds := probe.IntervalSeconds
		if seconds <= 0 {
			seconds = 30
		}
		if seconds < 5 {
			seconds = 5
		}
		duration := time.Duration(seconds) * time.Second
		if interval == 0 || duration < interval {
			interval = duration
		}
	}
	if interval <= 0 {
		return time.Minute
	}
	return interval
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
		message := missingNetworkToolMessage("iperf3")
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
	if errors.Is(err, exec.ErrNotFound) {
		message := missingNetworkToolMessage("iperf3")
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
	if _, err := exec.LookPath(command); err != nil {
		code := 1
		message := missingNetworkToolMessage(command)
		result.ExitCode = &code
		result.Error = message
		result.Output = message
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

func missingNetworkToolMessage(tool string) string {
	switch tool {
	case "ping":
		return "Agent 主机缺少 ping 工具，无法执行 Ping 测试。\n请在该 Agent 主机安装后重试：Debian/Ubuntu: apt install iputils-ping；RHEL/CentOS: yum install iputils；Alpine: apk add iputils。"
	case "traceroute":
		return "Agent 主机缺少 traceroute 工具，无法执行 Traceroute 测试。\n请在该 Agent 主机安装后重试：Debian/Ubuntu: apt install traceroute；RHEL/CentOS: yum install traceroute；Alpine: apk add traceroute。"
	case "mtr":
		return "Agent 主机缺少 mtr 工具，无法执行 MTR 测试。\n请在该 Agent 主机安装后重试：Debian/Ubuntu: apt install mtr-tiny；RHEL/CentOS: yum install mtr；Alpine: apk add mtr。"
	case "iperf3":
		return "Agent 主机缺少 iperf3，无法启动 iperf3 服务端测试。\n请在该 Agent 主机安装后重试：Debian/Ubuntu: apt install iperf3；RHEL/CentOS: yum install iperf3；Alpine: apk add iperf3。"
	default:
		return fmt.Sprintf("Agent 主机缺少 %s 工具，无法执行该网络测试。请在该 Agent 主机安装 %s 后重试。", tool, tool)
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
		if errors.Is(err, exec.ErrNotFound) {
			return missingNetworkToolMessage(name), &code, false
		}
		return fmt.Sprintf("网络测试工具 %s 启动失败：%v", name, err), &code, false
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
	readDone := make(chan struct{})
	go func() {
		wg.Wait()
		close(readDone)
	}()

	running := true
	for running {
		select {
		case <-ticker.C:
			report(fmt.Sprintf("命令正在执行，已运行 %ds...", int(time.Since(started).Seconds())))
		case <-readDone:
			running = false
		}
	}
	ticker.Stop()
	waitErr := cmd.Wait()

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
	panelURL := currentPanelURL(cfg)
	req, err := http.NewRequest("GET", panelURL+"/api/stream?e="+url.QueryEscape(string(query)), nil)
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
					select {
					case heartbeatWakeCh <- struct{}{}:
					default:
					}
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
	if strings.TrimSpace(a.StatusType) == "runtime" {
		if shouldSkipRuntimeAction(a) {
			return
		}
		logVerbosef("action start op=%s statusType=%s rule=%d tunnel=%d forwardType=%s port=%d protocol=%s", a.Op, a.StatusType, a.RuleID, a.TunnelID, a.ForwardType, a.SourcePort, a.Protocol)
		for _, cmd := range append(append([]string{}, a.PreCommands...), append(a.Commands, a.PostCommands...)...) {
			ok = runShell(cmd) && ok
		}
		logGostRuntimeProxySummary(runtimeConfigPath, runtimeServiceName)
		logGostRuntimeProxySummary(tunnelRuntimeConfigPath, tunnelRuntimeServiceName)
		if !ok || agentVerboseLogs {
			logf("runtime action complete forwardType=%s ok=%v", a.ForwardType, ok)
		}
		return
	}
	logVerbosef("action start op=%s statusType=%s rule=%d tunnel=%d forwardType=%s port=%d protocol=%s", a.Op, a.StatusType, a.RuleID, a.TunnelID, a.ForwardType, a.SourcePort, a.Protocol)
	logIPv6ActionDiagnostic(a)
	logActionPortHandoff(a)
	if a.Op == "apply" {
		preserveRunningFXP := cleanupStaleRuntimeBeforeApply(a)
		if preserveRunningFXP {
			logf("action preserves already-running fxp rule=%d tunnel=%d port=%d; skipping disruptive apply commands", a.RuleID, a.TunnelID, a.SourcePort)
		} else {
			cleanupKernelForwardPortBeforeApply(a)
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
			if !fxpOK || agentVerboseLogs {
				logf("action fxp role=%s tunnel=%d rule=%d listen=%d protocol=%s proxyReceive=%v proxySend=%v ok=%v", a.Fxp.Role, a.Fxp.TunnelID, a.Fxp.RuleID, a.Fxp.ListenPort, a.Fxp.Protocol, a.Fxp.ProxyProtocolReceive, a.Fxp.ProxyProtocolSend, fxpOK)
			}
			ok = fxpOK && ok
		}
		if a.Failover != nil && a.Failover.Enabled {
			failoverOK := startFailoverProxy(a.RuleID, a.SourcePort, *a.Failover, actionMessage)
			if !failoverOK || agentVerboseLogs {
				logf("action failover rule=%d listen=%d targets=%d ok=%v", a.RuleID, a.Failover.ListenPort, len(a.Failover.Targets), failoverOK)
			}
			ok = failoverOK && ok
		}
		runPostCommands(a.PostCommands, actionMessage)
		if shouldReportActionStatus(a) {
			writeState(a)
		}
	} else {
		if shouldSkipRemoveForReassignedPort(a) {
			ok = true
		} else {
			stopFailoverProxy(a.RuleID, a.SourcePort)
			if a.Fxp != nil {
				stopFXP(*a.Fxp)
			}
			for _, name := range managedServiceNamesForAction(a) {
				cleanupManagedService(name)
			}
			for _, cmd := range a.Commands {
				ok = runShell(cmd) && ok
			}
			if shouldReportActionStatus(a) {
				removeState(a.SourcePort)
			}
		}
	}
	if !shouldReportActionStatus(a) {
		return
	}
	running := ok && a.Op == "apply"
	message := actionMessage.get()
	payload := map[string]any{"ruleId": a.RuleID, "tunnelId": a.TunnelID, "statusType": a.StatusType, "isRunning": running, "message": message}
	var out map[string]any
	if err := post(cfg, "/api/agent/rule-status", payload, &out); err != nil {
		logf("rule-status report failed statusType=%s rule=%d tunnel=%d running=%v: %v", a.StatusType, a.RuleID, a.TunnelID, running, err)
	} else if !running || agentVerboseLogs {
		logf("rule-status report ok statusType=%s rule=%d tunnel=%d running=%v", a.StatusType, a.RuleID, a.TunnelID, running)
	}
}

func shouldSkipRemoveForReassignedPort(a action) bool {
	if a.Op != "remove" || a.RuleID <= 0 || a.SourcePort <= 0 || strings.TrimSpace(a.StatusType) == "tunnel" {
		return false
	}
	port := strconv.Itoa(a.SourcePort)
	localRuleID := readRuleIDByPort(port)
	if localRuleID <= 0 || localRuleID == a.RuleID {
		return false
	}
	logf("skip stale remove for reassigned port=%d removeRule=%d currentRule=%d forwardType=%s", a.SourcePort, a.RuleID, localRuleID, a.ForwardType)
	return true
}

func cleanupKernelForwardPortBeforeApply(a action) {
	if a.Op != "apply" || a.SourcePort <= 0 {
		return
	}
	port := strconv.Itoa(a.SourcePort)
	localRuleID := readRuleIDByPort(port)
	localForwardType := readForwardTypeByPort(port)
	reassignedRule := a.RuleID > 0 && localRuleID > 0 && localRuleID != a.RuleID
	changedFromKernelForward := reassignedRule && (localForwardType == "iptables" || localForwardType == "nftables")
	if changedFromKernelForward && a.ForwardType != "iptables" {
		for _, binary := range iptablesAgentBinaries() {
			_ = runShell(iptablesAgentDeleteDnatRulesForPort(binary, port, "both"))
		}
	}
	if changedFromKernelForward && a.ForwardType != "nftables" {
		_ = runShell(nftPortCleanupCmd(port, "both"))
	}
	switch a.ForwardType {
	case "iptables":
		for _, binary := range iptablesAgentBinaries() {
			_ = runShell(iptablesAgentDeleteDnatRulesForPort(binary, port, "both"))
		}
	case "nftables":
		_ = runShell(nftPortCleanupCmd(port, "both"))
	}
}

func logIPv6ActionDiagnostic(a action) {
	if a.SourcePort <= 0 || a.Op != "apply" {
		return
	}
	target := strings.Trim(strings.TrimSpace(a.TargetIP), "[]")
	targetIPv6 := strings.Contains(target, ":")
	commandText := strings.Join(append(append([]string{}, a.PreCommands...), append(a.Commands, a.PostCommands...)...), "\n")
	usesIP6Tables := strings.Contains(commandText, "ip6tables")
	usesNFT := strings.Contains(commandText, "nft ") || strings.Contains(commandText, "nftables")
	serviceMode := a.Unit != "" || a.UnitExtra != "" || a.Fxp != nil || (a.Failover != nil && a.Failover.Enabled)
	if !targetIPv6 && !usesIP6Tables && !usesNFT && !serviceMode {
		return
	}
	if !shouldLogAgentReport(fmt.Sprintf("ipv6-forward-diag:%d:%d:%s", a.RuleID, a.SourcePort, a.ForwardType), 5*time.Minute) {
		return
	}
	logf(
		"ipv6-forward diag op=%s rule=%d tunnel=%d type=%s port=%d protocol=%s target=%s:%d targetIPv6=%v ip6tablesCmd=%v nftCmd=%v service=%v fxp=%v failover=%v ip6tablesInstalled=%v",
		a.Op,
		a.RuleID,
		a.TunnelID,
		a.ForwardType,
		a.SourcePort,
		a.Protocol,
		target,
		a.TargetPort,
		targetIPv6,
		usesIP6Tables,
		usesNFT,
		serviceMode,
		a.Fxp != nil,
		a.Failover != nil && a.Failover.Enabled,
		commandExists("ip6tables"),
	)
}

func shouldSkipRuntimeAction(a action) bool {
	key := strings.TrimSpace(a.ForwardType)
	if key == "" {
		key = "runtime"
	}
	signature := actionCommandSignature(a)
	now := time.Now()
	runtimeActionMu.Lock()
	defer runtimeActionMu.Unlock()
	state := runtimeActionCache[key]
	if state.Signature == signature && !state.CheckedAt.IsZero() && now.Sub(state.CheckedAt) < runtimeActionRefreshInterval {
		return true
	}
	runtimeActionCache[key] = runtimeActionState{Signature: signature, CheckedAt: now}
	return false
}

func logGostRuntimeProxySummary(path string, label string) {
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var cfg struct {
		Services []struct {
			Name     string         `json:"name"`
			Addr     string         `json:"addr"`
			Metadata map[string]any `json:"metadata"`
			Handler  struct {
				Type     string         `json:"type"`
				Chain    string         `json:"chain"`
				Metadata map[string]any `json:"metadata"`
			} `json:"handler"`
			Listener struct {
				Type string `json:"type"`
			} `json:"listener"`
			Forwarder struct {
				Nodes []struct {
					Name string `json:"name"`
					Addr string `json:"addr"`
				} `json:"nodes"`
			} `json:"forwarder"`
		} `json:"services"`
		Chains []struct {
			Name string `json:"name"`
			Hops []struct {
				Name     string         `json:"name"`
				Metadata map[string]any `json:"metadata"`
				Nodes    []struct {
					Name     string         `json:"name"`
					Addr     string         `json:"addr"`
					Metadata map[string]any `json:"metadata"`
				} `json:"nodes"`
			} `json:"hops"`
		} `json:"chains"`
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		logf("proxy-debug %s config parse failed path=%s: %v", label, path, err)
		return
	}
	lines := make([]string, 0)
	for _, svc := range cfg.Services {
		receive := hasProxyProtocolMetadata(svc.Metadata)
		send := hasProxyProtocolMetadata(svc.Handler.Metadata)
		targets := make([]string, 0, len(svc.Forwarder.Nodes))
		for _, node := range svc.Forwarder.Nodes {
			targets = append(targets, fmt.Sprintf("%s@%s", emptyDash(node.Name), emptyDash(node.Addr)))
		}
		if len(targets) == 0 {
			targets = append(targets, "-")
		}
		if receive || send || strings.TrimSpace(svc.Handler.Chain) != "" {
			lines = append(lines, fmt.Sprintf(
				"service=%s addr=%s listener=%s handler=%s chain=%s acceptProxy=%v sendProxy=%v targets=%s",
				emptyDash(svc.Name),
				emptyDash(svc.Addr),
				emptyDash(svc.Listener.Type),
				emptyDash(svc.Handler.Type),
				emptyDash(svc.Handler.Chain),
				receive,
				send,
				strings.Join(targets, ","),
			))
		}
	}
	for _, chain := range cfg.Chains {
		for _, hop := range chain.Hops {
			hopSend := hasProxyProtocolMetadata(hop.Metadata)
			nodeSend := false
			targets := make([]string, 0, len(hop.Nodes))
			for _, node := range hop.Nodes {
				if hasProxyProtocolMetadata(node.Metadata) {
					nodeSend = true
				}
				targets = append(targets, fmt.Sprintf("%s@%s", emptyDash(node.Name), emptyDash(node.Addr)))
			}
			if !hopSend && !nodeSend {
				continue
			}
			lines = append(lines, fmt.Sprintf(
				"chain=%s hop=%s sendProxy=%v hopProxy=%v nodeProxy=%v nodes=%s",
				emptyDash(chain.Name),
				emptyDash(hop.Name),
				hopSend || nodeSend,
				hopSend,
				nodeSend,
				strings.Join(targets, ","),
			))
		}
	}
	sort.Strings(lines)
	signature := strings.Join(lines, "\n")
	runtimeProxyLogMu.Lock()
	if runtimeProxyLogSignatures[label] == signature {
		runtimeProxyLogMu.Unlock()
		return
	}
	runtimeProxyLogSignatures[label] = signature
	runtimeProxyLogMu.Unlock()
	if len(lines) == 0 {
		logVerbosef("proxy-debug %s no proxyProtocol entries services=%d chains=%d path=%s", label, len(cfg.Services), len(cfg.Chains), path)
		return
	}
	logVerbosef("proxy-debug %s proxyProtocol summary entries=%d path=%s", label, len(lines), path)
	for _, line := range lines {
		logVerbosef("proxy-debug %s %s", label, line)
	}
}

func hasProxyProtocolMetadata(metadata map[string]any) bool {
	if len(metadata) == 0 {
		return false
	}
	value, ok := metadata["proxyProtocol"]
	if !ok {
		return false
	}
	switch v := value.(type) {
	case bool:
		return v
	case float64:
		return v != 0
	case string:
		text := strings.ToLower(strings.TrimSpace(v))
		return text != "" && text != "0" && text != "false"
	default:
		return value != nil
	}
}

func emptyDash(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "-"
	}
	return value
}

func actionCommandSignature(a action) string {
	h := fnv.New64a()
	write := func(value string) {
		_, _ = h.Write([]byte(value))
		_, _ = h.Write([]byte{0})
	}
	write(a.Op)
	write(a.ForwardType)
	for _, cmd := range a.PreCommands {
		write(cmd)
	}
	for _, cmd := range a.Commands {
		write(cmd)
	}
	for _, cmd := range a.PostCommands {
		write(cmd)
	}
	return strconv.FormatUint(h.Sum64(), 16)
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
			cleanupGostRuntimeIfPortBusy(a.SourcePort)
			waitForActionListenPortFree(a, 2*time.Second)
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
		cleanupGostRuntimeIfPortBusy(a.SourcePort)
		waitForActionListenPortFree(a, 2*time.Second)
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
	case "realm", "socat", "gost", "nginx", "forwardx", "forwardx-tunnel", "gost-tunnel", "nginx-tunnel":
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

func cleanupGostRuntimeIfPortBusy(port int) {
	if port <= 0 {
		return
	}
	ln, err := net.Listen("tcp", net.JoinHostPort("", strconv.Itoa(port)))
	if err == nil {
		_ = ln.Close()
		return
	}
	stopped := false
	for _, item := range managedRuntimeConfigs() {
		if managedRuntimeConfigUsesPort(item.path, port) {
			logf("runtime cleanup stopping %s for busy port=%d: %v", item.service, port, err)
			cleanupManagedService(item.service)
			stopped = true
		}
	}
	for _, configPath := range managedGostConfigPathsForListenPort(port) {
		svcName := managedGostServiceNameForConfig(configPath)
		if svcName == "" || managedRuntimeConfigUsesPort(configPath, port) {
			continue
		}
		serviceCount, ok := managedRuntimeConfigServiceCount(configPath)
		if !ok || serviceCount > 0 {
			logf("runtime cleanup restarting %s for stale gost listener port=%d config=%s", svcName, port, configPath)
			restartManagedService(svcName)
		} else {
			logf("runtime cleanup stopping %s for stale gost listener port=%d config=%s", svcName, port, configPath)
			cleanupManagedService(svcName)
		}
		stopped = true
	}
	if !stopped {
		logf("runtime cleanup found busy port=%d but no managed gost config owns it: %v", port, err)
	}
}

func managedRuntimeConfigUsesPort(path string, port int) bool {
	if strings.HasSuffix(path, ".json") {
		return gostRuntimeConfigUsesPort(path, port)
	}
	return nginxRuntimeConfigUsesPort(path, port)
}

func managedRuntimeConfigServiceCount(path string) (int, bool) {
	if strings.HasSuffix(path, ".json") {
		return gostRuntimeConfigServiceCount(path)
	}
	return nginxRuntimeConfigServiceCount(path)
}

func gostRuntimeConfigUsesPort(path string, port int) bool {
	addrs, ok := readGostRuntimeServiceAddrs(path)
	if !ok {
		return false
	}
	for _, addr := range addrs {
		if addrUsesPort(addr, port) {
			return true
		}
	}
	return false
}

func gostRuntimeConfigServiceCount(path string) (int, bool) {
	addrs, ok := readGostRuntimeServiceAddrs(path)
	return len(addrs), ok
}

func readGostRuntimeServiceAddrs(path string) ([]string, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var cfg struct {
		Services []struct {
			Addr string `json:"addr"`
		} `json:"services"`
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		return nil, false
	}
	addrs := make([]string, 0, len(cfg.Services))
	for _, svc := range cfg.Services {
		addrs = append(addrs, svc.Addr)
	}
	return addrs, true
}

func nginxRuntimeListenAddrs(path string) ([]string, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	re := regexp.MustCompile(`(?m)\blisten\s+([^;]+);`)
	matches := re.FindAllStringSubmatch(string(b), -1)
	addrs := make([]string, 0, len(matches))
	for _, match := range matches {
		if len(match) < 2 {
			continue
		}
		fields := strings.Fields(match[1])
		if len(fields) == 0 {
			continue
		}
		addrs = append(addrs, fields[0])
	}
	return addrs, true
}

func nginxRuntimeConfigUsesPort(path string, port int) bool {
	addrs, ok := nginxRuntimeListenAddrs(path)
	if !ok {
		return false
	}
	for _, addr := range addrs {
		if addrUsesPort(addr, port) {
			return true
		}
	}
	return false
}

func nginxRuntimeConfigServiceCount(path string) (int, bool) {
	addrs, ok := nginxRuntimeListenAddrs(path)
	return len(addrs), ok
}

func addrUsesPort(addr string, port int) bool {
	text := strings.TrimSpace(addr)
	if text == "" || port <= 0 {
		return false
	}
	if text == ":"+strconv.Itoa(port) {
		return true
	}
	_, rawPort, err := net.SplitHostPort(text)
	if err != nil {
		return strings.HasSuffix(text, ":"+strconv.Itoa(port))
	}
	value, err := strconv.Atoi(rawPort)
	return err == nil && value == port
}

func managedGostConfigPathsForListenPort(port int) []string {
	paths := map[string]bool{}
	for _, pid := range listenPortOwnerPIDs(port) {
		cmdline, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cmdline")
		if err != nil {
			continue
		}
		cmd := strings.ReplaceAll(string(cmdline), "\x00", " ")
		for _, item := range managedRuntimeConfigs() {
			if strings.Contains(cmd, item.path) {
				paths[item.path] = true
			}
		}
	}
	result := make([]string, 0, len(paths))
	for path := range paths {
		result = append(result, path)
	}
	sort.Strings(result)
	return result
}

func managedGostServiceNameForConfig(path string) string {
	for _, item := range managedRuntimeConfigs() {
		if path == item.path {
			return item.service
		}
	}
	return ""
}

func managedRuntimeConfigs() []struct {
	path    string
	service string
} {
	return []struct {
		path    string
		service string
	}{
		{runtimeConfigPath, runtimeServiceName},
		{tunnelRuntimeConfigPath, tunnelRuntimeServiceName},
		{nginxConfigPath, nginxServiceName},
		{legacyRuntimeConfigPath, runtimeServiceName},
		{legacyTunnelRuntimeConfigPath, tunnelRuntimeServiceName},
		{legacyGostConfigPath, legacyGostServiceName},
		{legacyTunnelConfigPath, legacyTunnelServiceName},
	}
}

func shouldReportActionStatus(a action) bool {
	return a.ReportStatus == nil || *a.ReportStatus
}

func listenPortOwnerPIDs(port int) []int {
	if port <= 0 {
		return nil
	}
	if _, err := exec.LookPath("ss"); err != nil {
		return nil
	}
	portText := strconv.Itoa(port)
	out, _ := exec.Command("ss", "-ltnup").CombinedOutput()
	text := filterListenPortLines(string(out), portText)
	if strings.TrimSpace(text) == "" {
		return nil
	}
	re := regexp.MustCompile(`pid=([0-9]+)`)
	seen := map[int]bool{}
	var pids []int
	for _, match := range re.FindAllStringSubmatch(text, -1) {
		pid, err := strconv.Atoi(match[1])
		if err != nil || pid <= 0 || seen[pid] {
			continue
		}
		seen[pid] = true
		pids = append(pids, pid)
	}
	sort.Ints(pids)
	return pids
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
	name = sanitizeServiceName(name)
	if name == "" {
		logf("write service: empty service name")
		return false
	}
	execStart := systemdUnitExecStart(unit)
	if execStart == "" {
		logf("write service %s: missing ExecStart", name)
		return false
	}
	if isSystemdHost() {
		path := "/etc/systemd/system/" + name + ".service"
		if err := os.WriteFile(path, []byte(unit), 0644); err != nil {
			logf("write systemd unit %s: %v", name, err)
			return false
		}
		return runShell("systemctl daemon-reload") &&
			runShell("systemctl enable "+shellQuote(name)+".service") &&
			runShell("systemctl restart "+shellQuote(name)+".service")
	}
	if commandExists("rc-service") && commandExists("rc-update") {
		path := "/etc/init.d/" + name
		if err := os.WriteFile(path, []byte(openRCServiceScript(name, execStart)), 0755); err != nil {
			logf("write openrc service %s: %v", name, err)
			return false
		}
		return runShell("rc-update add "+shellQuote(name)+" default >/dev/null 2>&1 || true") &&
			runShell("rc-service "+shellQuote(name)+" restart")
	}
	if _, err := os.Stat("/etc/init.d"); err == nil {
		path := "/etc/init.d/" + name
		if err := os.WriteFile(path, []byte(sysVServiceScript(name, execStart)), 0755); err != nil {
			logf("write sysv service %s: %v", name, err)
			return false
		}
		return runShell("command -v update-rc.d >/dev/null 2>&1 && update-rc.d "+shellQuote(name)+" defaults >/dev/null 2>&1 || true") &&
			runShell("command -v chkconfig >/dev/null 2>&1 && chkconfig "+shellQuote(name)+" on >/dev/null 2>&1 || true") &&
			runShell("/etc/init.d/"+shellQuote(name)+" restart")
	}
	logf("write service %s: unsupported init system", name)
	return false
}

func managedServiceNamesForAction(a action) []string {
	port := a.SourcePort
	if port <= 0 {
		return nil
	}
	if a.ServiceName != "" || a.ServiceNameExtra != "" {
		names := []string{}
		if a.ServiceName != "" {
			names = append(names, a.ServiceName)
		}
		if a.ServiceNameExtra != "" {
			names = append(names, a.ServiceNameExtra)
		}
		return names
	}
	switch a.ForwardType {
	case "realm":
		return []string{"forwardx-realm-" + strconv.Itoa(port)}
	case "socat":
		if normalizeRuntimeProtocol(a.Protocol) == "both" {
			return []string{"forwardx-socat-tcp-" + strconv.Itoa(port), "forwardx-socat-udp-" + strconv.Itoa(port)}
		}
		return []string{"forwardx-socat-" + strconv.Itoa(port)}
	default:
		return nil
	}
}

func cleanupManagedService(name string) {
	name = sanitizeServiceName(name)
	if name == "" {
		return
	}
	_ = runShell(managedServiceCleanupShell(name))
}

func restartManagedService(name string) {
	name = sanitizeServiceName(name)
	if name == "" {
		return
	}
	q := shellQuote(name)
	_ = runShell("if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl restart " + q + ".service 2>/dev/null || true; elif command -v rc-service >/dev/null 2>&1; then rc-service " + q + " restart 2>/dev/null || true; elif [ -x /etc/init.d/" + name + " ]; then /etc/init.d/" + name + " restart 2>/dev/null || true; fi")
}

func sanitizeServiceName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return ""
	}
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			continue
		}
		return ""
	}
	return name
}

func commandExists(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func isSystemdHost() bool {
	if !commandExists("systemctl") {
		return false
	}
	if st, err := os.Stat("/run/systemd/system"); err == nil && st.IsDir() {
		return true
	}
	return false
}

func systemdUnitExecStart(unit string) string {
	for _, line := range strings.Split(unit, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "ExecStart=") {
			return strings.TrimSpace(strings.TrimPrefix(line, "ExecStart="))
		}
	}
	return ""
}

func openRCServiceScript(name, execStart string) string {
	return strings.Join([]string{
		"#!/sbin/openrc-run",
		"name=\"" + name + "\"",
		"description=\"ForwardX managed service " + name + "\"",
		"command=\"/bin/sh\"",
		"command_args=\"-lc " + shellQuote("exec "+execStart) + "\"",
		"command_background=true",
		"pidfile=\"/run/${RC_SVCNAME}.pid\"",
		"output_log=\"/var/log/forwardx-agent/${RC_SVCNAME}.log\"",
		"error_log=\"/var/log/forwardx-agent/${RC_SVCNAME}.log\"",
		"depend() {",
		"  need net",
		"}",
		"",
	}, "\n")
}

func sysVServiceScript(name, execStart string) string {
	quotedCmd := shellQuote("exec " + execStart)
	return strings.Join([]string{
		"#!/bin/sh",
		"### BEGIN INIT INFO",
		"# Provides:          " + name,
		"# Required-Start:    $network",
		"# Required-Stop:     $network",
		"# Default-Start:     2 3 4 5",
		"# Default-Stop:      0 1 6",
		"# Short-Description: ForwardX managed service " + name,
		"### END INIT INFO",
		"PIDFILE=/run/" + name + ".pid",
		"LOGFILE=/var/log/forwardx-agent/" + name + ".log",
		"CMD=" + quotedCmd,
		"start() {",
		"  mkdir -p /run /var/log/forwardx-agent",
		"  if [ -s \"$PIDFILE\" ] && kill -0 \"$(cat \"$PIDFILE\")\" 2>/dev/null; then return 0; fi",
		"  nohup sh -lc \"$CMD\" >> \"$LOGFILE\" 2>&1 &",
		"  echo $! > \"$PIDFILE\"",
		"}",
		"stop() {",
		"  if [ -s \"$PIDFILE\" ]; then kill \"$(cat \"$PIDFILE\")\" 2>/dev/null || true; rm -f \"$PIDFILE\"; fi",
		"}",
		"case \"$1\" in",
		"  start) start ;;",
		"  stop) stop ;;",
		"  restart) stop; sleep 1; start ;;",
		"  status) [ -s \"$PIDFILE\" ] && kill -0 \"$(cat \"$PIDFILE\")\" 2>/dev/null ;;",
		"  *) echo \"Usage: $0 {start|stop|restart|status}\"; exit 1 ;;",
		"esac",
		"",
	}, "\n")
}

func managedServiceCleanupShell(name string) string {
	q := shellQuote(name)
	return "if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl stop " + q + ".service 2>/dev/null || true; systemctl disable " + q + ".service 2>/dev/null || true; rm -f /etc/systemd/system/" + name + ".service; systemctl daemon-reload 2>/dev/null || true; fi; " +
		"if command -v rc-service >/dev/null 2>&1; then rc-service " + q + " stop 2>/dev/null || true; fi; " +
		"if command -v rc-update >/dev/null 2>&1; then rc-update del " + q + " default 2>/dev/null || true; fi; " +
		"if [ -x /etc/init.d/" + name + " ]; then /etc/init.d/" + name + " stop 2>/dev/null || true; fi; " +
		"if command -v update-rc.d >/dev/null 2>&1; then update-rc.d -f " + q + " remove >/dev/null 2>&1 || true; fi; " +
		"if command -v chkconfig >/dev/null 2>&1; then chkconfig " + q + " off >/dev/null 2>&1 || true; fi; " +
		"rm -f /etc/init.d/" + name
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
		_ = os.WriteFile("/var/lib/forwardx-agent/target_"+port+".info", []byte(fmt.Sprintf("%s\n%d\n%s\n", a.TargetIP, a.TargetPort, normalizeRuntimeProtocol(a.Protocol))), 0644)
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
		_ = os.WriteFile("/var/lib/forwardx-agent/target_"+port+".info", []byte(fmt.Sprintf("%s\n%d\n%s\n", r.TargetIP, r.TargetPort, normalizeRuntimeProtocol(r.Protocol))), 0644)
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
				if shouldLogAgentReport("reconcile-pending:"+port, agentReportLogInterval) {
					logf("reconcile skip pending action port=%s", port)
				}
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
	return "if nft list table inet forwardx >/dev/null 2>&1; then for c in prerouting postrouting forward traffic_prerouting traffic_postrouting traffic_forward; do for h in $(nft -a list chain inet forwardx \"$c\" 2>/dev/null | awk -v marker=\"" + comment + "\" '$0 ~ marker {print $NF}'); do nft delete rule inet forwardx \"$c\" handle \"$h\" 2>/dev/null; true; done; done; nft flush chain inet forwardx in_" + id + " 2>/dev/null; true; nft delete chain inet forwardx in_" + id + " 2>/dev/null; true; nft flush chain inet forwardx out_" + id + " 2>/dev/null; true; nft delete chain inet forwardx out_" + id + " 2>/dev/null; true; fi; true"
}

func nftPortCleanupCmd(port string, protocol string) string {
	protos := []string{"tcp", "udp"}
	if protocol == "tcp" || protocol == "udp" {
		protos = []string{protocol}
	}
	parts := make([]string, 0, len(protos))
	for _, proto := range protos {
		awk := fmt.Sprintf(`awk '/ %s dport %s( |$)/ && / dnat / {print $NF}'`, proto, port)
		parts = append(parts, fmt.Sprintf(`if nft list chain inet forwardx prerouting >/dev/null 2>&1; then for h in $(nft -a list chain inet forwardx prerouting 2>/dev/null | %s); do nft delete rule inet forwardx prerouting handle "$h" 2>/dev/null; true; done; fi`, awk))
	}
	return strings.Join(parts, "; ") + "; true"
}

func iptablesAgentBinaries() []string {
	return []string{"iptables", "ip6tables"}
}

func iptablesAgentAddress(value string) string {
	text := strings.TrimSpace(value)
	text = strings.TrimPrefix(strings.TrimSuffix(text, "]"), "[")
	return text
}

func iptablesAgentBinaryForTarget(targetIP string) string {
	if strings.Contains(iptablesAgentAddress(targetIP), ":") {
		return "ip6tables"
	}
	return "iptables"
}

func iptablesAgentCommand(binary string, args string, optional bool) string {
	if binary == "ip6tables" {
		if optional {
			return "if command -v ip6tables >/dev/null 2>&1; then ip6tables " + args + "; fi; true"
		}
		return "if command -v ip6tables >/dev/null 2>&1; then ip6tables " + args + "; else exit 1; fi"
	}
	cmd := "iptables " + args
	if optional {
		return cmd + "; true"
	}
	return cmd
}

func iptablesAgentEnsure(binary string, table string, rule string) string {
	tableArg := ""
	if table != "" {
		tableArg = "-t " + table + " "
	}
	cmd := "if " + binary + " " + tableArg + "-C " + rule + " 2>/dev/null; then :; else " + binary + " " + tableArg + "-A " + rule + "; fi"
	if binary == "ip6tables" {
		return "if command -v ip6tables >/dev/null 2>&1; then " + cmd + "; fi"
	}
	return cmd
}

func iptablesAgentDelete(binary string, table string, rule string) string {
	tableArg := ""
	if table != "" {
		tableArg = "-t " + table + " "
	}
	cmd := "while " + binary + " " + tableArg + "-C " + rule + " 2>/dev/null; do if " + binary + " " + tableArg + "-D " + rule + " 2>/dev/null; then :; else break; fi; done"
	if binary == "ip6tables" {
		return "if command -v ip6tables >/dev/null 2>&1; then " + cmd + "; fi; true"
	}
	return cmd + "; true"
}

func iptablesAgentFlush(binary string, table string, chain string) string {
	return iptablesAgentCommand(binary, "-t "+table+" -F "+chain+" 2>/dev/null", true)
}

func iptablesAgentDeleteChain(binary string, table string, chain string) string {
	return iptablesAgentCommand(binary, "-t "+table+" -X "+chain+" 2>/dev/null", true)
}

func iptablesAgentDnatTarget(targetIP string, targetPort int) string {
	host := iptablesAgentAddress(targetIP)
	port := strconv.Itoa(targetPort)
	if strings.Contains(host, ":") {
		return "[" + host + "]:" + port
	}
	return host + ":" + port
}

func iptablesAgentDeleteDnatRulesForPort(binary string, port string, protocol string) string {
	protos := []string{"tcp", "udp"}
	if protocol == "tcp" || protocol == "udp" {
		protos = []string{protocol}
	}
	parts := make([]string, 0, len(protos))
	for _, proto := range protos {
		awk := fmt.Sprintf(`awk '/^-A PREROUTING / && / -p %s / && /--dport %s( |$)/ && / -j DNAT / {sub(/^-A/, "-D"); print}'`, proto, port)
		parts = append(parts, fmt.Sprintf(`while rule=$(%s -t nat -S PREROUTING 2>/dev/null | %s | head -n 1) && [ -n "$rule" ]; do %s -t nat $rule 2>/dev/null || break; done`, binary, awk, binary))
	}
	cmd := strings.Join(parts, "; ")
	if binary == "ip6tables" {
		return "if command -v ip6tables >/dev/null 2>&1; then " + cmd + "; fi; true"
	}
	return cmd + "; true"
}

func managedPortCleanupCmds(port string) []string {
	inMarker := "fwx-stat-" + port + ":in"
	outMarker := "fwx-stat-" + port + ":out"
	cmds := append(managedListenerCleanupCmds(port),
		managedServiceCleanupShell("forwardx-socat-"+port),
		managedServiceCleanupShell("forwardx-socat-tcp-"+port),
		managedServiceCleanupShell("forwardx-socat-udp-"+port),
		managedServiceCleanupShell("forwardx-realm-"+port),
		managedNginxCleanupShell(port),
	)
	cmds = append(cmds, nftPortCleanupCmd(port, "both"))
	for _, binary := range iptablesAgentBinaries() {
		cmds = append(cmds, iptablesAgentDeleteDnatRulesForPort(binary, port, "both"))
		directRules := []string{
			fmt.Sprintf(`PREROUTING -p tcp --dport %s -m comment --comment %q`, port, inMarker),
			fmt.Sprintf(`PREROUTING -p udp --dport %s -m comment --comment %q`, port, inMarker),
			fmt.Sprintf(`INPUT -p tcp --dport %s -m comment --comment %q`, port, inMarker),
			fmt.Sprintf(`INPUT -p udp --dport %s -m comment --comment %q`, port, inMarker),
			fmt.Sprintf(`POSTROUTING -p tcp --sport %s -m comment --comment %q`, port, outMarker),
			fmt.Sprintf(`POSTROUTING -p udp --sport %s -m comment --comment %q`, port, outMarker),
			fmt.Sprintf(`OUTPUT -p tcp --sport %s -m comment --comment %q`, port, outMarker),
			fmt.Sprintf(`OUTPUT -p udp --sport %s -m comment --comment %q`, port, outMarker),
		}
		for _, rule := range directRules {
			cmds = append(cmds, iptablesAgentDelete(binary, "mangle", rule))
		}
		legacyRules := []string{
			fmt.Sprintf(`PREROUTING -p tcp --dport %s -j FWX_IN_%s`, port, port),
			fmt.Sprintf(`PREROUTING -p udp --dport %s -j FWX_IN_%s`, port, port),
			fmt.Sprintf(`POSTROUTING -p tcp --sport %s -j FWX_OUT_%s`, port, port),
			fmt.Sprintf(`POSTROUTING -p udp --sport %s -j FWX_OUT_%s`, port, port),
			fmt.Sprintf(`INPUT -p tcp --dport %s -j FWX_IN_%s`, port, port),
			fmt.Sprintf(`INPUT -p udp --dport %s -j FWX_IN_%s`, port, port),
			fmt.Sprintf(`OUTPUT -p tcp --sport %s -j FWX_OUT_%s`, port, port),
			fmt.Sprintf(`OUTPUT -p udp --sport %s -j FWX_OUT_%s`, port, port),
			fmt.Sprintf(`FORWARD -p tcp -j FWX_IN_%s`, port),
			fmt.Sprintf(`FORWARD -p udp -j FWX_IN_%s`, port),
			fmt.Sprintf(`FORWARD -p tcp -j FWX_OUT_%s`, port),
			fmt.Sprintf(`FORWARD -p udp -j FWX_OUT_%s`, port),
		}
		for _, rule := range legacyRules {
			cmds = append(cmds, iptablesAgentDelete(binary, "mangle", rule))
		}
		cmds = append(cmds,
			iptablesAgentFlush(binary, "mangle", "FWX_IN_"+port),
			iptablesAgentDeleteChain(binary, "mangle", "FWX_IN_"+port),
			iptablesAgentFlush(binary, "mangle", "FWX_OUT_"+port),
			iptablesAgentDeleteChain(binary, "mangle", "FWX_OUT_"+port),
		)
	}
	cmds = append(cmds, "rm -f /var/lib/forwardx-agent/traffic_"+port+".prev /var/lib/forwardx-agent/port_"+port+".rule /var/lib/forwardx-agent/port_"+port+".fwtype /var/lib/forwardx-agent/target_"+port+".info 2>/dev/null || true")
	if targetIP, targetPort, _, ok := readTargetInfo(port); ok {
		target := iptablesAgentAddress(targetIP)
		tp := strconv.Itoa(targetPort)
		binary := iptablesAgentBinaryForTarget(target)
		dnatTarget := iptablesAgentDnatTarget(target, targetPort)
		targetCmds := []string{}
		for _, proto := range []string{"tcp", "udp"} {
			stateMatch := ""
			if proto == "tcp" {
				stateMatch = "-m state --state ESTABLISHED,RELATED "
			}
			targetRules := []struct {
				table string
				rule  string
			}{
				{"nat", fmt.Sprintf(`PREROUTING -p %s --dport %s -j DNAT --to-destination %s`, proto, port, dnatTarget)},
				{"nat", fmt.Sprintf(`POSTROUTING -p %s -d %s --dport %s -j MASQUERADE`, proto, target, tp)},
				{"", fmt.Sprintf(`FORWARD -p %s -d %s --dport %s -j ACCEPT`, proto, target, tp)},
				{"", fmt.Sprintf(`FORWARD -p %s -s %s --sport %s %s-j ACCEPT`, proto, target, tp, stateMatch)},
				{"mangle", fmt.Sprintf(`FORWARD -p %s -d %s --dport %s -m comment --comment %q`, proto, target, tp, inMarker)},
				{"mangle", fmt.Sprintf(`FORWARD -p %s -s %s --sport %s -m comment --comment %q`, proto, target, tp, outMarker)},
				{"mangle", fmt.Sprintf(`FORWARD -p %s -d %s --dport %s -j FWX_IN_%s`, proto, target, tp, port)},
				{"mangle", fmt.Sprintf(`FORWARD -p %s -s %s --sport %s -j FWX_OUT_%s`, proto, target, tp, port)},
			}
			for _, targetRule := range targetRules {
				targetCmds = append(targetCmds, iptablesAgentDelete(binary, targetRule.table, targetRule.rule))
			}
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
		"for pid in $(pgrep -f '[f]orwardx-udp2raw .*:"+port+"' 2>/dev/null || true); do if [ \"$pid\" = \"$$\" ] || [ \"$pid\" = \"$PPID\" ]; then continue; fi; kill \"$pid\" 2>/dev/null || true; done",
	)
	return cmds
}

func managedNginxCleanupShell(port string) string {
	return "if [ -f /etc/forwardx/nginx/nginx.conf ] && grep -Eq \"listen .*:" + port + "( |;)|listen \\\\[::\\\\]:" + port + "( |;)|listen 0.0.0.0:" + port + "( |;)\" /etc/forwardx/nginx/nginx.conf 2>/dev/null; then " + managedServiceCleanupShell("forwardx-nginx") + "; fi"
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
	commands := []string{}
	for _, binary := range iptablesAgentBinaries() {
		legacyRules := []string{
			fmt.Sprintf(`PREROUTING -p tcp --dport %s -j FWX_IN_%s`, p, p),
			fmt.Sprintf(`PREROUTING -p udp --dport %s -j FWX_IN_%s`, p, p),
			fmt.Sprintf(`INPUT -p tcp --dport %s -j FWX_IN_%s`, p, p),
			fmt.Sprintf(`INPUT -p udp --dport %s -j FWX_IN_%s`, p, p),
			fmt.Sprintf(`POSTROUTING -p tcp --sport %s -j FWX_OUT_%s`, p, p),
			fmt.Sprintf(`POSTROUTING -p udp --sport %s -j FWX_OUT_%s`, p, p),
			fmt.Sprintf(`OUTPUT -p tcp --sport %s -j FWX_OUT_%s`, p, p),
			fmt.Sprintf(`OUTPUT -p udp --sport %s -j FWX_OUT_%s`, p, p),
		}
		for _, rule := range legacyRules {
			commands = append(commands, iptablesAgentDelete(binary, "mangle", rule))
		}
	}
	for _, proto := range protos {
		for _, binary := range iptablesAgentBinaries() {
			directRules := []string{
				fmt.Sprintf(`PREROUTING -p %s --dport %s -m comment --comment %q`, proto, p, inMarker),
				fmt.Sprintf(`INPUT -p %s --dport %s -m comment --comment %q`, proto, p, inMarker),
				fmt.Sprintf(`POSTROUTING -p %s --sport %s -m comment --comment %q`, proto, p, outMarker),
				fmt.Sprintf(`OUTPUT -p %s --sport %s -m comment --comment %q`, proto, p, outMarker),
			}
			for _, rule := range directRules {
				commands = append(commands, iptablesAgentEnsure(binary, "mangle", rule))
			}
		}
		if targetIP != "" && targetPort > 0 {
			target := iptablesAgentAddress(targetIP)
			tp := strconv.Itoa(targetPort)
			binary := iptablesAgentBinaryForTarget(target)
			cleanupRules := []string{
				fmt.Sprintf(`OUTPUT -p %s -d %s --dport %s -j FWX_IN_%s`, proto, target, tp, p),
				fmt.Sprintf(`POSTROUTING -p %s -d %s --dport %s -j FWX_IN_%s`, proto, target, tp, p),
				fmt.Sprintf(`PREROUTING -p %s -s %s --sport %s -j FWX_OUT_%s`, proto, target, tp, p),
				fmt.Sprintf(`INPUT -p %s -s %s --sport %s -j FWX_OUT_%s`, proto, target, tp, p),
				fmt.Sprintf(`FORWARD -p %s -d %s --dport %s -j FWX_IN_%s`, proto, target, tp, p),
				fmt.Sprintf(`FORWARD -p %s -s %s --sport %s -j FWX_OUT_%s`, proto, target, tp, p),
			}
			for _, rule := range cleanupRules {
				commands = append(commands, iptablesAgentDelete(binary, "mangle", rule))
			}
			commands = append(commands,
				iptablesAgentEnsure(binary, "mangle", fmt.Sprintf(`FORWARD -p %s -d %s --dport %s -m comment --comment %q`, proto, target, tp, inMarker)),
				iptablesAgentEnsure(binary, "mangle", fmt.Sprintf(`FORWARD -p %s -s %s --sport %s -m comment --comment %q`, proto, target, tp, outMarker)),
			)
		}
	}
	for _, binary := range iptablesAgentBinaries() {
		commands = append(commands,
			iptablesAgentFlush(binary, "mangle", "FWX_IN_"+p),
			iptablesAgentDeleteChain(binary, "mangle", "FWX_IN_"+p),
			iptablesAgentFlush(binary, "mangle", "FWX_OUT_"+p),
			iptablesAgentDeleteChain(binary, "mangle", "FWX_OUT_"+p),
		)
	}
	for _, cmd := range commands {
		if ok := runShell(cmd); !ok && shouldLogAgentReport("traffic-counting-repair:"+p, 5*time.Minute) {
			logf("traffic counting repair failed port=%s target=%s:%d protocol=%s cmd=%s", p, targetIP, targetPort, protocol, cmd)
		}
	}
}

func ensureCountingChainsIfNeeded(r runningRule) {
	if r.ForwardType == "nftables" || r.SourcePort <= 0 {
		return
	}
	signature := fmt.Sprintf("%d|%s|%d|%s", r.SourcePort, r.TargetIP, r.TargetPort, r.Protocol)
	key := strconv.Itoa(r.SourcePort)
	now := time.Now()
	countingChainMu.Lock()
	lastSig := countingChainSignatures[key]
	lastChecked := countingChainCheckedAt[key]
	if lastSig == signature && !lastChecked.IsZero() && now.Sub(lastChecked) < countingChainRefreshInterval {
		countingChainMu.Unlock()
		return
	}
	countingChainSignatures[key] = signature
	countingChainCheckedAt[key] = now
	countingChainMu.Unlock()
	ensureCountingChains(r.SourcePort, r.TargetIP, r.TargetPort, r.Protocol)
}

func removeState(port int) {
	p := strconv.Itoa(port)
	_ = os.Remove("/var/lib/forwardx-agent/port_" + p + ".rule")
	_ = os.Remove("/var/lib/forwardx-agent/port_" + p + ".fwtype")
	_ = os.Remove("/var/lib/forwardx-agent/target_" + p + ".info")
	_ = os.Remove("/var/lib/forwardx-agent/traffic_" + p + ".prev")
	removeTunnelStateByPort(p)
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
	parts := []string{
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
		strconv.FormatBool(spec.ProxyProtocolReceive),
		strconv.FormatBool(spec.ProxyProtocolSend),
		strconv.FormatBool(spec.ProxyProtocolExitReceive),
		strconv.FormatBool(spec.ProxyProtocolExitSend),
		strconv.Itoa(normalizeProxyProtocolVersion(spec.ProxyProtocolVersion)),
		strconv.FormatBool(spec.TCPFastOpen),
		spec.RelayExitHost,
		strconv.Itoa(spec.RelayExitPort),
		spec.RelayKey,
	}
	for _, exit := range spec.Exits {
		parts = append(parts, strings.TrimSpace(exit.Host), strconv.Itoa(exit.Port), strings.TrimSpace(exit.Key))
	}
	return strings.Join(parts, "|")
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
	for i := range spec.Exits {
		spec.Exits[i].Host = strings.TrimSpace(spec.Exits[i].Host)
		if spec.Exits[i].Key == "" {
			spec.Exits[i].Key = spec.Key
		}
	}

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
		spec.PanelURL = currentPanelURL(cfg)
		spec.Token = cfg.Token
	}
	logf(
		"proxy-debug fxp config role=%s tunnel=%d rule=%d listen=%d protocol=%s proxyReceive=%v proxySend=%v proxyExitReceive=%v proxyExitSend=%v tcpFastOpen=%v exit=%s:%d relayNext=%s:%d target=%s:%d",
		spec.Role,
		spec.TunnelID,
		spec.RuleID,
		spec.ListenPort,
		spec.Protocol,
		spec.ProxyProtocolReceive,
		spec.ProxyProtocolSend,
		spec.ProxyProtocolExitReceive,
		spec.ProxyProtocolExitSend,
		spec.TCPFastOpen,
		spec.ExitHost,
		spec.ExitPort,
		spec.RelayExitHost,
		spec.RelayExitPort,
		spec.TargetIP,
		spec.TargetPort,
	)
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
		conn, err := net.ListenPacket("udp", ":"+strconv.Itoa(port))
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
		strconv.FormatBool(rule.ProxyProtocolReceive),
		strconv.FormatBool(rule.ProxyProtocolSend),
		strconv.Itoa(normalizeProxyProtocolVersion(rule.ProxyProtocolVersion)),
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
	logf("protocol guard started rule=%d tunnel=%d listen=:%d target=%s:%d proxyReceive=%v proxySend=%v proxyVersion=%d", rule.RuleID, rule.TunnelID, rule.ListenPort, rule.TargetIP, rule.TargetPort, rule.ProxyProtocolReceive, rule.ProxyProtocolSend, normalizeProxyProtocolVersion(rule.ProxyProtocolVersion))
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
	first := buf[:n]
	proxyInfo := proxyProtocolInfoFromConn(client)
	if s.rule.ProxyProtocolReceive {
		parsed, remaining, ok, err := consumeProxyProtocolFromConn(client, first, 5*time.Second)
		if err != nil {
			logf("protocol guard proxy receive failed rule=%d: %v", s.rule.RuleID, err)
			return
		}
		if ok {
			proxyInfo = parsed
			first = remaining
		}
	}
	if s.rule.Policy.enabled() {
		sample, proto, blocked := detectBlockedProtocolWithConfirmations(client, first, s.rule.Policy)
		first = sample
		if blocked && proto != "" {
			reportProtocolBlock(cfg, s.rule, proto)
			return
		}
	} else if proto := detectBlockedProtocol(first, s.rule.Policy); proto != "" {
		reportProtocolBlock(cfg, s.rule, proto)
		return
	}
	target, err := net.DialTimeout("tcp", net.JoinHostPort(s.rule.TargetIP, strconv.Itoa(s.rule.TargetPort)), 10*time.Second)
	if err != nil {
		logf("protocol guard dial target rule=%d: %v", s.rule.RuleID, err)
		return
	}
	defer target.Close()
	if s.rule.ProxyProtocolSend {
		header := buildProxyProtocol(s.rule.ProxyProtocolVersion, proxyInfo, client.RemoteAddr(), target.LocalAddr(), target.RemoteAddr())
		if len(header) > 0 {
			if _, err := target.Write(header); err != nil {
				return
			}
		}
	}
	if len(first) > 0 {
		if _, err := target.Write(first); err != nil {
			return
		}
	}
	errCh := make(chan error, 2)
	go func() { _, err := io.Copy(target, client); errCh <- err }()
	go func() { _, err := io.Copy(client, target); errCh <- err }()
	<-errCh
}

type proxyProtocolInfo struct {
	SourceIP   string
	DestIP     string
	SourcePort int
	DestPort   int
}

func proxyProtocolInfoFromConn(conn net.Conn) proxyProtocolInfo {
	info := proxyProtocolInfo{}
	if addr, ok := conn.RemoteAddr().(*net.TCPAddr); ok {
		info.SourceIP = addr.IP.String()
		info.SourcePort = addr.Port
	}
	if addr, ok := conn.LocalAddr().(*net.TCPAddr); ok {
		info.DestIP = addr.IP.String()
		info.DestPort = addr.Port
	}
	return info
}

func consumeProxyProtocolV1(data []byte) (proxyProtocolInfo, []byte, bool, error) {
	if !bytes.HasPrefix(data, []byte("PROXY ")) {
		return proxyProtocolInfo{}, data, false, nil
	}
	end := bytes.Index(data, []byte("\r\n"))
	if end < 0 {
		return proxyProtocolInfo{}, nil, false, errors.New("incomplete proxy protocol header")
	}
	line := string(data[:end])
	parts := strings.Fields(line)
	if len(parts) < 2 || parts[0] != "PROXY" {
		return proxyProtocolInfo{}, nil, false, errors.New("invalid proxy protocol header")
	}
	if parts[1] == "UNKNOWN" {
		return proxyProtocolInfo{}, data[end+2:], true, nil
	}
	if len(parts) != 6 || (parts[1] != "TCP4" && parts[1] != "TCP6") {
		return proxyProtocolInfo{}, nil, false, errors.New("unsupported proxy protocol header")
	}
	sourcePort, err := strconv.Atoi(parts[4])
	if err != nil || sourcePort < 0 || sourcePort > 65535 {
		return proxyProtocolInfo{}, nil, false, errors.New("invalid proxy protocol source port")
	}
	destPort, err := strconv.Atoi(parts[5])
	if err != nil || destPort < 0 || destPort > 65535 {
		return proxyProtocolInfo{}, nil, false, errors.New("invalid proxy protocol destination port")
	}
	return proxyProtocolInfo{
		SourceIP:   parts[2],
		DestIP:     parts[3],
		SourcePort: sourcePort,
		DestPort:   destPort,
	}, data[end+2:], true, nil
}

func consumeProxyProtocolV1FromConn(conn net.Conn, data []byte, timeout time.Duration) (proxyProtocolInfo, []byte, bool, error) {
	buf := append([]byte(nil), data...)
	for len(buf) > 0 && len(buf) < 108 && (bytes.HasPrefix(buf, []byte("PROXY ")) || bytes.HasPrefix([]byte("PROXY "), buf)) && bytes.Index(buf, []byte("\r\n")) < 0 {
		if timeout > 0 {
			_ = conn.SetReadDeadline(time.Now().Add(timeout))
		}
		tmp := make([]byte, 108-len(buf))
		n, err := conn.Read(tmp)
		if timeout > 0 {
			_ = conn.SetReadDeadline(time.Time{})
		}
		if n > 0 {
			buf = append(buf, tmp[:n]...)
		}
		if err != nil {
			if len(buf) > 0 && bytes.HasPrefix([]byte("PROXY "), buf) {
				return proxyProtocolInfo{}, nil, false, err
			}
			break
		}
	}
	return consumeProxyProtocolV1(buf)
}

var proxyProtocolV2Signature = []byte{0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a}

func normalizeProxyProtocolVersion(version int) int {
	if version == 2 {
		return 2
	}
	return 1
}

func consumeProxyProtocol(data []byte) (proxyProtocolInfo, []byte, bool, error) {
	if bytes.HasPrefix(data, []byte("PROXY ")) {
		return consumeProxyProtocolV1(data)
	}
	if bytes.HasPrefix(data, proxyProtocolV2Signature) {
		return consumeProxyProtocolV2(data)
	}
	if len(data) > 0 && len(data) < len(proxyProtocolV2Signature) && bytes.HasPrefix(proxyProtocolV2Signature, data) {
		return proxyProtocolInfo{}, nil, false, errors.New("incomplete proxy protocol v2 header")
	}
	return proxyProtocolInfo{}, data, false, nil
}

func consumeProxyProtocolFromConn(conn net.Conn, data []byte, timeout time.Duration) (proxyProtocolInfo, []byte, bool, error) {
	buf := append([]byte(nil), data...)
	if len(buf) == 0 {
		return consumeProxyProtocol(buf)
	}
	if bytes.HasPrefix(buf, []byte("PROXY ")) || bytes.HasPrefix([]byte("PROXY "), buf) {
		return consumeProxyProtocolV1FromConn(conn, buf, timeout)
	}
	if bytes.HasPrefix(buf, proxyProtocolV2Signature) || bytes.HasPrefix(proxyProtocolV2Signature, buf) {
		for len(buf) < 16 {
			more, err := readProxyProtocolMore(conn, timeout, 16-len(buf))
			if len(more) > 0 {
				buf = append(buf, more...)
			}
			if err != nil {
				return proxyProtocolInfo{}, nil, false, err
			}
			if len(more) == 0 {
				return proxyProtocolInfo{}, nil, false, errors.New("incomplete proxy protocol v2 header")
			}
		}
		length := int(binary.BigEndian.Uint16(buf[14:16]))
		need := 16 + length
		for len(buf) < need {
			more, err := readProxyProtocolMore(conn, timeout, need-len(buf))
			if len(more) > 0 {
				buf = append(buf, more...)
			}
			if err != nil {
				return proxyProtocolInfo{}, nil, false, err
			}
			if len(more) == 0 {
				return proxyProtocolInfo{}, nil, false, errors.New("incomplete proxy protocol v2 payload")
			}
		}
	}
	return consumeProxyProtocol(buf)
}

func readProxyProtocolMore(conn net.Conn, timeout time.Duration, limit int) ([]byte, error) {
	if limit <= 0 {
		return nil, nil
	}
	if timeout > 0 {
		_ = conn.SetReadDeadline(time.Now().Add(timeout))
	}
	tmp := make([]byte, limit)
	n, err := conn.Read(tmp)
	if timeout > 0 {
		_ = conn.SetReadDeadline(time.Time{})
	}
	if n > 0 {
		return tmp[:n], err
	}
	return nil, err
}

func consumeProxyProtocolV2(data []byte) (proxyProtocolInfo, []byte, bool, error) {
	if !bytes.HasPrefix(data, proxyProtocolV2Signature) {
		return proxyProtocolInfo{}, data, false, nil
	}
	if len(data) < 16 {
		return proxyProtocolInfo{}, nil, false, errors.New("incomplete proxy protocol v2 header")
	}
	versionCommand := data[12]
	if versionCommand>>4 != 0x2 {
		return proxyProtocolInfo{}, nil, false, errors.New("invalid proxy protocol v2 version")
	}
	command := versionCommand & 0x0f
	familyProtocol := data[13]
	length := int(binary.BigEndian.Uint16(data[14:16]))
	if len(data) < 16+length {
		return proxyProtocolInfo{}, nil, false, errors.New("incomplete proxy protocol v2 payload")
	}
	payload := data[16 : 16+length]
	remaining := data[16+length:]
	if command == 0x0 {
		return proxyProtocolInfo{}, remaining, true, nil
	}
	if command != 0x1 {
		return proxyProtocolInfo{}, nil, false, errors.New("unsupported proxy protocol v2 command")
	}
	switch familyProtocol {
	case 0x11:
		if len(payload) < 12 {
			return proxyProtocolInfo{}, nil, false, errors.New("invalid proxy protocol v2 tcp4 payload")
		}
		return proxyProtocolInfo{SourceIP: net.IP(payload[0:4]).String(), DestIP: net.IP(payload[4:8]).String(), SourcePort: int(binary.BigEndian.Uint16(payload[8:10])), DestPort: int(binary.BigEndian.Uint16(payload[10:12]))}, remaining, true, nil
	case 0x21:
		if len(payload) < 36 {
			return proxyProtocolInfo{}, nil, false, errors.New("invalid proxy protocol v2 tcp6 payload")
		}
		return proxyProtocolInfo{SourceIP: net.IP(payload[0:16]).String(), DestIP: net.IP(payload[16:32]).String(), SourcePort: int(binary.BigEndian.Uint16(payload[32:34])), DestPort: int(binary.BigEndian.Uint16(payload[34:36]))}, remaining, true, nil
	case 0x00:
		return proxyProtocolInfo{}, remaining, true, nil
	default:
		return proxyProtocolInfo{}, nil, false, errors.New("unsupported proxy protocol v2 address family")
	}
}

func buildProxyProtocol(version int, info proxyProtocolInfo, fallbackSource net.Addr, targetLocal net.Addr, targetRemote net.Addr) []byte {
	if normalizeProxyProtocolVersion(version) == 2 {
		return buildProxyProtocolV2(info, fallbackSource, targetLocal, targetRemote)
	}
	return []byte(buildProxyProtocolV1(info, fallbackSource, targetLocal, targetRemote))
}

func buildProxyProtocolV2(info proxyProtocolInfo, fallbackSource net.Addr, targetLocal net.Addr, targetRemote net.Addr) []byte {
	sourceIP, destIP, sourcePort, destPort := proxyProtocolEndpointValues(info, fallbackSource, targetLocal, targetRemote)
	src := net.ParseIP(sourceIP)
	dst := net.ParseIP(destIP)
	if src == nil || dst == nil || sourcePort <= 0 || destPort <= 0 {
		return buildProxyProtocolV2Local()
	}
	if src4, dst4 := src.To4(), dst.To4(); src4 != nil && dst4 != nil {
		buf := make([]byte, 28)
		copy(buf, proxyProtocolV2Signature)
		buf[12] = 0x21
		buf[13] = 0x11
		binary.BigEndian.PutUint16(buf[14:16], 12)
		copy(buf[16:20], src4)
		copy(buf[20:24], dst4)
		binary.BigEndian.PutUint16(buf[24:26], uint16(sourcePort))
		binary.BigEndian.PutUint16(buf[26:28], uint16(destPort))
		return buf
	}
	src16 := src.To16()
	dst16 := dst.To16()
	if src16 == nil || dst16 == nil || src.To4() != nil || dst.To4() != nil {
		return buildProxyProtocolV2Local()
	}
	buf := make([]byte, 52)
	copy(buf, proxyProtocolV2Signature)
	buf[12] = 0x21
	buf[13] = 0x21
	binary.BigEndian.PutUint16(buf[14:16], 36)
	copy(buf[16:32], src16)
	copy(buf[32:48], dst16)
	binary.BigEndian.PutUint16(buf[48:50], uint16(sourcePort))
	binary.BigEndian.PutUint16(buf[50:52], uint16(destPort))
	return buf
}

func buildProxyProtocolV2Local() []byte {
	buf := make([]byte, 16)
	copy(buf, proxyProtocolV2Signature)
	buf[12] = 0x20
	buf[13] = 0x00
	return buf
}

func proxyProtocolEndpointValues(info proxyProtocolInfo, fallbackSource net.Addr, targetLocal net.Addr, targetRemote net.Addr) (string, string, int, int) {
	sourceIP := strings.TrimSpace(info.SourceIP)
	destIP := strings.TrimSpace(info.DestIP)
	sourcePort := info.SourcePort
	destPort := info.DestPort
	if sourceIP == "" {
		if addr, ok := fallbackSource.(*net.TCPAddr); ok {
			sourceIP = addr.IP.String()
			sourcePort = addr.Port
		}
	}
	if destIP == "" {
		if addr, ok := targetRemote.(*net.TCPAddr); ok {
			destIP = addr.IP.String()
			destPort = addr.Port
		}
	}
	if destPort <= 0 {
		if addr, ok := targetRemote.(*net.TCPAddr); ok {
			destPort = addr.Port
		}
	}
	if sourcePort <= 0 {
		if addr, ok := fallbackSource.(*net.TCPAddr); ok {
			sourcePort = addr.Port
		}
	}
	if destIP == "" {
		if addr, ok := targetLocal.(*net.TCPAddr); ok {
			destIP = addr.IP.String()
		}
	}
	return sourceIP, destIP, sourcePort, destPort
}
func buildProxyProtocolV1(info proxyProtocolInfo, fallbackSource net.Addr, targetLocal net.Addr, targetRemote net.Addr) string {
	sourceIP := strings.TrimSpace(info.SourceIP)
	destIP := strings.TrimSpace(info.DestIP)
	sourcePort := info.SourcePort
	destPort := info.DestPort
	if sourceIP == "" {
		if addr, ok := fallbackSource.(*net.TCPAddr); ok {
			sourceIP = addr.IP.String()
			sourcePort = addr.Port
		}
	}
	if destIP == "" {
		if addr, ok := targetRemote.(*net.TCPAddr); ok {
			destIP = addr.IP.String()
			destPort = addr.Port
		}
	}
	if destPort <= 0 {
		if addr, ok := targetRemote.(*net.TCPAddr); ok {
			destPort = addr.Port
		}
	}
	if sourcePort <= 0 {
		if addr, ok := fallbackSource.(*net.TCPAddr); ok {
			sourcePort = addr.Port
		}
	}
	if destIP == "" {
		if addr, ok := targetLocal.(*net.TCPAddr); ok {
			destIP = addr.IP.String()
		}
	}
	family := "TCP4"
	if ip := net.ParseIP(sourceIP); ip != nil && ip.To4() == nil {
		family = "TCP6"
	}
	if sourceIP == "" || destIP == "" || sourcePort <= 0 || destPort <= 0 {
		return "PROXY UNKNOWN\r\n"
	}
	return fmt.Sprintf("PROXY %s %s %s %d %d\r\n", family, sourceIP, destIP, sourcePort, destPort)
}

func detectBlockedProtocol(data []byte, policy protocolPolicy) string {
	if len(data) == 0 {
		return ""
	}
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
	if bytes.HasPrefix(data, []byte("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n")) {
		return true
	}
	limit := minInt(len(data), 256)
	if limit < 8 {
		return false
	}
	lineEnd := bytes.IndexByte(data[:limit], '\n')
	if lineEnd < 0 {
		return false
	}
	line := strings.TrimSuffix(string(data[:lineEnd]), "\r")
	parts := strings.Fields(line)
	if len(parts) != 3 {
		return false
	}
	switch strings.ToUpper(parts[0]) {
	case "GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH", "CONNECT", "TRACE":
	default:
		return false
	}
	return parts[2] == "HTTP/1.0" || parts[2] == "HTTP/1.1"
}

func detectTLSProtocol(data []byte) bool {
	if len(data) < 9 {
		return false
	}
	if data[0] != 0x16 || data[1] != 0x03 || data[2] < 0x01 || data[2] > 0x04 {
		return false
	}
	recordLen := int(binary.BigEndian.Uint16(data[3:5]))
	if recordLen < protocolGuardTLSMinRecordSize || recordLen > 18432 {
		return false
	}
	if data[5] != 0x01 {
		return false
	}
	handshakeLen := int(data[6])<<16 | int(data[7])<<8 | int(data[8])
	if handshakeLen <= 0 || handshakeLen+4 > recordLen {
		return false
	}
	return true
}

func detectSocksProtocol(data []byte) bool {
	if len(data) < 2 {
		return false
	}
	if data[0] == 0x04 {
		if len(data) < 9 || (data[1] != 0x01 && data[1] != 0x02) {
			return false
		}
		return bytes.IndexByte(data[8:], 0x00) >= 0
	}
	if data[0] != 0x05 {
		return false
	}
	nMethods := int(data[1])
	if nMethods <= 0 || nMethods > protocolGuardSOCKS5MaxMethods || len(data) < 2+nMethods {
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
	startedAt := time.Now()
	env, err := encrypt(map[string]any{
		"path":    path,
		"payload": payload,
	}, cfg.Token)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(env)
	panelURL := currentPanelURL(cfg)
	req, err := http.NewRequest("POST", panelURL+"/api/sync", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 60 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		if shouldLogAgentReport("post-error:"+path, agentReportLogInterval) {
			logf("agent request failed path=%s duration=%s error=%v", path, time.Since(startedAt).Round(time.Millisecond), err)
		}
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
	if err := json.Unmarshal(decodedBody, out); err != nil {
		return err
	}
	if elapsed := time.Since(startedAt); elapsed >= agentSlowRequestThreshold && shouldLogAgentReport("post-slow:"+path, agentReportLogInterval) {
		logf("agent request slow path=%s duration=%s status=%d", path, elapsed.Round(time.Millisecond), res.StatusCode)
	}
	return nil
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
	logVerbosef("exec: %s", cmd)
	ctx, cancel := context.WithTimeout(context.Background(), actionShellTimeout)
	defer cancel()
	c := exec.CommandContext(ctx, "sh", "-lc", cmd)
	out, err := c.CombinedOutput()
	if len(out) > 0 && (err != nil || ctx.Err() == context.DeadlineExceeded || agentVerboseLogs) {
		logf("%s", strings.TrimSpace(string(out)))
	}
	if ctx.Err() == context.DeadlineExceeded {
		logf("exec failed: command timeout after %s", actionShellTimeout)
		return false
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
	publicIPMu.Lock()
	if !publicIPCheckedAt.IsZero() && time.Since(publicIPCheckedAt) < publicIPRefreshInterval {
		ipv4, ipv6 := publicIPv4Cache, publicIPv6Cache
		publicIPMu.Unlock()
		return ipv4, ipv6
	}
	publicIPMu.Unlock()

	ipv4 := fetchPublicIP([]string{
		"https://api.ipify.org",
		"https://ipv4.icanhazip.com",
		"https://v4.ident.me",
	})
	ipv6 := localPublicIPv6()
	if ipv6 == "" {
		ipv6 = fetchPublicIP([]string{
			"https://api6.ipify.org",
			"https://ipv6.icanhazip.com",
			"https://v6.ident.me",
		})
	}
	publicIPMu.Lock()
	if ipv4 != "" || ipv6 != "" {
		publicIPv4Cache = ipv4
		publicIPv6Cache = ipv6
	} else {
		ipv4, ipv6 = publicIPv4Cache, publicIPv6Cache
	}
	publicIPCheckedAt = time.Now()
	publicIPMu.Unlock()
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

func localPublicIPv6() string {
	if ip := localPublicIPv6FromIPCommand(); ip != "" {
		return ip
	}
	return localPublicIPv6FromInterfaces()
}

func localPublicIPv6FromIPCommand() string {
	out, err := exec.Command("ip", "-o", "-6", "addr", "show", "scope", "global").Output()
	if err != nil {
		return ""
	}
	type candidate struct {
		ip    string
		score int
	}
	candidates := []candidate{}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		for i, field := range fields {
			if field != "inet6" || i+1 >= len(fields) {
				continue
			}
			ip := publicIPv6Literal(strings.Split(fields[i+1], "/")[0])
			if ip == "" {
				continue
			}
			flags := strings.ToLower(strings.Join(fields[i+2:], " "))
			if strings.Contains(flags, "tentative") || strings.Contains(flags, "dadfailed") {
				continue
			}
			score := 100
			if strings.Contains(flags, "deprecated") {
				score -= 40
			}
			if strings.Contains(flags, "temporary") {
				score -= 20
			}
			candidates = append(candidates, candidate{ip: ip, score: score})
			break
		}
	}
	if len(candidates) == 0 {
		return ""
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		return candidates[i].score > candidates[j].score
	})
	return candidates[0].ip
}

func localPublicIPv6FromInterfaces() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			var ip net.IP
			switch value := addr.(type) {
			case *net.IPNet:
				ip = value.IP
			case *net.IPAddr:
				ip = value.IP
			}
			if ip := publicIPv6Literal(ip.String()); ip != "" {
				return ip
			}
		}
	}
	return ""
}

func publicIPv6Literal(value string) string {
	ip := net.ParseIP(strings.Trim(strings.TrimSpace(value), "[]"))
	if ip == nil || ip.To4() != nil || !ip.IsGlobalUnicast() || isUniqueLocalIPv6(ip) {
		return ""
	}
	return ip.String()
}

func isUniqueLocalIPv6(ip net.IP) bool {
	ip = ip.To16()
	return ip != nil && ip[0]&0xfe == 0xfc
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

func memTotalFrom(m map[string]uint64) uint64 { return m["MemTotal"] }

func memUsedFrom(m map[string]uint64) uint64 {
	total := m["MemTotal"]
	available := m["MemAvailable"]
	if total <= available {
		return 0
	}
	return total - available
}

func swapTotalFrom(m map[string]uint64) uint64 { return m["SwapTotal"] }

func swapUsedFrom(m map[string]uint64) uint64 {
	total := m["SwapTotal"]
	free := m["SwapFree"]
	if total <= free {
		return 0
	}
	return total - free
}

func usagePercent(used, total uint64) int {
	if total == 0 {
		return 0
	}
	return int(used * 100 / total)
}

func memTotal() uint64 { return memTotalFrom(readMeminfo()) }
func memUsed() uint64 {
	return memUsedFrom(readMeminfo())
}
func memUsagePercent() int {
	return usagePercent(memUsed(), memTotal())
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

func shouldLogAgentReport(key string, interval time.Duration) bool {
	now := time.Now()
	agentReportLogMu.Lock()
	defer agentReportLogMu.Unlock()
	last := agentReportLogAt[key]
	if !last.IsZero() && now.Sub(last) < interval {
		return false
	}
	agentReportLogAt[key] = now
	return true
}

func isEnvTruthy(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func logVerbosef(format string, args ...any) {
	if agentVerboseLogs {
		logf(format, args...)
	}
}

func logf(format string, args ...any) {
	message := fmt.Sprintf(format, args...)
	createdAt := time.Now().Format(time.RFC3339)
	line := createdAt + " " + message + "\n"
	fmt.Print(line)
	_ = os.MkdirAll(agentLogDir, 0755)
	agentLogMu.Lock()
	defer agentLogMu.Unlock()
	f, err := os.OpenFile(agentLogPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err == nil {
		_, _ = f.WriteString(line)
		_ = f.Close()
	}
	pruneAgentLocalLogsLocked()
}

func pruneAgentLocalLogsLocked() {
	if time.Since(agentLogPrunedAt) < time.Hour {
		return
	}
	agentLogPrunedAt = time.Now()
	paths, err := filepath.Glob(filepath.Join(agentLogDir, "*.log"))
	if err != nil || len(paths) == 0 {
		paths = []string{agentLogPath}
	}
	for _, path := range paths {
		pruneAgentLocalLogFile(path)
	}
}

func pruneAgentLocalLogFile(path string) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-agentLogRetention)
	lines := strings.Split(string(raw), "\n")
	retained := make([]string, 0, len(lines))
	changed := false
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.SplitN(line, " ", 2)
		t, err := time.Parse(time.RFC3339, parts[0])
		if err != nil {
			retained = append(retained, line)
			continue
		}
		if t.After(cutoff) {
			retained = append(retained, line)
			continue
		}
		changed = true
	}
	if !changed {
		return
	}
	if len(retained) == 0 {
		_ = os.WriteFile(path, nil, 0644)
		return
	}
	_ = os.WriteFile(path, []byte(strings.Join(retained, "\n")+"\n"), 0644)
}

func fatal(format string, args ...any) {
	logf(format, args...)
	os.Exit(1)
}
