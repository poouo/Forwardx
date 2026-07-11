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
	"crypto/tls"
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

var Version = "2.2.148"

const selfUpgradeLockTimeout = 10 * time.Minute
const iperf3IdleTimeout = 3 * time.Minute
const selfTestIdlePollInterval = 10 * time.Second
const selfTestActivePollInterval = 2 * time.Second
const selfTestActiveWindow = 2 * time.Minute
const agentClockSyncCooldown = 10 * time.Minute
const publicIPRefreshInterval = time.Minute
const heartbeatStaticReportInterval = 10 * time.Minute
const trafficCollectInterval = 3 * time.Second
const trafficCollectMaxInterval = 30 * time.Second
const countingChainRefreshInterval = 6 * time.Hour
const runtimeActionRefreshInterval = 30 * time.Minute
const agentLogRetention = 72 * time.Hour
const agentLogMaxBytes int64 = 8 * 1024 * 1024
const agentLogTailBytes int64 = 4 * 1024 * 1024
const agentMemoryCacheRetention = 24 * time.Hour
const agentReportLogMaxKeys = 2048
const agentSlowRequestThreshold = 1500 * time.Millisecond
const agentReportLogInterval = 30 * time.Second
const transientAgentCommLogInterval = 5 * time.Minute
const agentEventStreamReconnectMinDelay = 3 * time.Second
const agentEventStreamReconnectMaxDelay = 30 * time.Second
const actionBacklogKeepaliveInterval = 10 * time.Second
const actionQueueCapacity = 4096

// 动作 worker 从基础并发起步，积压时自动扩容到上限。空闲 worker 只阻塞等待队列，
// 不消耗 CPU；状态上报由独立批处理器完成，因此 worker 只负责实际转发动作。
var actionWorkerBaseConcurrency = resolveActionWorkerBaseConcurrency()
var actionWorkerConcurrency = resolveActionWorkerMaxConcurrency()
var actionWorkerStartedCount int64

func resolveActionWorkerBaseConcurrency() int {
	cores := runtime.NumCPU()
	workers := cores * 2
	if workers < 8 {
		workers = 8
	}
	if workers > 16 {
		workers = 16
	}
	return workers
}

func resolveActionWorkerMaxConcurrency() int {
	workers := runtime.NumCPU() * 8
	if workers < 16 {
		workers = 16
	}
	if workers > 64 {
		workers = 64
	}
	if workers < actionWorkerBaseConcurrency {
		workers = actionWorkerBaseConcurrency
	}
	return workers
}

const actionQueueBacklogLogThreshold = 50
const actionQueueSlowWaitThreshold = 3 * time.Second
const actionSlowHandleThreshold = 15 * time.Second
const actionShellTimeout = 90 * time.Second
const actionShellSlowThreshold = 5 * time.Second
const shellInlineMaxBytes = 8 * 1024
const protocolGuardSampleMinBytes = 96
const protocolGuardSampleMaxBytes = 512
const protocolGuardSampleTimeout = 750 * time.Millisecond
const protocolGuardConfirmations = 3
const protocolGuardWindowStep = 64
const protocolGuardTLSMinRecordSize = 64
const protocolGuardSOCKS5MaxMethods = 16
const protocolGuardUDPIdleTimeout = 2 * time.Minute
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
const mimicConfigDir = "/etc/mimic"
const legacyGostServiceName = "forwardx-gost"
const legacyTunnelServiceName = "forwardx-tunnels"
const legacyGostConfigPath = "/etc/forwardx-gost/config.json"
const legacyTunnelConfigPath = "/etc/forwardx-tunnels/config.json"
const legacyRuntimeConfigPath = "/etc/forwardx-runtime/config.json"
const legacyTunnelRuntimeConfigPath = "/etc/forwardx-tunnel-runtime/config.json"
const desiredStateRecordPath = "/var/lib/forwardx-agent/desired_state_records.json"
const desiredStateVersionPath = "/var/lib/forwardx-agent/desired_state_agent_version"

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
var actionQueue = make(chan actionJob, actionQueueCapacity)
var actionEpochMu sync.Mutex
var latestActionIssuedAt = map[string]int64{}
var desiredRunningRuleMu sync.Mutex
var desiredRunningRulesByPort = map[string]runningRule{}
var desiredRunningRulesByRulePort = map[string]runningRule{}
var iperf3Mu sync.Mutex
var iperf3Server *iperf3Process
var dnsWatchMu sync.Mutex
var dnsWatchSnapshot = map[string][]string{}
var dnsWatchCandidates = map[string]dnsWatchCandidate{}
var dnsWatchRetiredSnapshots = map[string]dnsWatchRetiredSnapshot{}
var pendingDNSChanges []dnsChangeReport
var publicIPMu sync.Mutex
var publicIPv4Cache string
var publicIPv6Cache string
var publicIPCheckedAt time.Time
var lastTrafficCollectAt time.Time
var nextTrafficCollectInterval = trafficCollectInterval
var cpuUsageMu sync.Mutex
var previousCPUTimes cpuTimes
var previousCPUReady bool
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
var agentMemoryPrunedAt time.Time
var actionPendingCount int64
var heartbeatWakeCh = make(chan struct{}, 1)
var heartbeatWakeFromSSE atomic.Bool // SSE 唤醒时置 true；主循环读取后清零
var agentVerboseLogs = isEnvTruthy(os.Getenv(agentVerboseEnv))
var queuedActionMu sync.Mutex
var queuedActionKeys = map[string]int64{}
var protectedActionPortMu sync.Mutex
var protectedActionPorts = map[string]int{}
var compactAgentReports atomic.Bool
var heartbeatStaticReport heartbeatStaticSnapshot
var heartbeatStateMu sync.Mutex
var heartbeatStateCache heartbeatStateSnapshot
var heartbeatStateSignatures = map[string]string{}
var localRuntimeStateMu sync.Mutex
var lastLocalRuntimeStateSignature string
var forceSendLocalRuntimeState = true

// readLocalRuntimeReadiness 的跨心跳缓存。
// TTL 5s：正常心跳间隔 30s，对数据新鲜度无影响；
// 在 SSE 唤醒风暴（churn）期间可消除重复的 ss/systemctl 调用。
const localRuntimeReadinessCacheTTL = 5 * time.Second

var localRuntimeReadinessCacheMu sync.Mutex
var localRuntimeReadinessCacheResult *localRuntimeReadiness
var localRuntimeReadinessCachedAt time.Time
var localRuntimeReadinessCacheInvalid bool

type actionJob struct {
	cfg              Config
	action           action
	done             chan struct{}
	desiredKey       string
	desiredSignature string
	enqueuedAt       time.Time
	protectedPort    string
}

type heartbeatStaticSnapshot struct {
	PrimaryIP               string
	IPv4                    string
	IPv6                    string
	DefaultNetworkInterface string
	CPUInfo                 string
	MemoryTotal             uint64
	SwapTotal               uint64
	DiskTotal               uint64
	Version                 string
	ReportedAt              time.Time
	Initialized             bool
}

type runtimeActionState struct {
	Signature string
	CheckedAt time.Time
	Success   bool
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

type panelErrorResp struct {
	Error   string `json:"error"`
	Message string `json:"message"`
	Hint    string `json:"hint"`
}

type heartbeatResp struct {
	Actions            []action                `json:"actions"`
	DesiredState       *desiredState           `json:"desiredState,omitempty"`
	SelfTests          []selfTest              `json:"selfTests"`
	RunningRules       []runningRule           `json:"runningRules"`
	TunnelProbes       []tunnelProbe           `json:"tunnelProbes"`
	ForwardGroupProbes []forwardGroupProbe     `json:"forwardGroupProbes"`
	HostProbeServices  []hostProbeServiceProbe `json:"hostProbeServices"`
	GuardRules         []guardRule             `json:"guardRules"`
	DNSWatch           []dnsWatchItem          `json:"dnsWatch"`
	LookingGlassTests  []lookingGlassTask      `json:"lookingGlassTests"`
	Iperf3Tasks        []iperf3Task            `json:"iperf3Tasks"`
	PluginTasks        []pluginAgentTask       `json:"pluginTasks"`
	AgentUpgrade       *agentUpgrade           `json:"agentUpgrade"`
	StateSignatures    map[string]string       `json:"stateSignatures,omitempty"`
	RequestLocalState  bool                    `json:"requestLocalState,omitempty"`
	PanelURL           string                  `json:"panelUrl"`
	ForceTCPing        bool                    `json:"forceTcping"`
	NextInterval       int                     `json:"nextInterval"`
	CompactReports     bool                    `json:"compactReports"`
}

type heartbeatStateSnapshot struct {
	RunningRules       []runningRule
	TunnelProbes       []tunnelProbe
	ForwardGroupProbes []forwardGroupProbe
	HostProbeServices  []hostProbeServiceProbe
	GuardRules         []guardRule
	DNSWatch           []dnsWatchItem
}

type localRuntimeStatePayload struct {
	Rules    []localRuntimeRuleState    `json:"rules,omitempty"`
	Tunnels  []localRuntimeTunnelState  `json:"tunnels,omitempty"`
	Services []localRuntimeServiceState `json:"services,omitempty"`
}

type localRuntimeRuleState struct {
	Port        int    `json:"port"`
	RuleID      int    `json:"ruleId"`
	TunnelID    int    `json:"tunnelId,omitempty"`
	ForwardType string `json:"forwardType"`
	TargetIP    string `json:"targetIp,omitempty"`
	TargetPort  int    `json:"targetPort,omitempty"`
	Protocol    string `json:"protocol,omitempty"`
	Ready       bool   `json:"ready"`
}

type localRuntimeTunnelState struct {
	Port        int    `json:"port"`
	TunnelID    int    `json:"tunnelId"`
	ForwardType string `json:"forwardType"`
	Ready       bool   `json:"ready"`
}

type localRuntimeServiceState struct {
	Name    string `json:"name"`
	Active  bool   `json:"active"`
	HasWork bool   `json:"hasWork"`
}

type localRuntimeReadiness struct {
	runtimePorts               map[int]bool
	gostRuntimePorts           map[int]bool
	tunnelRuntimePorts         map[int]bool
	nginxRuntimePorts          map[int]bool
	gostRuntimePortProtocols   map[int]map[string]bool
	tunnelRuntimePortProtocols map[int]map[string]bool
	nginxRuntimePortProtocols  map[int]map[string]bool
	gostRuntimeReady           bool
	tunnelRuntimeReady         bool
	nginxRuntimeReady          bool
	sharedRuntimeReady         bool
	serviceStates              []localRuntimeServiceState
	serviceActiveCache         map[string]bool
	kernelSnapshot             *kernelForwardSnapshot
	listenSnapshot             *runtimeListenSnapshot
}

func heartbeatStateSignaturePayload() map[string]string {
	heartbeatStateMu.Lock()
	defer heartbeatStateMu.Unlock()
	if len(heartbeatStateSignatures) == 0 {
		return nil
	}
	out := make(map[string]string, len(heartbeatStateSignatures))
	for key, value := range heartbeatStateSignatures {
		if strings.TrimSpace(value) != "" {
			out[key] = value
		}
	}
	return out
}

func applyHeartbeatState(resp heartbeatResp) heartbeatStateSnapshot {
	heartbeatStateMu.Lock()
	defer heartbeatStateMu.Unlock()
	if resp.RunningRules != nil {
		heartbeatStateCache.RunningRules = append([]runningRule(nil), resp.RunningRules...)
	}
	if resp.TunnelProbes != nil {
		heartbeatStateCache.TunnelProbes = append([]tunnelProbe(nil), resp.TunnelProbes...)
	}
	if resp.ForwardGroupProbes != nil {
		heartbeatStateCache.ForwardGroupProbes = append([]forwardGroupProbe(nil), resp.ForwardGroupProbes...)
	}
	if resp.HostProbeServices != nil {
		heartbeatStateCache.HostProbeServices = append([]hostProbeServiceProbe(nil), resp.HostProbeServices...)
	}
	if resp.GuardRules != nil {
		heartbeatStateCache.GuardRules = append([]guardRule(nil), resp.GuardRules...)
	}
	if resp.DNSWatch != nil {
		heartbeatStateCache.DNSWatch = append([]dnsWatchItem(nil), resp.DNSWatch...)
	}
	if len(resp.StateSignatures) > 0 {
		for key, value := range resp.StateSignatures {
			if strings.TrimSpace(value) != "" {
				heartbeatStateSignatures[key] = value
			}
		}
	}
	return heartbeatStateSnapshot{
		RunningRules:       append([]runningRule(nil), heartbeatStateCache.RunningRules...),
		TunnelProbes:       append([]tunnelProbe(nil), heartbeatStateCache.TunnelProbes...),
		ForwardGroupProbes: append([]forwardGroupProbe(nil), heartbeatStateCache.ForwardGroupProbes...),
		HostProbeServices:  append([]hostProbeServiceProbe(nil), heartbeatStateCache.HostProbeServices...),
		GuardRules:         append([]guardRule(nil), heartbeatStateCache.GuardRules...),
		DNSWatch:           append([]dnsWatchItem(nil), heartbeatStateCache.DNSWatch...),
	}
}

func readLocalRuntimeReadiness() localRuntimeReadiness {
	readiness := localRuntimeReadiness{
		runtimePorts:               map[int]bool{},
		gostRuntimePorts:           map[int]bool{},
		tunnelRuntimePorts:         map[int]bool{},
		nginxRuntimePorts:          map[int]bool{},
		gostRuntimePortProtocols:   map[int]map[string]bool{},
		tunnelRuntimePortProtocols: map[int]map[string]bool{},
		nginxRuntimePortProtocols:  map[int]map[string]bool{},
		gostRuntimeReady:           true,
		tunnelRuntimeReady:         true,
		nginxRuntimeReady:          true,
		sharedRuntimeReady:         true,
		serviceActiveCache:         map[string]bool{},
		kernelSnapshot:             newKernelForwardSnapshot(),
		listenSnapshot:             newRuntimeListenSnapshot(),
	}
	configs := []struct {
		path    string
		service string
		kind    string
	}{
		{runtimeConfigPath, runtimeServiceName, "gost"},
		{tunnelRuntimeConfigPath, tunnelRuntimeServiceName, "tunnel-gost"},
		{nginxConfigPath, nginxServiceName, "nginx"},
	}
	for _, cfg := range configs {
		var listens []runtimeListenConfig
		var ok bool
		if cfg.kind == "nginx" {
			listens, ok = nginxRuntimeListenConfigs(cfg.path)
		} else {
			listens, ok = readGostRuntimeServiceListens(cfg.path)
		}
		hasWork := ok && len(listens) > 0
		for _, listen := range listens {
			if port := addrPort(listen.Addr); port > 0 {
				readiness.runtimePorts[port] = true
				protocol := normalizeRuntimeProtocol(listen.Protocol)
				switch cfg.kind {
				case "nginx":
					readiness.nginxRuntimePorts[port] = true
					addRuntimePortProtocol(readiness.nginxRuntimePortProtocols, port, protocol)
				case "tunnel-gost":
					readiness.tunnelRuntimePorts[port] = true
					addRuntimePortProtocol(readiness.tunnelRuntimePortProtocols, port, protocol)
				default:
					readiness.gostRuntimePorts[port] = true
					addRuntimePortProtocol(readiness.gostRuntimePortProtocols, port, protocol)
				}
			}
		}
		active := false
		if hasWork {
			active = managedServiceActive(cfg.service)
		}
		readiness.serviceActiveCache[cfg.service] = active
		if hasWork && !active {
			readiness.sharedRuntimeReady = false
			switch cfg.kind {
			case "nginx":
				readiness.nginxRuntimeReady = false
			case "tunnel-gost":
				readiness.tunnelRuntimeReady = false
			default:
				readiness.gostRuntimeReady = false
			}
		}
		readiness.serviceStates = append(readiness.serviceStates, localRuntimeServiceState{
			Name:    cfg.service,
			Active:  active,
			HasWork: hasWork,
		})
	}
	for _, service := range managedMimicServicesFromLocalConfig() {
		active := mimicRuntimeServiceHealthy(service)
		readiness.serviceActiveCache[service] = active
		readiness.serviceStates = append(readiness.serviceStates, localRuntimeServiceState{
			Name:    service,
			Active:  active,
			HasWork: true,
		})
	}
	return readiness
}

// readLocalRuntimeReadinessCached 返回带 TTL 缓存的 readLocalRuntimeReadiness 结果。
// 相同 TTL 窗口内多次调用（SSE 唤醒风暴、primeDesiredRuntimeReadyCacheForActions）
// 只产生一次 ss/systemctl/config 读取。
// 调用 invalidateLocalRuntimeReadinessCache() 可提前失效（如 action 执行完毕后）。
func readLocalRuntimeReadinessCached() localRuntimeReadiness {
	localRuntimeReadinessCacheMu.Lock()
	defer localRuntimeReadinessCacheMu.Unlock()
	if !localRuntimeReadinessCacheInvalid &&
		localRuntimeReadinessCacheResult != nil &&
		time.Since(localRuntimeReadinessCachedAt) < localRuntimeReadinessCacheTTL {
		return *localRuntimeReadinessCacheResult
	}
	r := readLocalRuntimeReadiness()
	localRuntimeReadinessCacheResult = &r
	localRuntimeReadinessCachedAt = time.Now()
	localRuntimeReadinessCacheInvalid = false
	return r
}

func invalidateLocalRuntimeReadinessCache() {
	localRuntimeReadinessCacheMu.Lock()
	localRuntimeReadinessCacheInvalid = true
	localRuntimeReadinessCacheMu.Unlock()
}

func (r *localRuntimeReadiness) managedServiceActiveCached(name string) bool {
	name = sanitizeServiceName(name)
	if name == "" {
		return false
	}
	if r.serviceActiveCache == nil {
		r.serviceActiveCache = map[string]bool{}
	}
	if active, ok := r.serviceActiveCache[name]; ok {
		return active
	}
	active := managedServiceActive(name)
	r.serviceActiveCache[name] = active
	return active
}

func addRuntimePortProtocol(ports map[int]map[string]bool, port int, protocol string) {
	if ports == nil || port <= 0 {
		return
	}
	protocol = normalizeRuntimeProtocol(protocol)
	if ports[port] == nil {
		ports[port] = map[string]bool{}
	}
	for _, proto := range runtimeProtocols(protocol) {
		ports[port][proto] = true
	}
}

func runtimePortProtocolConfigured(ports map[int]map[string]bool, port int, protocol string) bool {
	if ports == nil || port <= 0 {
		return false
	}
	configured := ports[port]
	if len(configured) == 0 {
		return false
	}
	for _, proto := range runtimeProtocols(protocol) {
		if !configured[proto] && !configured["both"] {
			return false
		}
	}
	return true
}

func (r *localRuntimeReadiness) gostReadyForPort(port int, protocol string) bool {
	if r == nil || port <= 0 {
		return false
	}
	// runtimeServiceName ("forwardx-runtime") is the actual binary; Linux ss(8)
	// truncates comm to 15 chars so it appears as "forwardx-runtim" in ss output.
	// Keep "gost" for environments that still run the upstream gost binary directly.
	runtimeNeedles := []string{"gost", "forwardx-runt"}
	return (r.gostRuntimeReady &&
		r.gostRuntimePorts[port] &&
		runtimePortProtocolConfigured(r.gostRuntimePortProtocols, port, protocol) &&
		runtimeListenPortReady(r.listenSnapshot, port, protocol, runtimeNeedles)) ||
		(r.tunnelRuntimeReady &&
			r.tunnelRuntimePorts[port] &&
			runtimePortProtocolConfigured(r.tunnelRuntimePortProtocols, port, protocol) &&
			runtimeListenPortReady(r.listenSnapshot, port, protocol, runtimeNeedles))
}

func (r *localRuntimeReadiness) nginxReadyForPort(port int, protocol string) bool {
	if r == nil || port <= 0 {
		return false
	}
	return r.nginxRuntimeReady &&
		r.nginxRuntimePorts[port] &&
		runtimePortProtocolConfigured(r.nginxRuntimePortProtocols, port, protocol) &&
		runtimeListenPortReady(r.listenSnapshot, port, protocol, []string{"nginx"})
}

func addrPort(addr string) int {
	text := strings.TrimSpace(addr)
	if text == "" {
		return 0
	}
	if idx := strings.LastIndex(text, "://"); idx >= 0 {
		text = text[idx+3:]
	}
	_, rawPort, err := net.SplitHostPort(text)
	if err != nil {
		idx := strings.LastIndex(text, ":")
		if idx < 0 || idx >= len(text)-1 {
			return 0
		}
		rawPort = text[idx+1:]
	}
	port, err := strconv.Atoi(strings.Trim(strings.TrimSpace(rawPort), "[]"))
	if err != nil || port <= 0 || port > 65535 {
		return 0
	}
	return port
}

func localRuleStateReady(state localRuleState, readiness *localRuntimeReadiness) bool {
	port := atoi(state.Port)
	if port <= 0 || readiness == nil {
		return false
	}
	forwardType := strings.TrimSpace(state.ForwardType)
	switch forwardType {
	case "realm":
		return readiness.managedServiceActiveCached("forwardx-realm-" + state.Port)
	case "socat":
		if normalizeRuntimeProtocol(state.Protocol) == "both" {
			return readiness.managedServiceActiveCached("forwardx-socat-tcp-"+state.Port) &&
				readiness.managedServiceActiveCached("forwardx-socat-udp-"+state.Port)
		}
		return readiness.managedServiceActiveCached("forwardx-socat-" + state.Port)
	case "iptables":
		return readiness.kernelSnapshot != nil && readiness.kernelSnapshot.localRuleStateReady(state)
	case "nftables":
		return readiness.kernelSnapshot != nil && readiness.kernelSnapshot.localRuleStateReady(state)
	case "gost", "gost-tunnel", "gost-tunnel-exit", "gost-tunnel-hop":
		return readiness.gostReadyForPort(port, state.Protocol)
	case "nginx", "nginx-tunnel", "nginx-tunnel-exit":
		return readiness.nginxReadyForPort(port, state.Protocol)
	case "forwardx":
		return fxpRuntimeProcessExistsForRulePort(state.RuleID, port)
	default:
		return true
	}
}

func localTunnelStateReady(tunnelID int, port int, forwardType string, readiness *localRuntimeReadiness) bool {
	if tunnelID <= 0 || port <= 0 || readiness == nil {
		return false
	}
	switch strings.TrimSpace(forwardType) {
	case "gost-tunnel":
		return readiness.gostReadyForPort(port, "tcp")
	case "nginx-tunnel", "nginx-tunnel-exit":
		return readiness.nginxReadyForPort(port, "tcp")
	case "forwardx-tunnel":
		return fxpRuntimeProcessExistsForTunnelPort(tunnelID, port)
	default:
		return true
	}
}

type kernelForwardSnapshot struct {
	nftLoaded       bool
	nftTable        string
	iptablesLoaded  map[string]bool
	iptablesNatRule map[string]string
}

func newKernelForwardSnapshot() *kernelForwardSnapshot {
	return &kernelForwardSnapshot{
		iptablesLoaded:  map[string]bool{},
		iptablesNatRule: map[string]string{},
	}
}

func actionRequiresKernelForwardConsistency(a action) bool {
	if a.SourcePort <= 0 || strings.TrimSpace(a.StatusType) == "runtime" || strings.TrimSpace(a.StatusType) == "tunnel" {
		return false
	}
	switch strings.TrimSpace(a.ForwardType) {
	case "iptables", "nftables":
		return true
	default:
		return false
	}
}

func (s *kernelForwardSnapshot) desiredActionConsistent(a action) bool {
	if !actionRequiresKernelForwardConsistency(a) {
		return true
	}
	switch strings.TrimSpace(a.Op) {
	case "apply":
		return s.actionApplyReady(a)
	case "remove":
		return s.actionRemoveDone(a)
	default:
		return true
	}
}

func (s *kernelForwardSnapshot) actionApplyReady(a action) bool {
	return s.kernelRuleApplyPresent(a.ForwardType, a.RuleID, a.SourcePort, a.TargetIP, a.TargetPort, a.Protocol)
}

func (s *kernelForwardSnapshot) actionRemoveDone(a action) bool {
	return !s.kernelRuleResiduePresent(a.ForwardType, a.RuleID, a.SourcePort, a.Protocol)
}

func (s *kernelForwardSnapshot) localRuleStateReady(state localRuleState) bool {
	return s.kernelRuleApplyPresent(state.ForwardType, state.RuleID, atoi(state.Port), state.TargetIP, state.TargetPort, state.Protocol)
}

func readLocalRuntimeRuleStates() []localRuleState {
	states := readLocalRuleStates()
	return appendKernelForwardResidueStates(states)
}

type kernelForwardResidueState struct {
	state localRuleState
	tcp   bool
	udp   bool
}

func appendKernelForwardResidueStates(states []localRuleState) []localRuleState {
	existingPorts := map[string]bool{}
	for _, state := range states {
		if strings.TrimSpace(state.Port) != "" {
			existingPorts[state.Port] = true
		}
	}
	residue := newKernelForwardSnapshot().localResidueStates(existingPorts)
	if len(residue) == 0 {
		return states
	}
	return append(states, residue...)
}

func (s *kernelForwardSnapshot) localResidueStates(existingPorts map[string]bool) []localRuleState {
	byPort := map[string]*kernelForwardResidueState{}
	add := func(forwardType string, ruleID int, port int, proto string, targetIP string, targetPort int) {
		if port <= 0 {
			return
		}
		portText := strconv.Itoa(port)
		if existingPorts != nil && existingPorts[portText] {
			return
		}
		item := byPort[portText]
		if item == nil {
			item = &kernelForwardResidueState{
				state: localRuleState{
					Port:        portText,
					RuleID:      ruleID,
					ForwardType: forwardType,
					TargetIP:    targetIP,
					TargetPort:  targetPort,
				},
			}
			byPort[portText] = item
		}
		if item.state.RuleID <= 0 && ruleID > 0 {
			item.state.RuleID = ruleID
		}
		if item.state.TargetIP == "" && targetIP != "" {
			item.state.TargetIP = targetIP
		}
		if item.state.TargetPort <= 0 && targetPort > 0 {
			item.state.TargetPort = targetPort
		}
		switch proto {
		case "udp":
			item.udp = true
		default:
			item.tcp = true
		}
	}
	for _, rawLine := range strings.Split(s.nftTableText(), "\n") {
		line := kernelNormalizeLine(rawLine)
		if line == "" || !strings.Contains(line, "dnat") {
			continue
		}
		proto, port, ok := kernelLineDport(line)
		if !ok {
			continue
		}
		ruleID := kernelLineRuleID(line)
		targetIP, targetPort, _ := kernelLineDnatTarget(line)
		add("nftables", ruleID, port, proto, targetIP, targetPort)
	}
	for _, binary := range iptablesAgentBinaries() {
		for _, rawLine := range strings.Split(s.iptablesNatPreroutingText(binary), "\n") {
			line := kernelNormalizeLine(rawLine)
			if line == "" || !strings.Contains(line, "-j DNAT") {
				continue
			}
			proto, port, ok := kernelLineDport(line)
			if !ok || !iptablesForwardxMarkerSeenForPort(port) {
				continue
			}
			targetIP, targetPort, _ := kernelLineDnatTarget(line)
			add("iptables", 0, port, proto, targetIP, targetPort)
		}
	}
	if len(byPort) == 0 {
		return nil
	}
	ports := make([]string, 0, len(byPort))
	for port := range byPort {
		ports = append(ports, port)
	}
	sort.Slice(ports, func(i, j int) bool { return atoi(ports[i]) < atoi(ports[j]) })
	out := make([]localRuleState, 0, len(ports))
	for _, port := range ports {
		item := byPort[port]
		if item.tcp && item.udp {
			item.state.Protocol = "both"
		} else if item.udp {
			item.state.Protocol = "udp"
		} else {
			item.state.Protocol = "tcp"
		}
		out = append(out, item.state)
	}
	return out
}

func (s *kernelForwardSnapshot) kernelRuleApplyPresent(forwardType string, ruleID int, sourcePort int, targetIP string, targetPort int, protocol string) bool {
	if sourcePort <= 0 {
		return false
	}
	switch strings.TrimSpace(forwardType) {
	case "nftables":
		return s.nftForwardRulePresent(ruleID, sourcePort, targetIP, targetPort, protocol)
	case "iptables":
		return s.iptablesForwardRulePresent(sourcePort, targetIP, targetPort, protocol)
	default:
		return true
	}
}

func (s *kernelForwardSnapshot) kernelRuleResiduePresent(forwardType string, ruleID int, sourcePort int, protocol string) bool {
	if sourcePort <= 0 {
		return false
	}
	switch strings.TrimSpace(forwardType) {
	case "nftables":
		return s.nftForwardRuleResiduePresent(ruleID, sourcePort, protocol)
	case "iptables":
		return s.iptablesForwardRuleResiduePresent(sourcePort, protocol)
	default:
		return false
	}
}

func (s *kernelForwardSnapshot) nftTableText() string {
	if s == nil {
		return ""
	}
	if s.nftLoaded {
		return s.nftTable
	}
	s.nftLoaded = true
	if !commandExists("nft") {
		return ""
	}
	raw, err := exec.Command("nft", "-a", "list", "table", "inet", "forwardx").Output()
	if err != nil {
		return ""
	}
	s.nftTable = string(raw)
	return s.nftTable
}

func (s *kernelForwardSnapshot) iptablesNatPreroutingText(binary string) string {
	if s == nil || strings.TrimSpace(binary) == "" {
		return ""
	}
	if s.iptablesLoaded == nil {
		s.iptablesLoaded = map[string]bool{}
	}
	if s.iptablesNatRule == nil {
		s.iptablesNatRule = map[string]string{}
	}
	if s.iptablesLoaded[binary] {
		return s.iptablesNatRule[binary]
	}
	s.iptablesLoaded[binary] = true
	if binary == "ip6tables" && !commandExists("ip6tables") {
		return ""
	}
	raw, err := exec.Command(binary, "-t", "nat", "-S", "PREROUTING").Output()
	if err != nil {
		return ""
	}
	s.iptablesNatRule[binary] = string(raw)
	return s.iptablesNatRule[binary]
}

func (s *kernelForwardSnapshot) nftForwardRulePresent(ruleID int, sourcePort int, targetIP string, targetPort int, protocol string) bool {
	text := s.nftTableText()
	if text == "" {
		return false
	}
	for _, proto := range runtimeProtocols(protocol) {
		if !nftDnatLinePresent(text, ruleID, proto, sourcePort, targetIP, targetPort) {
			return false
		}
	}
	return true
}

func (s *kernelForwardSnapshot) nftForwardRuleResiduePresent(ruleID int, sourcePort int, protocol string) bool {
	text := s.nftTableText()
	if text == "" {
		return false
	}
	marker := ""
	if ruleID > 0 {
		marker = "fwx-rule-" + strconv.Itoa(ruleID)
	}
	for _, rawLine := range strings.Split(text, "\n") {
		line := kernelNormalizeLine(rawLine)
		if line == "" {
			continue
		}
		if marker != "" && strings.Contains(line, marker) {
			return true
		}
		if strings.Contains(line, "dnat") {
			for _, proto := range runtimeProtocols(protocol) {
				if kernelLineHasProtoDport(line, proto, sourcePort) {
					return true
				}
			}
		}
	}
	return false
}

func nftDnatLinePresent(text string, ruleID int, proto string, sourcePort int, targetIP string, targetPort int) bool {
	marker := ""
	if ruleID > 0 {
		marker = "fwx-rule-" + strconv.Itoa(ruleID)
	}
	for _, rawLine := range strings.Split(text, "\n") {
		line := kernelNormalizeLine(rawLine)
		if line == "" || !strings.Contains(line, "dnat") || !kernelLineHasProtoDport(line, proto, sourcePort) {
			continue
		}
		if marker != "" && !strings.Contains(line, marker) && !kernelLineDnatTargetMatches(line, targetIP, targetPort) {
			continue
		}
		if !kernelLineDnatTargetMatches(line, targetIP, targetPort) {
			continue
		}
		return true
	}
	return false
}

func (s *kernelForwardSnapshot) iptablesForwardRulePresent(sourcePort int, targetIP string, targetPort int, protocol string) bool {
	target := kernelCleanAddress(targetIP)
	for _, proto := range runtimeProtocols(protocol) {
		if !iptablesDnatLinePresent(s.iptablesNatPreroutingText(iptablesAgentBinaryForTarget(target)), proto, sourcePort, target, targetPort) {
			return false
		}
	}
	return true
}

func (s *kernelForwardSnapshot) iptablesForwardRuleResiduePresent(sourcePort int, protocol string) bool {
	for _, binary := range iptablesAgentBinaries() {
		text := s.iptablesNatPreroutingText(binary)
		for _, rawLine := range strings.Split(text, "\n") {
			line := kernelNormalizeLine(rawLine)
			if line == "" || !strings.Contains(line, "-j DNAT") {
				continue
			}
			for _, proto := range runtimeProtocols(protocol) {
				if kernelLineHasProtoDport(line, proto, sourcePort) {
					return true
				}
			}
		}
	}
	return false
}

func iptablesDnatLinePresent(text string, proto string, sourcePort int, targetIP string, targetPort int) bool {
	for _, rawLine := range strings.Split(text, "\n") {
		line := kernelNormalizeLine(rawLine)
		if line == "" || !strings.Contains(line, "-j DNAT") || !kernelLineHasProtoDport(line, proto, sourcePort) {
			continue
		}
		if kernelLineDnatTargetMatches(line, targetIP, targetPort) {
			return true
		}
	}
	return false
}

func kernelNormalizeLine(line string) string {
	return strings.Join(strings.Fields(line), " ")
}

func kernelCleanAddress(value string) string {
	return strings.ToLower(strings.Trim(strings.TrimSpace(value), "[]"))
}

func kernelLineHasProtoDport(line string, proto string, port int) bool {
	if port <= 0 {
		return false
	}
	lineProto, linePort, ok := kernelLineDport(line)
	return ok && lineProto == strings.TrimSpace(proto) && linePort == port
}

func kernelLineDnatTargetMatches(line string, targetIP string, targetPort int) bool {
	target := kernelCleanAddress(targetIP)
	if target == "" || targetPort <= 0 || net.ParseIP(target) == nil {
		return true
	}
	lineTarget, linePort, ok := kernelLineDnatTarget(strings.ToLower(line))
	if ok == false {
		return false
	}
	return kernelCleanAddress(lineTarget) == target && linePort == targetPort
}

func kernelLineDport(line string) (string, int, bool) {
	for _, proto := range []string{"tcp", "udp"} {
		prefixes := []string{"--dport ", proto + " dport "}
		if !strings.Contains(line, "-p "+proto+" ") && !strings.Contains(line, "meta l4proto "+proto) && !strings.Contains(line, proto+" dport ") {
			continue
		}
		for _, prefix := range prefixes {
			idx := strings.Index(line, prefix)
			if idx < 0 {
				continue
			}
			rest := strings.TrimSpace(line[idx+len(prefix):])
			if rest == "" {
				continue
			}
			fields := strings.Fields(rest)
			if len(fields) == 0 {
				continue
			}
			portText := strings.Trim(fields[0], "[];,")
			port, err := strconv.Atoi(portText)
			if err == nil && port > 0 && port <= 65535 {
				return proto, port, true
			}
		}
	}
	return "", 0, false
}

func kernelLineRuleID(line string) int {
	match := regexp.MustCompile(`fwx-rule-([0-9]+)`).FindStringSubmatch(line)
	if len(match) < 2 {
		return 0
	}
	id, _ := strconv.Atoi(match[1])
	return id
}

func kernelLineDnatTarget(line string) (string, int, bool) {
	tail := line
	if idx := strings.Index(tail, "--to-destination "); idx >= 0 {
		tail = tail[idx+len("--to-destination "):]
	} else if idx := strings.Index(tail, " to "); idx >= 0 {
		tail = tail[idx+len(" to "):]
	} else {
		return "", 0, false
	}
	fields := strings.Fields(tail)
	if len(fields) == 0 {
		return "", 0, false
	}
	token := strings.Trim(fields[0], "\"'`;")
	if strings.HasPrefix(token, "[") {
		if end := strings.Index(token, "]"); end > 0 && len(token) > end+2 && token[end+1] == ':' {
			port, err := strconv.Atoi(strings.Trim(token[end+2:], "[];,"))
			if err == nil && port > 0 {
				return strings.Trim(token[1:end], "[]"), port, true
			}
		}
	}
	idx := strings.LastIndex(token, ":")
	if idx <= 0 || idx >= len(token)-1 {
		return strings.Trim(token, "[]"), 0, false
	}
	port, err := strconv.Atoi(strings.Trim(token[idx+1:], "[];,"))
	if err != nil || port <= 0 {
		return strings.Trim(token, "[]"), 0, false
	}
	return strings.Trim(token[:idx], "[]"), port, true
}

func iptablesForwardxMarkerSeenForPort(port int) bool {
	if port <= 0 {
		return false
	}
	marker := "fwx-stat-" + strconv.Itoa(port) + ":"
	for _, binary := range iptablesAgentBinaries() {
		if binary == "ip6tables" && !commandExists("ip6tables") {
			continue
		}
		raw, err := exec.Command(binary, "-t", "mangle", "-S").Output()
		if err == nil && strings.Contains(string(raw), marker) {
			return true
		}
	}
	return false
}

func readLocalRuntimeStatePayload() localRuntimeStatePayload {
	readiness := readLocalRuntimeReadinessCached()
	ruleStates := readLocalRuntimeRuleStates()
	rules := make([]localRuntimeRuleState, 0, len(ruleStates))
	for _, state := range ruleStates {
		port := atoi(state.Port)
		if port <= 0 {
			continue
		}
		rules = append(rules, localRuntimeRuleState{
			Port:        port,
			RuleID:      state.RuleID,
			TunnelID:    state.TunnelID,
			ForwardType: strings.TrimSpace(state.ForwardType),
			TargetIP:    strings.TrimSpace(state.TargetIP),
			TargetPort:  state.TargetPort,
			Protocol:    strings.TrimSpace(state.Protocol),
			Ready:       localRuleStateReady(state, &readiness),
		})
	}
	tunnels := []localRuntimeTunnelState{}
	files, err := os.ReadDir(agentStateDir)
	if err == nil {
		for _, f := range files {
			name := f.Name()
			if !strings.HasPrefix(name, "tunnel_") || !strings.HasSuffix(name, ".id") {
				continue
			}
			port := strings.TrimSuffix(strings.TrimPrefix(name, "tunnel_"), ".id")
			portValue := atoi(port)
			if portValue <= 0 {
				continue
			}
			tunnelID := readTunnelIDByPort(port)
			if tunnelID <= 0 {
				continue
			}
			forwardType := strings.TrimSpace(readTunnelForwardTypeByPort(port))
			tunnels = append(tunnels, localRuntimeTunnelState{
				Port:        portValue,
				TunnelID:    tunnelID,
				ForwardType: forwardType,
				Ready:       localTunnelStateReady(tunnelID, portValue, forwardType, &readiness),
			})
		}
	}
	sort.Slice(rules, func(i, j int) bool {
		if rules[i].Port == rules[j].Port {
			return rules[i].RuleID < rules[j].RuleID
		}
		return rules[i].Port < rules[j].Port
	})
	sort.Slice(tunnels, func(i, j int) bool {
		if tunnels[i].Port == tunnels[j].Port {
			return tunnels[i].TunnelID < tunnels[j].TunnelID
		}
		return tunnels[i].Port < tunnels[j].Port
	})
	return localRuntimeStatePayload{Rules: rules, Tunnels: tunnels, Services: readiness.serviceStates}
}

func localRuntimeStateSignature(state localRuntimeStatePayload) string {
	raw, err := json.Marshal(state)
	if err != nil {
		return ""
	}
	h := fnv.New64a()
	_, _ = h.Write(raw)
	return strconv.FormatUint(h.Sum64(), 16)
}

func localRuntimeStateForHeartbeat() (string, *localRuntimeStatePayload) {
	state := readLocalRuntimeStatePayload()
	signature := localRuntimeStateSignature(state)
	localRuntimeStateMu.Lock()
	sendFull := forceSendLocalRuntimeState || signature != lastLocalRuntimeStateSignature
	if sendFull {
		lastLocalRuntimeStateSignature = signature
		forceSendLocalRuntimeState = false
	}
	localRuntimeStateMu.Unlock()
	if sendFull {
		return signature, &state
	}
	return signature, nil
}

func requestLocalRuntimeStateUpload() {
	localRuntimeStateMu.Lock()
	forceSendLocalRuntimeState = true
	localRuntimeStateMu.Unlock()
	// 运行时状态有变化，丢弃 readiness 缓存以便下次心跳重新采集。
	invalidateLocalRuntimeReadinessCache()
}

type selfTestResp struct {
	SelfTests []selfTest `json:"selfTests"`
}

type action struct {
	TunnelID         int           `json:"tunnelId"`
	StatusType       string        `json:"statusType"`
	RuleID           int           `json:"ruleId"`
	IssuedAt         int64         `json:"issuedAt,omitempty"`
	KnownRunning     bool          `json:"knownRunning,omitempty"`
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
	FailureMessage   string        `json:"failureMessage,omitempty"`
}

type desiredState struct {
	Version  int      `json:"version"`
	IssuedAt int64    `json:"issuedAt,omitempty"`
	Actions  []action `json:"actions"`
}

type desiredActionRecord struct {
	Signature string `json:"signature"`
	Success   bool   `json:"success"`
	UpdatedAt int64  `json:"updatedAt"`
}

type runningRule struct {
	RuleID      int           `json:"ruleId"`
	TunnelID    int           `json:"tunnelId,omitempty"`
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
	Host  string   `json:"host"`
	Scope string   `json:"scope,omitempty"`
	RefID int      `json:"refId,omitempty"`
	Old   []string `json:"old,omitempty"`
	New   []string `json:"new,omitempty"`
}

type agentUpgrade struct {
	TargetVersion  string `json:"targetVersion"`
	PanelURL       string `json:"panelUrl"`
	ReleaseVersion string `json:"releaseVersion"`
}

type agentEventMessage struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

// agentDesiredStatePush 是服务端经 SSE 下发的 desiredState 推送载荷，
// 包含 desired state 及 running rules，让 Agent 无需等待下一个心跳即可立即执行。
type agentDesiredStatePush struct {
	DesiredState    *desiredState     `json:"desiredState,omitempty"`
	RunningRules    []runningRule     `json:"runningRules,omitempty"`
	StateSignatures map[string]string `json:"stateSignatures,omitempty"`
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
	UDPListenPort            int               `json:"udpListenPort,omitempty"`
	Protocol                 string            `json:"protocol"`
	ExitHost                 string            `json:"exitHost"`
	ExitPort                 int               `json:"exitPort"`
	UDPExitPort              int               `json:"udpExitPort,omitempty"`
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
	UDPRelayExitPort         int               `json:"udpRelayExitPort,omitempty"`
	RelayKey                 string            `json:"relayKey,omitempty"`
	DNSGeneration            int               `json:"dnsGeneration,omitempty"`
}

type fxpExitEndpoint struct {
	Host    string `json:"host"`
	Port    int    `json:"port"`
	UDPPort int    `json:"udpPort,omitempty"`
	Key     string `json:"key,omitempty"`
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
	BackendPort          int            `json:"backendPort"`
	BackendForwardType   string         `json:"backendForwardType"`
	Protocol             string         `json:"protocol"`
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
	resetDesiredActionRecordsAfterAgentUpgrade()
	startActionStatusReporter()
	startPluginAgentTaskWorkers()
	go actionWorker()
	go selfTestPoller(cfg)
	go agentEventStream(cfg)
	for {
		pending := atomic.LoadInt64(&actionPendingCount)
		fromSSE := heartbeatWakeFromSSE.Swap(false)
		if pending > 0 {
			if shouldLogAgentReport("heartbeat-pending-continue", agentReportLogInterval) {
				logf("heartbeat continue while actions pending=%d queued=%d workers=%d/%d fromSSE=%v", pending, len(actionQueue), atomic.LoadInt64(&actionWorkerStartedCount), actionWorkerConcurrency, fromSSE)
			}
		}
		// SSE 唤醒 + 有 actions 正在处理：只发轻量 keepalive（不做 readiness 扫描，
		// 仅上报指标并告知面板 Agent 正忙）。完整心跳由定时器或下一次 SSE 唤醒触发。
		if fromSSE && pending > 0 {
			if err := heartbeatKeepalive(cfg); err != nil {
				logAgentCommError("heartbeat-keepalive", err)
			}
		} else {
			nextInterval, err := heartbeat(cfg)
			if err != nil {
				logAgentCommError("heartbeat", err)
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
			continue
		}
		select {
		case <-heartbeatWakeCh:
		case <-time.After(time.Duration(cfg.Interval) * time.Second):
		}
	}
}

func wakeHeartbeat() {
	select {
	case heartbeatWakeCh <- struct{}{}:
	default:
	}
}

// wakeHeartbeatFromSSE 由 SSE 推送触发，标记本次唤醒来源为 SSE。
// 主循环据此判断：若 Agent 正忙（actions pending），只发轻量 keepalive，
// 避免在 churn 窗口内重复执行 ss/systemctl/config 全扫描。
func wakeHeartbeatFromSSE() {
	heartbeatWakeFromSSE.Store(true)
	wakeHeartbeat()
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

func heartbeatStaticChanged(a, b heartbeatStaticSnapshot) bool {
	return a.PrimaryIP != b.PrimaryIP ||
		a.IPv4 != b.IPv4 ||
		a.IPv6 != b.IPv6 ||
		a.DefaultNetworkInterface != b.DefaultNetworkInterface ||
		a.CPUInfo != b.CPUInfo ||
		a.MemoryTotal != b.MemoryTotal ||
		a.SwapTotal != b.SwapTotal ||
		a.DiskTotal != b.DiskTotal ||
		a.Version != b.Version
}

func defaultNetworkInterface() string {
	if runtime.GOOS != "linux" {
		return ""
	}
	if raw, err := os.ReadFile("/proc/net/route"); err == nil {
		if name := defaultIPv4NetworkInterface(raw); name != "" {
			return name
		}
	}
	if raw, err := os.ReadFile("/proc/net/ipv6_route"); err == nil {
		return defaultIPv6NetworkInterface(raw)
	}
	return ""
}

func defaultIPv4NetworkInterface(raw []byte) string {
	lines := strings.Split(string(raw), "\n")
	for _, line := range lines[1:] {
		fields := strings.Fields(line)
		if len(fields) < 4 || fields[1] != "00000000" {
			continue
		}
		flags, err := strconv.ParseUint(fields[3], 16, 64)
		if err != nil || flags&0x1 == 0 {
			continue
		}
		name := strings.TrimSpace(fields[0])
		if validNetworkInterfaceName(name) {
			return name
		}
	}
	return ""
}

func defaultIPv6NetworkInterface(raw []byte) string {
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 10 || strings.Trim(fields[0], "0") != "" {
			continue
		}
		prefixLength, err := strconv.ParseUint(fields[1], 16, 16)
		if err != nil || prefixLength != 0 {
			continue
		}
		flags, err := strconv.ParseUint(fields[len(fields)-2], 16, 64)
		if err != nil || flags&0x1 == 0 {
			continue
		}
		name := strings.TrimSpace(fields[len(fields)-1])
		if validNetworkInterfaceName(name) {
			return name
		}
	}
	return ""
}

func heartbeat(cfg Config) (int, error) {
	pruneAgentRuntimeData()
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
	diskUsageValue, diskUsed, diskTotal := diskStats()
	cpuUsageValue := cpuUsage()
	uptimeValue := uptime()
	compactEnabled := compactAgentReports.Load()
	currentStatic := heartbeatStaticSnapshot{
		PrimaryIP:               primaryIP,
		IPv4:                    ipv4,
		IPv6:                    ipv6,
		DefaultNetworkInterface: defaultNetworkInterface(),
		CPUInfo:                 cpuInfo(),
		MemoryTotal:             memoryTotal,
		SwapTotal:               swapTotal,
		DiskTotal:               diskTotal,
		Version:                 Version,
	}
	previousStatic := heartbeatStaticReport
	shouldReportStatic := !previousStatic.Initialized ||
		heartbeatStaticChanged(currentStatic, previousStatic) ||
		time.Since(previousStatic.ReportedAt) >= heartbeatStaticReportInterval
	payload := map[string]any{}
	if compactEnabled {
		payload["m"] = []any{
			cpuUsageValue,
			usagePercent(memoryUsed, memoryTotal),
			memoryUsed,
			memoryTotal,
			usagePercent(swapUsed, swapTotal),
			swapUsed,
			swapTotal,
			netBytes(0),
			netBytes(1),
			diskUsageValue,
			diskUsed,
			diskTotal,
			uptimeValue,
		}
	} else {
		payload = map[string]any{
			"cpuUsage":     cpuUsageValue,
			"memoryUsage":  usagePercent(memoryUsed, memoryTotal),
			"memoryUsed":   memoryUsed,
			"memoryTotal":  memoryTotal,
			"swapUsage":    usagePercent(swapUsed, swapTotal),
			"swapUsed":     swapUsed,
			"swapTotal":    swapTotal,
			"networkIn":    netBytes(0),
			"networkOut":   netBytes(1),
			"diskUsage":    diskUsageValue,
			"diskUsed":     diskUsed,
			"diskTotal":    diskTotal,
			"uptime":       uptimeValue,
			"cpuInfo":      currentStatic.CPUInfo,
			"agentVersion": Version,
		}
	}
	if (!compactEnabled || shouldReportStatic) && primaryIP != "" {
		payload["ip"] = primaryIP
	}
	if (!compactEnabled || shouldReportStatic) && ipv4 != "" {
		payload["ipv4"] = ipv4
	}
	if (!compactEnabled || shouldReportStatic) && ipv6 != "" {
		payload["ipv6"] = ipv6
	}
	if compactEnabled && shouldReportStatic {
		payload["cpuInfo"] = currentStatic.CPUInfo
		payload["agentVersion"] = Version
	}
	if currentStatic.DefaultNetworkInterface != "" {
		payload["defaultNetworkInterface"] = currentStatic.DefaultNetworkInterface
	}
	if len(dnsChanges) > 0 {
		payload["dnsChanged"] = dnsChanges
	}
	if signatures := heartbeatStateSignaturePayload(); len(signatures) > 0 {
		payload["stateSignatures"] = signatures
	}
	if signature, localState := localRuntimeStateForHeartbeat(); signature != "" {
		payload["localStateSignature"] = signature
		if localState != nil {
			payload["localState"] = localState
		}
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
	compactAgentReports.Store(resp.CompactReports)
	if !compactEnabled || shouldReportStatic {
		currentStatic.ReportedAt = time.Now()
		currentStatic.Initialized = true
		heartbeatStaticReport = currentStatic
	}
	syncPanelURLFromResponse(resp.PanelURL)
	if resp.AgentUpgrade != nil {
		go selfUpgrade(cfg, resp.AgentUpgrade)
	}
	// Interactive tasks are independent from desired-state reconciliation. Accept
	// them before an early local-state return so a heartbeat response cannot drop
	// a task while the Agent is rebuilding its runtime snapshot.
	for _, task := range resp.LookingGlassTests {
		go handleLookingGlassTask(cfg, task)
	}
	for _, task := range resp.Iperf3Tasks {
		go handleIperf3Task(cfg, task)
	}
	for _, task := range resp.PluginTasks {
		enqueuePluginAgentTask(cfg, task)
	}
	if resp.RequestLocalState {
		requestLocalRuntimeStateUpload()
		next := resp.NextInterval
		if next <= 0 || next > 2 {
			next = 2
		}
		return next, nil
	}
	state := applyHeartbeatState(resp)
	dnsWatchChanged := updateDNSWatch(state.DNSWatch)
	rememberDesiredRunningRules(state.RunningRules)
	pendingActionPorts := map[string]bool{}
	actionDone := make([]<-chan struct{}, 0, len(resp.Actions)+len(desiredStateActions(resp.DesiredState)))
	for _, a := range desiredStateActions(resp.DesiredState) {
		if a.SourcePort > 0 && shouldReportActionStatus(a) {
			if key := actionProtectedPort(a); key != "" {
				pendingActionPorts[key] = true
			}
		}
	}
	for _, done := range syncDesiredState(cfg, resp.DesiredState) {
		actionDone = append(actionDone, done)
	}
	for _, a := range resp.Actions {
		if a.SourcePort > 0 && shouldReportActionStatus(a) {
			if key := actionProtectedPort(a); key != "" {
				pendingActionPorts[key] = true
			}
		}
		actionDone = append(actionDone, enqueueAction(cfg, a))
	}
	if len(resp.SelfTests) > 0 && len(actionDone) > 0 {
		waitForActionBatch(actionDone, 20*time.Second)
	}
	for _, t := range resp.SelfTests {
		enqueueSelfTest(cfg, t)
	}
	for port := range snapshotProtectedActionPorts() {
		pendingActionPorts[port] = true
	}
	syncRunningRuleState(state.RunningRules, pendingActionPorts)
	for _, r := range state.RunningRules {
		writeRunningRuleState(r)
		ensureCountingChainsIfNeeded(r)
	}
	syncProtocolGuards(cfg, state.GuardRules)
	if lastTrafficCollectAt.IsZero() || time.Since(lastTrafficCollectAt) >= nextTrafficCollectInterval {
		nextTrafficCollectInterval = collectTraffic(cfg)
		lastTrafficCollectAt = time.Now()
	}
	tcpingInterval := tcpingDueInterval(state.HostProbeServices)
	if resp.ForceTCPing || lastTCPingAt.IsZero() || time.Since(lastTCPingAt) >= tcpingInterval {
		if scheduleTCPingCollection(cfg, state.TunnelProbes, state.ForwardGroupProbes, state.HostProbeServices, resp.ForceTCPing) {
			lastTCPingAt = time.Now()
		}
	}
	if dnsWatchChanged && resp.NextInterval > 2 {
		return 2, nil
	}
	return resp.NextInterval, nil
}

func heartbeatKeepalive(cfg Config) error {
	ipv4, ipv6 := publicIPs()
	primaryIP := ipv4
	if primaryIP == "" {
		primaryIP = ipv6
	}
	memInfo := readMeminfo()
	memoryTotal := memTotalFrom(memInfo)
	memoryUsed := memUsedFrom(memInfo)
	swapTotal := swapTotalFrom(memInfo)
	swapUsed := swapUsedFrom(memInfo)
	diskUsageValue, diskUsed, diskTotal := diskStats()
	currentStatic := heartbeatStaticSnapshot{
		PrimaryIP:               primaryIP,
		IPv4:                    ipv4,
		IPv6:                    ipv6,
		DefaultNetworkInterface: defaultNetworkInterface(),
		CPUInfo:                 cpuInfo(),
		MemoryTotal:             memoryTotal,
		SwapTotal:               swapTotal,
		DiskTotal:               diskTotal,
		Version:                 Version,
	}
	previousStatic := heartbeatStaticReport
	shouldReportStatic := !previousStatic.Initialized ||
		heartbeatStaticChanged(currentStatic, previousStatic) ||
		time.Since(previousStatic.ReportedAt) >= heartbeatStaticReportInterval
	payload := map[string]any{"busy": true}
	if compactAgentReports.Load() {
		payload["m"] = []any{
			cpuUsage(),
			usagePercent(memoryUsed, memoryTotal),
			memoryUsed,
			memoryTotal,
			usagePercent(swapUsed, swapTotal),
			swapUsed,
			swapTotal,
			netBytes(0),
			netBytes(1),
			diskUsageValue,
			diskUsed,
			diskTotal,
			uptime(),
		}
	} else {
		payload["cpuUsage"] = cpuUsage()
		payload["memoryUsage"] = usagePercent(memoryUsed, memoryTotal)
		payload["memoryUsed"] = memoryUsed
		payload["memoryTotal"] = memoryTotal
		payload["swapUsage"] = usagePercent(swapUsed, swapTotal)
		payload["swapUsed"] = swapUsed
		payload["swapTotal"] = swapTotal
		payload["networkIn"] = netBytes(0)
		payload["networkOut"] = netBytes(1)
		payload["diskUsage"] = diskUsageValue
		payload["diskUsed"] = diskUsed
		payload["diskTotal"] = diskTotal
		payload["uptime"] = uptime()
	}
	if shouldReportStatic && primaryIP != "" {
		payload["ip"] = primaryIP
	}
	if shouldReportStatic && ipv4 != "" {
		payload["ipv4"] = ipv4
	}
	if shouldReportStatic && ipv6 != "" {
		payload["ipv6"] = ipv6
	}
	if compactAgentReports.Load() && shouldReportStatic {
		payload["cpuInfo"] = currentStatic.CPUInfo
		payload["agentVersion"] = Version
	}
	if currentStatic.DefaultNetworkInterface != "" {
		payload["defaultNetworkInterface"] = currentStatic.DefaultNetworkInterface
	}
	var resp heartbeatResp
	if err := post(cfg, "/api/agent/heartbeat", payload, &resp); err != nil {
		return err
	}
	compactAgentReports.Store(resp.CompactReports)
	if shouldReportStatic {
		currentStatic.ReportedAt = time.Now()
		currentStatic.Initialized = true
		heartbeatStaticReport = currentStatic
	}
	syncPanelURLFromResponse(resp.PanelURL)
	if resp.RequestLocalState {
		requestLocalRuntimeStateUpload()
	}
	return nil
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
		if isTransientAgentCommError(err) {
			logAgentCommError("looking-glass-result", err)
		} else {
			logf("looking glass result report failed task=%s method=%s target=%s: %v", task.TaskID, task.Method, task.ResolvedAddress, err)
		}
	}
}

func reportLookingGlassProgress(cfg Config, result lookingGlassResult) {
	if err := post(cfg, "/api/agent/looking-glass-progress", map[string]any{"result": result}, &map[string]any{}); err != nil {
		if isTransientAgentCommError(err) {
			logAgentCommError("looking-glass-progress", err)
		} else {
			logf("looking glass progress report failed task=%s method=%s target=%s: %v", result.TaskID, result.Method, result.ResolvedAddress, err)
		}
	}
}

func handleIperf3Task(cfg Config, task iperf3Task) {
	result := runIperf3Task(cfg, task)
	if err := post(cfg, "/api/agent/iperf3-result", map[string]any{"result": result}, &map[string]any{}); err != nil {
		if isTransientAgentCommError(err) {
			logAgentCommError("iperf3-result", err)
		} else {
			logf("iperf3 result report failed task=%s op=%s port=%d: %v", task.TaskID, task.Op, task.Port, err)
		}
	}
}

func reportIperf3Result(cfg Config, result iperf3Result) {
	if result.UpdatedAt == "" {
		result.UpdatedAt = time.Now().Format(time.RFC3339Nano)
	}
	if err := post(cfg, "/api/agent/iperf3-result", map[string]any{"result": result}, &map[string]any{}); err != nil {
		if isTransientAgentCommError(err) {
			logAgentCommError("iperf3-status", err)
		} else {
			logf("iperf3 status report failed task=%s op=%s port=%d: %v", result.TaskID, result.Op, result.Port, err)
		}
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
	delay := agentEventStreamReconnectMinDelay
	for {
		startedAt := time.Now()
		if err := runAgentEventStream(cfg); err != nil {
			logAgentCommError("event-stream", err)
			syncSystemTimeForCommError(err)
			time.Sleep(delay)
			if time.Since(startedAt) >= agentEventStreamReconnectMaxDelay {
				delay = agentEventStreamReconnectMinDelay
			} else {
				delay *= 2
				if delay > agentEventStreamReconnectMaxDelay {
					delay = agentEventStreamReconnectMaxDelay
				}
			}
			continue
		}
		delay = agentEventStreamReconnectMinDelay
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
	req.Header.Set("Cache-Control", "no-cache")

	client := &http.Client{
		Timeout: 0,
		Transport: &http.Transport{
			Proxy:             http.ProxyFromEnvironment,
			ForceAttemptHTTP2: false,
			TLSClientConfig:   &tls.Config{MinVersion: tls.VersionTLS12},
		},
	}
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
					wakeHeartbeatFromSSE()
				} else if msg.Type == "agent-desired-state" {
					var push agentDesiredStatePush
					if err := json.Unmarshal(msg.Data, &push); err != nil {
						logf("decode agent-desired-state payload: %v", err)
					} else {
						go handleAgentDesiredStatePush(cfg, push)
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
	if err := scanner.Err(); err != nil {
		return err
	}
	return io.EOF
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

// handleAgentDesiredStatePush 处理服务端通过 SSE 推送的 desiredState，
// 立即执行 desired state 对账，无需等待下一个心跳周期。
// 与心跳路径的 syncDesiredState 共享同一幂等性机制（签名 + desired_state_records.json），
// 因此即使心跳和 SSE 推送同时触发也不会重复执行。
func handleAgentDesiredStatePush(cfg Config, push agentDesiredStatePush) {
	if push.DesiredState == nil && len(push.RunningRules) == 0 {
		return
	}
	// 先应用 running rules，stale-remove 保护依赖这份数据。
	if len(push.RunningRules) > 0 || len(push.StateSignatures) > 0 {
		partial := heartbeatResp{
			RunningRules:    push.RunningRules,
			StateSignatures: push.StateSignatures,
		}
		state := applyHeartbeatState(partial)
		rememberDesiredRunningRules(state.RunningRules)
	}
	if push.DesiredState == nil {
		return
	}
	done := syncDesiredState(cfg, push.DesiredState)
	// desired state 里可能夹带 apply 动作，这些动作执行完才能准确上报端口 ready，
	// 这里不阻塞等待，让 worker pool 自行处理；后续心跳会确认最终状态。
	_ = done
	// 通知下一次心跳重新采集本地状态（可能由于 worker 还未完成所以暂缓），
	// 同时失效 readiness 缓存，让采集结果反映最新运行时状态。
	requestLocalRuntimeStateUpload()
}

func handleAction(cfg Config, a action) bool {
	ok := true
	actionMessage := &actionMessage{}
	skippedStaleRemove := false
	if strings.TrimSpace(a.StatusType) == "runtime" {
		mimicAction := isMimicRuntimeAction(a)
		if shouldSkipRuntimeAction(a) {
			if mimicAction && shouldLogAgentReport("mimic-runtime-skip", agentReportLogInterval) {
				logf("mimic runtime sync skipped; cached state healthy diagnostics=%s", mimicRuntimeDiagnostics())
			}
			return true
		}
		if mimicAction {
			logf("mimic runtime sync start commands=%d diagnosticsBefore=%s", len(a.Commands), mimicRuntimeDiagnostics())
		}
		logVerbosef("action start op=%s statusType=%s rule=%d tunnel=%d forwardType=%s port=%d protocol=%s", a.Op, a.StatusType, a.RuleID, a.TunnelID, a.ForwardType, a.SourcePort, a.Protocol)
		ok = runShellBatch(append(append([]string{}, a.PreCommands...), append(a.Commands, a.PostCommands...)...)) && ok
		logGostRuntimeProxySummary(runtimeConfigPath, runtimeServiceName)
		logGostRuntimeProxySummary(tunnelRuntimeConfigPath, tunnelRuntimeServiceName)
		if mimicAction {
			logf("mimic runtime sync complete ok=%v diagnosticsAfter=%s", ok, mimicRuntimeDiagnostics())
		} else if !ok || agentVerboseLogs {
			logf("runtime action complete forwardType=%s ok=%v", a.ForwardType, ok)
		}
		rememberRuntimeActionResult(a, ok)
		if a.ReportStatus != nil && *a.ReportStatus {
			if !ok {
				message := strings.TrimSpace(a.FailureMessage)
				if message == "" {
					message = fmt.Sprintf("runtime action failed: %s", strings.TrimSpace(a.ForwardType))
				}
				actionMessage.set("%s", message)
			}
			reportActionStatus(cfg, a, ok, actionMessage.get())
		}
		return ok
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
			ok = runShellBatch(a.PreCommands) && ok
			if a.Unit != "" && a.ServiceName != "" {
				ok = writeUnitAndRestart(a.ServiceName, a.Unit, managedServiceActionSignature(a, a.ServiceName, a.Unit)) && ok
			}
			if a.UnitExtra != "" && a.ServiceNameExtra != "" {
				ok = writeUnitAndRestart(a.ServiceNameExtra, a.UnitExtra, managedServiceActionSignature(a, a.ServiceNameExtra, a.UnitExtra)) && ok
			}
			ok = runShellBatch(a.Commands) && ok
		}
		if a.Fxp != nil {
			fxpOK := startFXP(cfg, *a.Fxp, actionMessage)
			if !fxpOK || agentVerboseLogs {
				logf("action fxp role=%s tunnel=%d rule=%d listen=%d udpListen=%d protocol=%s proxyReceive=%v proxySend=%v ok=%v", a.Fxp.Role, a.Fxp.TunnelID, a.Fxp.RuleID, a.Fxp.ListenPort, a.Fxp.UDPListenPort, a.Fxp.Protocol, a.Fxp.ProxyProtocolReceive, a.Fxp.ProxyProtocolSend, fxpOK)
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
		if ok && shouldVerifyManagedRuntimeListen(a) && !waitForManagedRuntimeActionListenReady(a, 12*time.Second) {
			ok = false
			message := fmt.Sprintf("managed runtime listener not ready after apply port=%d protocol=%s forwardType=%s", a.SourcePort, normalizeRuntimeProtocol(a.Protocol), strings.TrimSpace(a.ForwardType))
			actionMessage.set(message)
			if shouldLogAgentReport(fmt.Sprintf("managed-runtime-listen-missing:%d:%s:%s", a.SourcePort, normalizeRuntimeProtocol(a.Protocol), a.ForwardType), agentReportLogInterval) {
				logf("%s %s owner=%s", message, actionLogSummary(a), listenPortOwnerSummary(a.SourcePort))
			}
			requestLocalRuntimeStateUpload()
		}
		if ok && shouldReportActionStatus(a) {
			writeState(a)
		}
	} else {
		if shouldSkipRemoveForReassignedPort(a) {
			ok = true
			skippedStaleRemove = true
		} else {
			stopFailoverProxy(a.RuleID, a.SourcePort)
			if a.Fxp != nil {
				stopFXP(*a.Fxp)
			}
			for _, name := range managedServiceNamesForAction(a) {
				cleanupManagedService(name)
			}
			ok = runShellBatch(a.Commands) && ok
			if shouldReportActionStatus(a) && !actionRequiresKernelForwardConsistency(a) {
				removeState(a.SourcePort)
			}
		}
	}
	if ok && !skippedStaleRemove && actionRequiresKernelForwardConsistency(a) && !newKernelForwardSnapshot().desiredActionConsistent(a) {
		ok = false
		message := fmt.Sprintf("kernel firewall state mismatch after %s", strings.TrimSpace(a.Op))
		actionMessage.set(message)
		if shouldLogAgentReport(fmt.Sprintf("kernel-forward-mismatch:%d:%d:%s:%s", a.RuleID, a.SourcePort, a.ForwardType, a.Op), agentReportLogInterval) {
			logf("%s %s", message, actionLogSummary(a))
		}
		requestLocalRuntimeStateUpload()
	}

	if ok && !skippedStaleRemove && a.Op == "remove" && shouldReportActionStatus(a) && actionRequiresKernelForwardConsistency(a) {
		removeState(a.SourcePort)
	}
	if skippedStaleRemove {
		requestLocalRuntimeStateUpload()
		return ok
	}
	if !shouldReportActionStatus(a) {
		// 即使不上报状态，运行时状态已变，让下次 readiness 重新采集。
		invalidateLocalRuntimeReadinessCache()
		return ok
	}
	running := ok && a.Op == "apply"
	reportActionStatus(cfg, a, running, actionMessage.get())
	invalidateLocalRuntimeReadinessCache()
	return ok
}

func shouldVerifyManagedRuntimeListen(a action) bool {
	if strings.TrimSpace(a.Op) != "apply" || strings.TrimSpace(a.StatusType) == "runtime" || a.SourcePort <= 0 {
		return false
	}
	if a.Fxp != nil {
		return false
	}
	switch strings.TrimSpace(a.ForwardType) {
	case "gost", "gost-tunnel", "gost-tunnel-exit", "gost-tunnel-hop", "nginx", "nginx-tunnel", "nginx-tunnel-exit":
		return true
	default:
		return false
	}
}

func waitForManagedRuntimeActionListenReady(a action, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		if managedRuntimeActionListenReady(a) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func managedRuntimeActionListenReady(a action) bool {
	switch strings.TrimSpace(a.ForwardType) {
	case "nginx", "nginx-tunnel", "nginx-tunnel-exit":
		return desiredNginxRuntimeReady(a.SourcePort, a.Protocol)
	case "gost", "gost-tunnel", "gost-tunnel-exit", "gost-tunnel-hop":
		return desiredGostRuntimeReady(a.SourcePort, a.Protocol)
	default:
		return true
	}
}

func reportActionStatus(cfg Config, a action, running bool, message string) {
	if !shouldReportActionStatus(a) {
		return
	}
	enqueueActionStatusReport(cfg, a, running, message)
}

func shouldSkipRemoveForReassignedPort(a action) bool {
	if a.Op != "remove" || a.RuleID <= 0 || a.SourcePort <= 0 || strings.TrimSpace(a.StatusType) == "tunnel" {
		return false
	}
	if desired, ok := desiredRunningRuleForAction(a); ok && desired.RuleID > 0 {
		if desired.RuleID != a.RuleID {
			logf("skip stale remove for desired reassigned port=%d protocol=%s removeRule=%d desiredRule=%d forwardType=%s", a.SourcePort, normalizeRuntimeProtocol(a.Protocol), a.RuleID, desired.RuleID, a.ForwardType)
			return true
		}
		if desired.TunnelID != a.TunnelID && (desired.TunnelID > 0 || a.TunnelID > 0) {
			logf("skip stale remove for desired tunnel reassigned port=%d protocol=%s rule=%d removeTunnel=%d desiredTunnel=%d forwardType=%s", a.SourcePort, normalizeRuntimeProtocol(a.Protocol), a.RuleID, a.TunnelID, desired.TunnelID, a.ForwardType)
			return true
		}
		if strings.TrimSpace(desired.ForwardType) != "" && strings.TrimSpace(a.ForwardType) != "" && strings.TrimSpace(desired.ForwardType) != strings.TrimSpace(a.ForwardType) {
			logf("skip stale remove for desired type reassigned port=%d protocol=%s rule=%d removeType=%s desiredType=%s", a.SourcePort, normalizeRuntimeProtocol(a.Protocol), a.RuleID, a.ForwardType, desired.ForwardType)
			return true
		}
	}
	port := strconv.Itoa(a.SourcePort)
	localRuleID := readRuleIDByPort(port)
	localRuleTunnelID := readRuleTunnelIDByPort(port)
	if localRuleID > 0 && localRuleID == a.RuleID && localRuleTunnelID != a.TunnelID && (localRuleTunnelID > 0 || a.TunnelID > 0) {
		logf("skip stale remove for tunnel reassigned port=%d rule=%d removeTunnel=%d currentTunnel=%d forwardType=%s", a.SourcePort, a.RuleID, a.TunnelID, localRuleTunnelID, a.ForwardType)
		return true
	}
	if localRuleID <= 0 || localRuleID == a.RuleID {
		return false
	}
	logf("skip stale remove for reassigned port=%d removeRule=%d currentRule=%d forwardType=%s", a.SourcePort, a.RuleID, localRuleID, a.ForwardType)
	return true
}

func rememberDesiredRunningRules(rules []runningRule) {
	next := map[string]runningRule{}
	nextByRulePort := map[string]runningRule{}
	for _, r := range rules {
		if r.RuleID <= 0 || r.SourcePort <= 0 {
			continue
		}
		next[actionPortProtocolKey(r.SourcePort, r.Protocol)] = r
		if key := runningRuleIDPortKey(r.RuleID, r.SourcePort); key != "" {
			nextByRulePort[key] = r
		}
	}
	desiredRunningRuleMu.Lock()
	desiredRunningRulesByPort = next
	desiredRunningRulesByRulePort = nextByRulePort
	desiredRunningRuleMu.Unlock()
}

func desiredRunningRuleForAction(a action) (runningRule, bool) {
	if a.SourcePort <= 0 {
		return runningRule{}, false
	}
	protocol := normalizeRuntimeProtocol(a.Protocol)
	keys := []string{actionPortProtocolKey(a.SourcePort, protocol)}
	if protocol == "both" {
		keys = append(keys, actionPortProtocolKey(a.SourcePort, "tcp"), actionPortProtocolKey(a.SourcePort, "udp"))
	} else {
		keys = append(keys, actionPortProtocolKey(a.SourcePort, "both"))
	}
	desiredRunningRuleMu.Lock()
	defer desiredRunningRuleMu.Unlock()
	for _, key := range keys {
		if key == "" {
			continue
		}
		if r, ok := desiredRunningRulesByPort[key]; ok {
			return r, true
		}
	}
	if key := runningRuleIDPortKey(a.RuleID, a.SourcePort); key != "" {
		if r, ok := desiredRunningRulesByRulePort[key]; ok {
			return r, true
		}
	}
	return runningRule{}, false
}

func desiredRunningRuleForStatePort(ruleID int, port int) (runningRule, bool) {
	if ruleID <= 0 || port <= 0 {
		return runningRule{}, false
	}
	desiredRunningRuleMu.Lock()
	defer desiredRunningRuleMu.Unlock()
	if r, ok := desiredRunningRulesByRulePort[runningRuleIDPortKey(ruleID, port)]; ok {
		return r, true
	}
	return runningRule{}, false
}

func cleanupKernelForwardPortBeforeApply(a action) {
	if a.Op != "apply" || a.SourcePort <= 0 {
		return
	}
	port := strconv.Itoa(a.SourcePort)
	localRuleID := readRuleIDByPort(port)
	localForwardType := readForwardTypeByPort(port)
	_, _, localProtocol, hasLocalTarget := readTargetInfo(port)
	cleanupProtocol := normalizeRuntimeProtocol(a.Protocol)
	if localRuleID == a.RuleID && hasLocalTarget {
		cleanupProtocol = normalizeRuntimeProtocol(localProtocol)
	}
	reassignedRule := a.RuleID > 0 && localRuleID > 0 && localRuleID != a.RuleID
	changedFromKernelForward := reassignedRule && (localForwardType == "iptables" || localForwardType == "nftables")
	if changedFromKernelForward && a.ForwardType != "iptables" {
		for _, binary := range iptablesAgentBinaries() {
			_ = runShell(iptablesAgentDeleteDnatRulesForPort(binary, port, cleanupProtocol))
		}
	}
	if changedFromKernelForward && a.ForwardType != "nftables" {
		_ = runShell(nftPortCleanupCmd(port, cleanupProtocol))
	}
	switch a.ForwardType {
	case "iptables":
		for _, binary := range iptablesAgentBinaries() {
			_ = runShell(iptablesAgentDeleteDnatRulesForPort(binary, port, cleanupProtocol))
		}
	case "nftables":
		_ = runShell(nftPortCleanupCmd(port, cleanupProtocol))
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
	state := runtimeActionCache[key]
	recentMatch := state.Success && state.Signature == signature && !state.CheckedAt.IsZero() && now.Sub(state.CheckedAt) < runtimeActionRefreshInterval
	runtimeActionMu.Unlock()
	if recentMatch && runtimeActionServicesHealthy(a) {
		return true
	}
	runtimeActionMu.Lock()
	runtimeActionCache[key] = runtimeActionState{Signature: signature, CheckedAt: now, Success: false}
	runtimeActionMu.Unlock()
	return false
}

func rememberRuntimeActionResult(a action, ok bool) {
	key := strings.TrimSpace(a.ForwardType)
	if key == "" {
		key = "runtime"
	}
	signature := actionCommandSignature(a)
	runtimeActionMu.Lock()
	state := runtimeActionCache[key]
	if state.Signature == signature {
		state.Success = ok
		state.CheckedAt = time.Now()
		runtimeActionCache[key] = state
	}
	runtimeActionMu.Unlock()
}

func isMimicRuntimeAction(a action) bool {
	return strings.TrimSpace(a.ForwardType) == "mimic-runtime-sync"
}

func runtimeActionServicesHealthy(a action) bool {
	if isMimicRuntimeAction(a) {
		for _, name := range managedMimicServicesFromLocalConfig() {
			if ok, reason := mimicRuntimeServiceHealth(name); !ok {
				if shouldLogAgentReport("mimic-runtime-unhealthy:"+name, agentReportLogInterval) {
					logf("mimic runtime unhealthy service=%s reason=%s", name, reason)
				}
				return false
			}
		}
		return true
	}
	for _, name := range requiredSharedRuntimeServicesFromLocalConfig() {
		if !managedServiceActive(name) {
			return false
		}
	}
	return true
}

func mimicRuntimeDiagnostics() string {
	services := managedMimicServicesFromLocalConfig()
	if len(services) == 0 {
		return "services=none"
	}
	parts := make([]string, 0, len(services))
	for _, name := range services {
		ok, reason := mimicRuntimeServiceHealth(name)
		parts = append(parts, fmt.Sprintf("%s healthy=%v %s", name, ok, reason))
	}
	return compactLogOutput(strings.Join(parts, " | "))
}

func requiredRuntimeServicesFromLocalConfig() []string {
	services := requiredSharedRuntimeServicesFromLocalConfig()
	services = append(services, managedMimicServicesFromLocalConfig()...)
	return services
}

func requiredSharedRuntimeServicesFromLocalConfig() []string {
	services := []string{}
	if gostRuntimeConfigHasServices(runtimeConfigPath) {
		services = append(services, runtimeServiceName)
	}
	if gostRuntimeConfigHasServices(tunnelRuntimeConfigPath) {
		services = append(services, tunnelRuntimeServiceName)
	}
	if nginxRuntimeConfigHasServers(nginxConfigPath) {
		services = append(services, nginxServiceName)
	}
	return services
}

func managedMimicServicesFromLocalConfig() []string {
	return managedMimicServicesFromConfigDir(mimicConfigDir)
}

func managedMimicServicesFromConfigDir(configDir string) []string {
	entries, err := os.ReadDir(configDir)
	if err != nil {
		return nil
	}
	services := []string{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".conf") {
			continue
		}
		path := filepath.Join(configDir, entry.Name())
		raw, err := os.ReadFile(path)
		if err != nil || !strings.Contains(string(raw), "# Managed by ForwardX") {
			continue
		}
		iface := strings.TrimSuffix(entry.Name(), ".conf")
		if !validNetworkInterfaceName(iface) {
			continue
		}
		services = append(services, "mimic@"+iface)
	}
	sort.Strings(services)
	return services
}

func mimicRuntimeServiceHealthy(name string) bool {
	ok, _ := mimicRuntimeServiceHealth(name)
	return ok
}

func mimicRuntimeServiceHealth(name string) (bool, string) {
	if !strings.HasPrefix(name, "mimic@") {
		return false, "invalid-service-name"
	}
	if !managedServiceActive(name) {
		return false, "service-inactive"
	}
	iface := strings.TrimPrefix(name, "mimic@")
	if !validNetworkInterfaceName(iface) {
		return false, "invalid-interface"
	}
	if !commandExists("mimic") {
		return false, "mimic-command-missing"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "mimic", "show", iface).CombinedOutput()
	output := compactLogOutput(string(out))
	if ctx.Err() == context.DeadlineExceeded {
		return false, "mimic-show-timeout"
	}
	if err != nil {
		if output == "" {
			output = err.Error()
		}
		return false, "mimic-show-failed " + output
	}
	if output == "" {
		output = "mimic-show-ok"
	}
	return true, output
}

func validNetworkInterfaceName(name string) bool {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 32 {
		return false
	}
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') ||
			r == '_' || r == '-' || r == '.' || r == ':' || r == '@' {
			continue
		}
		return false
	}
	return true
}

func gostRuntimeConfigHasServices(path string) bool {
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) == 0 {
		return false
	}
	var cfg struct {
		Services []json.RawMessage `json:"services"`
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return false
	}
	return len(cfg.Services) > 0
}

func nginxRuntimeConfigHasServers(path string) bool {
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) == 0 {
		return false
	}
	text := string(raw)
	return strings.Contains(text, "server {") || strings.Contains(text, "server{")
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
	write(a.StatusType)
	write(a.ForwardType)
	write(strconv.Itoa(a.RuleID))
	write(strconv.Itoa(a.TunnelID))
	write(strconv.Itoa(a.SourcePort))
	write(strings.TrimSpace(a.TargetIP))
	write(strconv.Itoa(a.TargetPort))
	write(normalizeRuntimeProtocol(a.Protocol))
	write(a.ServiceName)
	write(a.ServiceNameExtra)
	write(a.Unit)
	write(a.UnitExtra)
	for _, cmd := range a.PreCommands {
		write(cmd)
	}
	for _, cmd := range a.Commands {
		write(cmd)
	}
	for _, cmd := range a.PostCommands {
		write(cmd)
	}
	if a.Fxp != nil {
		if raw, err := json.Marshal(a.Fxp); err == nil {
			write(string(raw))
		}
	}
	if a.Failover != nil {
		if raw, err := json.Marshal(a.Failover); err == nil {
			write(string(raw))
		}
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
	if a.Op != "apply" || !validActionPort(a.SourcePort) {
		return false
	}
	port := strconv.Itoa(a.SourcePort)
	sharedNginxRuntimePort := actionPortOwnedBySharedNginx(a)
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
				if !sharedNginxRuntimePort {
					waitForActionListenPortFree(a, 2*time.Second)
				}
			}
			cleanupGostRuntimeIfPortBusy(a.SourcePort)
			if !sharedNginxRuntimePort {
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
		for _, cmd := range managedPortCleanupCmdsForApply(port, sharedNginxRuntimePort) {
			_ = runShell(cmd)
		}
		if !sharedNginxRuntimePort {
			waitForActionListenPortFree(a, 2*time.Second)
		}
		removeTunnelStateByPort(port)
		return false
	}
	if a.RuleID <= 0 {
		return false
	}
	localRuleID := readRuleIDByPort(port)
	localForwardType := readForwardTypeByPort(port)
	localRuleTunnelID := readRuleTunnelIDByPort(port)
	if localRuleID <= 0 && localForwardType == "" {
		if fxpMatchesRunning(a.Fxp) {
			writeState(a)
			return true
		}
		if actionUsesManagedListener(a) {
			cleanupUnknownManagedListener(port, a.SourcePort, a.ForwardType)
			if !sharedNginxRuntimePort {
				waitForActionListenPortFree(a, 2*time.Second)
			}
		}
		cleanupGostRuntimeIfPortBusy(a.SourcePort)
		if !sharedNginxRuntimePort {
			waitForActionListenPortFree(a, 2*time.Second)
		}
		return false
	}
	if localRuleID == a.RuleID && (localRuleTunnelID <= 0 || localRuleTunnelID == a.TunnelID) && (localForwardType == "" || localForwardType == a.ForwardType) {
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
	for _, cmd := range managedPortCleanupCmdsForApply(port, sharedNginxRuntimePort) {
		_ = runShell(cmd)
	}
	if !sharedNginxRuntimePort {
		waitForActionListenPortFree(a, 2*time.Second)
	}
	return false
}

func actionUsesSharedNginxRuntime(a action) bool {
	switch strings.TrimSpace(a.ForwardType) {
	case "nginx", "nginx-tunnel", "nginx-tunnel-exit":
		return true
	default:
		return false
	}
}

func actionPortOwnedBySharedNginx(a action) bool {
	return actionUsesSharedNginxRuntime(a) && validActionPort(a.SourcePort) && nginxRuntimeConfigUsesPort(nginxConfigPath, a.SourcePort)
}

func managedPortCleanupCmdsForApply(port string, keepSharedNginx bool) []string {
	if keepSharedNginx {
		return managedPortCleanupCmdsWithNginx(port, false)
	}
	return managedPortCleanupCmds(port)
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
	if !validActionPort(port) {
		return
	}
	ln, err := net.Listen("tcp", net.JoinHostPort("", strconv.Itoa(port)))
	if err == nil {
		_ = ln.Close()
		return
	}
	stopped := false
	for _, item := range managedRuntimeConfigs() {
		if sharedManagedRuntimeOwnsPort(item.path, port) {
			// A matching shared runtime listener is desired state, not a stale per-rule
			// process. Stopping it here drops every port hosted by the same runtime.
			logf("runtime cleanup keeps shared %s for busy port=%d; runtime sync owns config=%s", item.service, port, item.path)
			stopped = true
			continue
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

func sharedManagedRuntimeOwnsPort(configPath string, port int) bool {
	return validActionPort(port) && managedRuntimeConfigUsesPort(configPath, port)
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

type runtimeListenConfig struct {
	Addr     string
	Protocol string
}

func readGostRuntimeServiceListens(path string) ([]runtimeListenConfig, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var cfg struct {
		Services []struct {
			Addr     string `json:"addr"`
			Listener struct {
				Type string `json:"type"`
			} `json:"listener"`
		} `json:"services"`
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		return nil, false
	}
	listens := make([]runtimeListenConfig, 0, len(cfg.Services))
	for _, svc := range cfg.Services {
		protocol := strings.TrimSpace(svc.Listener.Type)
		if protocol == "" {
			protocol = protocolFromListenAddr(svc.Addr)
		}
		listens = append(listens, runtimeListenConfig{Addr: svc.Addr, Protocol: protocol})
	}
	return listens, true
}

func readGostRuntimeServiceAddrs(path string) ([]string, bool) {
	listens, ok := readGostRuntimeServiceListens(path)
	if !ok {
		return nil, false
	}
	addrs := make([]string, 0, len(listens))
	for _, listen := range listens {
		addrs = append(addrs, listen.Addr)
	}
	return addrs, true
}

func protocolFromListenAddr(addr string) string {
	value := strings.ToLower(strings.TrimSpace(addr))
	switch {
	case strings.HasPrefix(value, "udp://"):
		return "udp"
	case strings.HasPrefix(value, "tcp://"):
		return "tcp"
	default:
		return "tcp"
	}
}

func nginxRuntimeListenConfigs(path string) ([]runtimeListenConfig, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	re := regexp.MustCompile(`(?m)\blisten\s+([^;]+);`)
	matches := re.FindAllStringSubmatch(string(b), -1)
	listens := make([]runtimeListenConfig, 0, len(matches))
	for _, match := range matches {
		if len(match) < 2 {
			continue
		}
		fields := strings.Fields(match[1])
		if len(fields) == 0 {
			continue
		}
		protocol := "tcp"
		for _, field := range fields[1:] {
			if strings.EqualFold(strings.TrimSpace(field), "udp") {
				protocol = "udp"
				break
			}
		}
		listens = append(listens, runtimeListenConfig{Addr: fields[0], Protocol: protocol})
	}
	return listens, true
}

func nginxRuntimeListenAddrs(path string) ([]string, bool) {
	listens, ok := nginxRuntimeListenConfigs(path)
	if !ok {
		return nil, false
	}
	addrs := make([]string, 0, len(listens))
	for _, listen := range listens {
		addrs = append(addrs, listen.Addr)
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

type runtimeListenSnapshot struct {
	tcpPorts map[int][]string
	udpPorts map[int][]string
	usable   bool
}

func newRuntimeListenSnapshot() *runtimeListenSnapshot {
	snapshot := &runtimeListenSnapshot{
		tcpPorts: map[int][]string{},
		udpPorts: map[int][]string{},
	}
	if _, err := exec.LookPath("ss"); err == nil {
		if out, err := exec.Command("ss", "-H", "-ltnup").CombinedOutput(); err == nil {
			snapshot.parseSSListenOutput(string(out))
		}
	}
	if !snapshot.usable {
		snapshot.parseProcNetListenFiles()
	}
	return snapshot
}

func (s *runtimeListenSnapshot) parseSSListenOutput(text string) {
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		proto := strings.ToLower(strings.TrimSpace(fields[0]))
		if strings.HasPrefix(proto, "tcp") {
			proto = "tcp"
		} else if strings.HasPrefix(proto, "udp") {
			proto = "udp"
		} else {
			continue
		}
		port := addrPort(fields[4])
		if port <= 0 {
			continue
		}
		s.add(proto, port, line)
	}
}

func (s *runtimeListenSnapshot) parseProcNetListenFiles() {
	files := []struct {
		path     string
		protocol string
	}{
		{"/proc/net/tcp", "tcp"},
		{"/proc/net/tcp6", "tcp"},
		{"/proc/net/udp", "udp"},
		{"/proc/net/udp6", "udp"},
	}
	for _, file := range files {
		raw, err := os.ReadFile(file.path)
		if err != nil {
			continue
		}
		for idx, line := range strings.Split(string(raw), "\n") {
			if idx == 0 {
				continue
			}
			fields := strings.Fields(strings.TrimSpace(line))
			if len(fields) < 4 {
				continue
			}
			if file.protocol == "tcp" && strings.ToUpper(fields[3]) != "0A" {
				continue
			}
			port := procNetLocalPort(fields[1])
			if port <= 0 {
				continue
			}
			s.add(file.protocol, port, file.path+":"+fields[1])
		}
	}
}

func procNetLocalPort(value string) int {
	idx := strings.LastIndex(value, ":")
	if idx < 0 || idx >= len(value)-1 {
		return 0
	}
	raw := strings.TrimSpace(value[idx+1:])
	port64, err := strconv.ParseInt(raw, 16, 32)
	if err != nil || port64 <= 0 || port64 > 65535 {
		return 0
	}
	return int(port64)
}

func (s *runtimeListenSnapshot) add(protocol string, port int, line string) {
	if s == nil || port <= 0 {
		return
	}
	protocol = normalizeRuntimeProtocol(protocol)
	if protocol == "udp" {
		s.udpPorts[port] = append(s.udpPorts[port], line)
	} else {
		s.tcpPorts[port] = append(s.tcpPorts[port], line)
	}
	s.usable = true
}

func runtimeListenPortReady(snapshot *runtimeListenSnapshot, port int, protocol string, processNeedles []string) bool {
	if port <= 0 {
		return false
	}
	for _, proto := range runtimeProtocols(protocol) {
		if snapshot != nil && snapshot.usable {
			if !snapshot.protocolPortReady(port, proto, processNeedles) {
				return false
			}
			continue
		}
		if !runtimePortOccupiedByProtocol(port, proto) {
			return false
		}
	}
	return true
}

func (s *runtimeListenSnapshot) protocolPortReady(port int, protocol string, processNeedles []string) bool {
	if s == nil || !s.usable || port <= 0 {
		return false
	}
	var lines []string
	if normalizeRuntimeProtocol(protocol) == "udp" {
		lines = s.udpPorts[port]
	} else {
		lines = s.tcpPorts[port]
	}
	if len(lines) == 0 {
		return false
	}
	needles := normalizeRuntimeProcessNeedles(processNeedles)
	if len(needles) == 0 {
		return true
	}
	ownerSeen := false
	for _, line := range lines {
		lower := strings.ToLower(line)
		if strings.Contains(lower, "users:") || strings.Contains(lower, "pid=") {
			ownerSeen = true
			for _, needle := range needles {
				if strings.Contains(lower, needle) {
					return true
				}
			}
		}
	}
	return !ownerSeen
}

func normalizeRuntimeProcessNeedles(values []string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, value := range values {
		value = strings.ToLower(strings.TrimSpace(value))
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

func runtimePortOccupiedByProtocol(port int, protocol string) bool {
	if port <= 0 {
		return false
	}
	addr := ":" + strconv.Itoa(port)
	if normalizeRuntimeProtocol(protocol) == "udp" {
		conn, err := net.ListenPacket("udp", addr)
		if err != nil {
			return true
		}
		_ = conn.Close()
		return false
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return true
	}
	_ = ln.Close()
	return false
}

func fxpMatchesRunning(spec *fxpSpec) bool {
	if spec == nil {
		return false
	}
	normalized := normalizeFXPSpec(*spec)
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
	if !runShellBatch(commands) {
		if actionMessage != nil {
			actionMessage.remember("non-critical post apply commands failed; forwarding service may still be running")
		}
		logf("post apply commands completed with failures total=%d", len(commands))
	}
}

func writeUnitAndRestart(name, unit string, signature string) bool {
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
		changed, err := writeFileIfChanged(path, []byte(unit), 0644)
		if err != nil {
			logf("write systemd unit %s: %v", name, err)
			return false
		}
		q := shellQuote(name)
		if changed && !runShell("systemctl daemon-reload") {
			return false
		}
		_ = runShell("systemctl reset-failed " + q + ".service 2>/dev/null || true")
		if !changed && managedServiceSignatureMatches(name, signature) && managedServiceActive(name) {
			logVerbosef("service %s unchanged and active; skip restart", name)
			return true
		}
		ok := runShell("systemctl enable "+q+".service") &&
			runShell("systemctl restart "+q+".service")
		if ok {
			writeManagedServiceSignature(name, signature)
		}
		return ok
	}
	if commandExists("rc-service") && commandExists("rc-update") {
		path := "/etc/init.d/" + name
		changed, err := writeFileIfChanged(path, []byte(openRCServiceScript(name, execStart)), 0755)
		if err != nil {
			logf("write openrc service %s: %v", name, err)
			return false
		}
		if !changed && managedServiceSignatureMatches(name, signature) && managedServiceActive(name) {
			logVerbosef("service %s unchanged and active; skip restart", name)
			return true
		}
		ok := runShell("rc-update add "+shellQuote(name)+" default >/dev/null 2>&1 || true") &&
			runShell("rc-service "+shellQuote(name)+" restart")
		if ok {
			writeManagedServiceSignature(name, signature)
		}
		return ok
	}
	if _, err := os.Stat("/etc/init.d"); err == nil {
		path := "/etc/init.d/" + name
		changed, err := writeFileIfChanged(path, []byte(sysVServiceScript(name, execStart)), 0755)
		if err != nil {
			logf("write sysv service %s: %v", name, err)
			return false
		}
		if !changed && managedServiceSignatureMatches(name, signature) && managedServiceActive(name) {
			logVerbosef("service %s unchanged and active; skip restart", name)
			return true
		}
		ok := runShell("command -v update-rc.d >/dev/null 2>&1 && update-rc.d "+shellQuote(name)+" defaults >/dev/null 2>&1 || true") &&
			runShell("command -v chkconfig >/dev/null 2>&1 && chkconfig "+shellQuote(name)+" on >/dev/null 2>&1 || true") &&
			runShell("/etc/init.d/"+shellQuote(name)+" restart")
		if ok {
			writeManagedServiceSignature(name, signature)
		}
		return ok
	}
	logf("write service %s: unsupported init system", name)
	return false
}

func writeFileIfChanged(path string, data []byte, perm os.FileMode) (bool, error) {
	if existing, err := os.ReadFile(path); err == nil && bytes.Equal(existing, data) {
		_ = os.Chmod(path, perm)
		return false, nil
	}
	if err := os.WriteFile(path, data, perm); err != nil {
		return false, err
	}
	return true, nil
}

func managedServiceActionSignature(a action, serviceName string, unit string) string {
	h := sha256.New()
	write := func(value string) {
		_, _ = h.Write([]byte(value))
		_, _ = h.Write([]byte{0})
	}
	write(strings.TrimSpace(serviceName))
	write(unit)
	write(a.Op)
	write(a.StatusType)
	write(a.ForwardType)
	write(strconv.Itoa(a.RuleID))
	write(strconv.Itoa(a.TunnelID))
	write(strconv.Itoa(a.SourcePort))
	write(strings.TrimSpace(a.TargetIP))
	write(strconv.Itoa(a.TargetPort))
	write(normalizeRuntimeProtocol(a.Protocol))
	for _, cmd := range a.PreCommands {
		write(cmd)
	}
	for _, cmd := range a.Commands {
		write(cmd)
	}
	for _, cmd := range a.PostCommands {
		write(cmd)
	}
	if a.Failover != nil {
		if raw, err := json.Marshal(a.Failover); err == nil {
			write(string(raw))
		}
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil))
}

func managedServiceSignaturePath(name string) string {
	return "/var/lib/forwardx-agent/service_" + name + ".signature"
}

func managedServiceSignatureMatches(name string, signature string) bool {
	signature = strings.TrimSpace(signature)
	if signature == "" {
		return false
	}
	raw, err := os.ReadFile(managedServiceSignaturePath(name))
	return err == nil && strings.TrimSpace(string(raw)) == signature
}

func writeManagedServiceSignature(name string, signature string) {
	signature = strings.TrimSpace(signature)
	if signature == "" {
		return
	}
	_ = os.MkdirAll("/var/lib/forwardx-agent", 0755)
	_ = os.WriteFile(managedServiceSignaturePath(name), []byte(signature+"\n"), 0644)
}

func managedServiceActive(name string) bool {
	name = sanitizeServiceName(name)
	if name == "" {
		return false
	}
	q := shellQuote(name)
	if isSystemdHost() {
		return runShellQuiet("systemctl is-active --quiet " + q + ".service")
	}
	if commandExists("rc-service") {
		return runShellQuiet("rc-service " + q + " status >/dev/null 2>&1")
	}
	if _, err := os.Stat("/etc/init.d/" + name); err == nil {
		return runShellQuiet("/etc/init.d/" + q + " status >/dev/null 2>&1")
	}
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
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' || r == '@' {
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
	return "if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl stop " + q + ".service 2>/dev/null || true; systemctl disable " + q + ".service 2>/dev/null || true; systemd_unit=/etc/systemd/system/" + name + ".service; systemd_removed=0; if [ -e \"$systemd_unit\" ]; then rm -f \"$systemd_unit\"; systemd_removed=1; fi; if [ \"$systemd_removed\" = \"1\" ]; then systemctl daemon-reload 2>/dev/null || true; fi; systemctl reset-failed " + q + ".service 2>/dev/null || true; fi; " +
		"if command -v rc-service >/dev/null 2>&1; then rc-service " + q + " stop 2>/dev/null || true; fi; " +
		"if command -v rc-update >/dev/null 2>&1; then rc-update del " + q + " default 2>/dev/null || true; fi; " +
		"if [ -x /etc/init.d/" + name + " ]; then /etc/init.d/" + name + " stop 2>/dev/null || true; fi; " +
		"if command -v update-rc.d >/dev/null 2>&1; then update-rc.d -f " + q + " remove >/dev/null 2>&1 || true; fi; " +
		"if command -v chkconfig >/dev/null 2>&1; then chkconfig " + q + " off >/dev/null 2>&1 || true; fi; " +
		"rm -f /etc/init.d/" + name + " /var/lib/forwardx-agent/service_" + name + ".signature"
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
	writeRuleTunnelState(port, a.TunnelID)
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

func writeRuleTunnelState(port string, tunnelID int) {
	if strings.TrimSpace(port) == "" {
		return
	}
	path := "/var/lib/forwardx-agent/port_" + port + ".tunnel"
	if tunnelID > 0 {
		_ = os.WriteFile(path, []byte(strconv.Itoa(tunnelID)), 0644)
		return
	}
	_ = os.Remove(path)
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
	writeRuleTunnelState(port, r.TunnelID)
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

func readRuleTunnelIDByPort(port string) int {
	b, err := os.ReadFile("/var/lib/forwardx-agent/port_" + port + ".tunnel")
	if err != nil {
		return 0
	}
	id, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return id
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
			localRuleID := readRuleIDByPort(port)
			if desired, ok := desiredRunningRuleForStatePort(localRuleID, atoi(port)); ok {
				logf("reconcile skip desired local rule port=%s rule=%d desiredTunnel=%d forwardType=%s", port, localRuleID, desired.TunnelID, desired.ForwardType)
				writeRunningRuleState(desired)
				continue
			}
			_, _, protocol, _ := readTargetInfo(port)
			if protectedActionMatchesPort(protectedPorts, port, protocol) {
				logVerbosef("reconcile skip pending action port=%s protocol=%s", port, normalizeRuntimeProtocol(protocol))
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

func iptablesAgentIsIPAddress(value string) bool {
	return net.ParseIP(iptablesAgentAddress(value)) != nil
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

func iptablesAgentDeleteByComment(binary string, table string, marker string) string {
	tableArg := ""
	if table != "" {
		tableArg = "-t " + table + " "
	}
	cmd := fmt.Sprintf(`while rule=$(%s %s-S 2>/dev/null | awk -v marker=%s '$0 ~ marker {sub(/^-A/, "-D"); print; exit}') && [ -n "$rule" ]; do %s %s$rule 2>/dev/null || break; done`, binary, tableArg, shellQuote(marker), binary, tableArg)
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
	return managedPortCleanupCmdsWithNginx(port, true)
}

func managedPortCleanupCmdsWithNginx(port string, cleanupNginx bool) []string {
	inMarker := "fwx-stat-" + port + ":in"
	outMarker := "fwx-stat-" + port + ":out"
	cmds := append(managedListenerCleanupCmds(port),
		managedServiceCleanupShell("forwardx-socat-"+port),
		managedServiceCleanupShell("forwardx-socat-tcp-"+port),
		managedServiceCleanupShell("forwardx-socat-udp-"+port),
		managedServiceCleanupShell("forwardx-realm-"+port),
		"rm -f /etc/forwardx/realm/forwardx-realm-"+port+".toml /etc/forwardx/realm/forwardx-realm-"+port+".toml.sha256 2>/dev/null || true",
	)
	if cleanupNginx {
		cmds = append(cmds, managedNginxCleanupShell(port))
	}
	cmds = append(cmds, nftPortCleanupCmd(port, "both"))
	for _, binary := range iptablesAgentBinaries() {
		cmds = append(cmds,
			iptablesAgentDeleteByComment(binary, "mangle", inMarker),
			iptablesAgentDeleteByComment(binary, "mangle", outMarker),
		)
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
	cmds = append(cmds, "rm -f /var/lib/forwardx-agent/traffic_"+port+".prev /var/lib/forwardx-agent/port_"+port+".rule /var/lib/forwardx-agent/port_"+port+".fwtype /var/lib/forwardx-agent/port_"+port+".tunnel /var/lib/forwardx-agent/target_"+port+".info 2>/dev/null || true")
	if targetIP, targetPort, _, ok := readTargetInfo(port); ok && iptablesAgentIsIPAddress(targetIP) {
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
				{"mangle", fmt.Sprintf(`OUTPUT -p %s -d %s --dport %s -m comment --comment %q`, proto, target, tp, inMarker)},
				{"mangle", fmt.Sprintf(`POSTROUTING -p %s -d %s --dport %s -m comment --comment %q`, proto, target, tp, inMarker)},
				{"mangle", fmt.Sprintf(`PREROUTING -p %s -s %s --sport %s -m comment --comment %q`, proto, target, tp, outMarker)},
				{"mangle", fmt.Sprintf(`INPUT -p %s -s %s --sport %s -m comment --comment %q`, proto, target, tp, outMarker)},
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
	return "if [ -f /etc/forwardx/nginx/nginx.conf ] && grep -Eq \"listen .*:" + port + "( |;)|listen \\\\[::\\\\]:" + port + "( |;)|listen 0.0.0.0:" + port + "( |;)\" /etc/forwardx/nginx/nginx.conf 2>/dev/null; then listen_count=$(grep -E '^[[:space:]]*listen[[:space:]]+' /etc/forwardx/nginx/nginx.conf 2>/dev/null | wc -l | tr -d ' '); if [ \"${listen_count:-0}\" -le 1 ]; then " + managedServiceCleanupShell("forwardx-nginx") + "; else echo \"[nginx] keep shared forwardx-nginx while replacing port " + port + "\"; fi; fi"
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
	_ = os.Remove("/var/lib/forwardx-agent/port_" + port + ".tunnel")
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
		commands = append(commands,
			iptablesAgentDeleteByComment(binary, "mangle", inMarker),
			iptablesAgentDeleteByComment(binary, "mangle", outMarker),
		)
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
		if targetIP != "" && targetPort > 0 && iptablesAgentIsIPAddress(targetIP) {
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
			targetRules := []string{
				fmt.Sprintf(`OUTPUT -p %s -d %s --dport %s -m comment --comment %q`, proto, target, tp, inMarker),
				fmt.Sprintf(`POSTROUTING -p %s -d %s --dport %s -m comment --comment %q`, proto, target, tp, inMarker),
				fmt.Sprintf(`PREROUTING -p %s -s %s --sport %s -m comment --comment %q`, proto, target, tp, outMarker),
				fmt.Sprintf(`INPUT -p %s -s %s --sport %s -m comment --comment %q`, proto, target, tp, outMarker),
				fmt.Sprintf(`FORWARD -p %s -d %s --dport %s -m comment --comment %q`, proto, target, tp, inMarker),
				fmt.Sprintf(`FORWARD -p %s -s %s --sport %s -m comment --comment %q`, proto, target, tp, outMarker),
			}
			for _, rule := range targetRules {
				commands = append(commands, iptablesAgentEnsure(binary, "mangle", rule))
			}
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
	_ = os.Remove("/var/lib/forwardx-agent/port_" + p + ".tunnel")
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

func normalizeFXPSpec(spec fxpSpec) fxpSpec {
	spec.Role = strings.ToLower(strings.TrimSpace(spec.Role))
	spec.Protocol = normalizeRuntimeProtocol(spec.Protocol)
	spec.ExitHost = strings.TrimSpace(spec.ExitHost)
	spec.TargetIP = strings.TrimSpace(spec.TargetIP)
	spec.RelayExitHost = strings.TrimSpace(spec.RelayExitHost)
	if spec.UDPListenPort <= 0 {
		spec.UDPListenPort = spec.ListenPort
	}
	if spec.UDPExitPort <= 0 {
		spec.UDPExitPort = spec.ExitPort
	}
	if spec.UDPRelayExitPort <= 0 {
		spec.UDPRelayExitPort = spec.RelayExitPort
	}
	for i := range spec.Exits {
		spec.Exits[i].Host = strings.TrimSpace(spec.Exits[i].Host)
		if spec.Exits[i].UDPPort <= 0 {
			spec.Exits[i].UDPPort = spec.Exits[i].Port
		}
		if spec.Exits[i].Key == "" {
			spec.Exits[i].Key = spec.Key
		}
	}
	return spec
}

func fxpServerSignature(spec fxpSpec) string {
	spec = normalizeFXPSpec(spec)
	parts := []string{
		spec.Role,
		strconv.Itoa(spec.TunnelID),
		strconv.Itoa(spec.RuleID),
		strconv.Itoa(spec.ListenPort),
		strconv.Itoa(spec.UDPListenPort),
		spec.Protocol,
		spec.ExitHost,
		strconv.Itoa(spec.ExitPort),
		strconv.Itoa(spec.UDPExitPort),
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
		strconv.Itoa(spec.UDPRelayExitPort),
		spec.RelayKey,
		strconv.Itoa(spec.DNSGeneration),
	}
	for _, exit := range spec.Exits {
		parts = append(parts, strings.TrimSpace(exit.Host), strconv.Itoa(exit.Port), strconv.Itoa(exit.UDPPort), strings.TrimSpace(exit.Key))
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

func fxpRuntimeProcessExistsForRulePort(ruleID int, port int) bool {
	if ruleID <= 0 || port <= 0 {
		return false
	}
	pattern := fmt.Sprintf("/run/forwardx-agent/fxp-*-*-%d-%d.json", ruleID, port)
	paths, _ := filepath.Glob(pattern)
	for _, path := range paths {
		if fxpRuntimeProcessExists(path) {
			return true
		}
	}
	return false
}

func fxpRuntimeProcessExistsForTunnelPort(tunnelID int, port int) bool {
	if tunnelID <= 0 || port <= 0 {
		return false
	}
	pattern := fmt.Sprintf("/run/forwardx-agent/fxp-*-%d-*-%d.json", tunnelID, port)
	paths, _ := filepath.Glob(pattern)
	for _, path := range paths {
		if fxpRuntimeProcessExists(path) {
			return true
		}
	}
	return false
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
	existing = normalizeFXPSpec(existing)
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
	spec = normalizeFXPSpec(spec)

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
	// When mimic is enabled, UDPListenPort (mimicPort) differs from ListenPort (TCP port).
	// fxpPortCleanupCmds matches by config filename which always ends in ListenPort, so
	// using it with mimicPort would never match. Kill the UDP port occupant directly via ss.
	if spec.UDPListenPort > 0 && spec.UDPListenPort != spec.ListenPort {
		port := strconv.Itoa(spec.UDPListenPort)
		_ = runShell("for pid in $(ss -Hlnup 'sport = :" + port + "' 2>/dev/null | " +
			"awk '{match($0,/pid=([0-9]+)/,a); if(a[1]!=\"\" && a[1]!=\"$$\" && a[1]!=\"$PPID\") print a[1]}' | sort -u || true); " +
			"do kill \"$pid\" 2>/dev/null || true; done")
	}
	if !waitForFXPListenPortFree(&spec, spec.ListenPort, 3*time.Second) {
		owner := listenPortOwnerSummary(spec.ListenPort)
		if spec.UDPListenPort > 0 && spec.UDPListenPort != spec.ListenPort {
			if udpOwner := listenPortOwnerSummary(spec.UDPListenPort); udpOwner != "" {
				owner = strings.TrimSpace(owner + " udpListen=:" + strconv.Itoa(spec.UDPListenPort) + " " + udpOwner)
			}
		}
		actionMessage.set("fxp listen port still busy role=%s tunnel=%d rule=%d listen=:%d udpListen=:%d owner=%s", spec.Role, spec.TunnelID, spec.RuleID, spec.ListenPort, spec.UDPListenPort, owner)
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
		"proxy-debug fxp config role=%s tunnel=%d rule=%d listen=%d udpListen=%d protocol=%s proxyReceive=%v proxySend=%v proxyExitReceive=%v proxyExitSend=%v tcpFastOpen=%v exit=%s:%d udpExit=%d relayNext=%s:%d udpRelayNext=%d target=%s:%d",
		spec.Role,
		spec.TunnelID,
		spec.RuleID,
		spec.ListenPort,
		spec.UDPListenPort,
		spec.Protocol,
		spec.ProxyProtocolReceive,
		spec.ProxyProtocolSend,
		spec.ProxyProtocolExitReceive,
		spec.ProxyProtocolExitSend,
		spec.TCPFastOpen,
		spec.ExitHost,
		spec.ExitPort,
		spec.UDPExitPort,
		spec.RelayExitHost,
		spec.RelayExitPort,
		spec.UDPRelayExitPort,
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
	spec = normalizeFXPSpec(spec)
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
	normalized := normalizeFXPSpec(*spec)
	protos := runtimeProtocols(normalized.Protocol)
	if len(protos) == 0 {
		protos = []string{"tcp"}
	}
	deadline := time.Now().Add(timeout)
	for {
		busy := false
		checked := map[string]bool{}
		for _, proto := range protos {
			port := listenPort
			if proto == "udp" {
				port = normalized.UDPListenPort
			} else if normalized.ListenPort > 0 {
				port = normalized.ListenPort
			}
			key := proto + ":" + strconv.Itoa(port)
			if checked[key] {
				continue
			}
			checked[key] = true
			if listenPortBusy(proto, port) {
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

func actionPortProtocolKey(port int, protocol string) string {
	if !validActionPort(port) {
		return ""
	}
	return fmt.Sprintf("%d:%s", port, normalizeRuntimeProtocol(protocol))
}

func runningRuleIDPortKey(ruleID int, port int) string {
	if ruleID <= 0 || !validActionPort(port) {
		return ""
	}
	return fmt.Sprintf("%d:%d", ruleID, port)
}

func protectedActionMatchesPort(protectedPorts map[string]bool, port string, protocol string) bool {
	if len(protectedPorts) == 0 || strings.TrimSpace(port) == "" {
		return false
	}
	if protectedPorts[port] {
		return true
	}
	portNumber := atoi(port)
	if portNumber <= 0 {
		return false
	}
	normalized := normalizeRuntimeProtocol(protocol)
	if protectedPorts[actionPortProtocolKey(portNumber, normalized)] || protectedPorts[actionPortProtocolKey(portNumber, "both")] {
		return true
	}
	if normalized == "both" {
		return protectedPorts[actionPortProtocolKey(portNumber, "tcp")] || protectedPorts[actionPortProtocolKey(portNumber, "udp")]
	}
	return false
}

func normalizeRuntimeProtocol(protocol string) string {
	value := strings.ToLower(strings.TrimSpace(protocol))
	compact := strings.NewReplacer(" ", "", "\t", "", "_", "", "+", "", "-", "", "/", "").Replace(value)
	switch {
	case value == "udp":
		return "udp"
	case value == "both" || compact == "tcpudp" || compact == "udptcp" || compact == "tcpandudp" || compact == "udpandtcp":
		return "both"
	default:
		return "tcp"
	}
}

type protocolGuardServer struct {
	rule     guardRule
	tcpLn    net.Listener
	udpConn  net.PacketConn
	done     chan struct{}
	doneOnce sync.Once
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
		strconv.Itoa(rule.BackendPort),
		strings.TrimSpace(rule.BackendForwardType),
		normalizeRuntimeProtocol(rule.Protocol),
		strconv.FormatBool(rule.Policy.BlockHTTP),
		strconv.FormatBool(rule.Policy.BlockSocks),
		strconv.FormatBool(rule.Policy.BlockTLS),
		strconv.FormatBool(rule.ProxyProtocolReceive),
		strconv.FormatBool(rule.ProxyProtocolSend),
		strconv.Itoa(normalizeProxyProtocolVersion(rule.ProxyProtocolVersion)),
	}, "|")
}

func guardTCPEnabled(rule guardRule) bool {
	return normalizeRuntimeProtocol(rule.Protocol) != "udp"
}

func guardUDPEnabled(rule guardRule) bool {
	return normalizeRuntimeProtocol(rule.Protocol) != "tcp"
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
	prepareProtocolGuardPort(rule)
	server := &protocolGuardServer{rule: rule, done: make(chan struct{})}
	if guardTCPEnabled(rule) {
		ln, err := net.Listen("tcp", ":"+strconv.Itoa(rule.ListenPort))
		if err != nil {
			logf("protocol guard tcp listen failed rule=%d port=%d: %v", rule.RuleID, rule.ListenPort, err)
			return
		}
		server.tcpLn = ln
	}
	if guardUDPEnabled(rule) {
		conn, err := net.ListenPacket("udp", ":"+strconv.Itoa(rule.ListenPort))
		if err != nil {
			if server.tcpLn != nil {
				_ = server.tcpLn.Close()
			}
			logf("protocol guard udp listen failed rule=%d port=%d: %v", rule.RuleID, rule.ListenPort, err)
			return
		}
		server.udpConn = conn
	}
	if server.tcpLn == nil && server.udpConn == nil {
		logf("protocol guard no protocol enabled rule=%d port=%d protocol=%s", rule.RuleID, rule.ListenPort, rule.Protocol)
		return
	}
	protocolGuardMu.Lock()
	protocolGuards[guardID(rule)] = server
	protocolGuardMu.Unlock()
	if server.tcpLn != nil {
		go server.serveTCP(cfg)
	}
	if server.udpConn != nil {
		go server.serveUDP()
	}
	logf("protocol guard started rule=%d tunnel=%d listen=:%d protocol=%s target=%s:%d proxyReceive=%v proxySend=%v proxyVersion=%d", rule.RuleID, rule.TunnelID, rule.ListenPort, normalizeRuntimeProtocol(rule.Protocol), rule.TargetIP, rule.TargetPort, rule.ProxyProtocolReceive, rule.ProxyProtocolSend, normalizeProxyProtocolVersion(rule.ProxyProtocolVersion))
}

func prepareProtocolGuardPort(rule guardRule) {
	if rule.ListenPort <= 0 {
		return
	}
	port := strconv.Itoa(rule.ListenPort)
	stopFXPByListenPort(rule.ListenPort)
	backendPort := rule.BackendPort
	if backendPort <= 0 {
		backendPort = rule.TargetPort
	}
	if backendPort != rule.ListenPort {
		cleanupGostRuntimeIfPortBusy(rule.ListenPort)
	}
	for _, cmd := range managedListenerCleanupCmds(port) {
		_ = runShell(cmd)
	}
	backendType := strings.TrimSpace(rule.BackendForwardType)
	if backendType == "" || backendPort == rule.ListenPort {
		for _, name := range []string{
			"forwardx-socat-" + port,
			"forwardx-socat-tcp-" + port,
			"forwardx-socat-udp-" + port,
			"forwardx-realm-" + port,
		} {
			_ = runShell(managedServiceCleanupShell(name))
		}
		_ = runShell("rm -f /etc/forwardx/realm/forwardx-realm-" + port + ".toml /etc/forwardx/realm/forwardx-realm-" + port + ".toml.sha256 2>/dev/null || true")
	}
	if backendType != "nginx" || backendPort == rule.ListenPort {
		_ = runShell(managedNginxCleanupShell(port))
	}
	_ = runShell(nftPortCleanupCmd(port, "both"))
	for _, binary := range iptablesAgentBinaries() {
		_ = runShell(iptablesAgentDeleteDnatRulesForPort(binary, port, "both"))
	}
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
	server.close()
	logf("protocol guard stopped rule=%d port=%d", server.rule.RuleID, server.rule.ListenPort)
}

func (s *protocolGuardServer) close() {
	s.doneOnce.Do(func() {
		close(s.done)
		if s.tcpLn != nil {
			_ = s.tcpLn.Close()
		}
		if s.udpConn != nil {
			_ = s.udpConn.Close()
		}
	})
}

func (s *protocolGuardServer) serveTCP(cfg Config) {
	for {
		conn, err := s.tcpLn.Accept()
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
	proxyInfo := proxyProtocolInfoFromConn(client)
	first := []byte(nil)
	if s.rule.ProxyProtocolReceive {
		_ = client.SetReadDeadline(time.Now().Add(5 * time.Second))
		buf := make([]byte, 4096)
		n, err := client.Read(buf)
		_ = client.SetReadDeadline(time.Time{})
		if err != nil {
			return
		}
		if n > 0 {
			first = append(first, buf[:n]...)
		}
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
	errCh := make(chan error, 2)
	go func() { errCh <- s.copyTCPToTargetWithGuard(cfg, client, target, first) }()
	go func() { _, err := io.Copy(client, target); errCh <- err }()
	<-errCh
}

func (s *protocolGuardServer) copyTCPToTargetWithGuard(cfg Config, client net.Conn, target net.Conn, initial []byte) error {
	sample := make([]byte, 0, protocolGuardSampleMaxBytes)
	firstData := true
	inspect := func(chunk []byte) (string, bool) {
		if !s.rule.Policy.enabled() || len(chunk) == 0 || len(sample) >= protocolGuardSampleMaxBytes {
			return "", false
		}
		remaining := protocolGuardSampleMaxBytes - len(sample)
		if remaining > len(chunk) {
			remaining = len(chunk)
		}
		sample = append(sample, chunk[:remaining]...)
		proto := detectBlockedProtocol(sample, s.rule.Policy)
		return proto, proto != ""
	}
	writeChunk := func(chunk []byte) error {
		if len(chunk) == 0 {
			return nil
		}
		if firstData {
			firstData = false
			if _, err := target.Write(chunk); err != nil {
				return err
			}
			if proto, blocked := inspect(chunk); blocked {
				go reportProtocolBlock(cfg, s.rule, proto)
				return fmt.Errorf("protocol blocked: %s", proto)
			}
			return nil
		}
		if proto, blocked := inspect(chunk); blocked {
			go reportProtocolBlock(cfg, s.rule, proto)
			return fmt.Errorf("protocol blocked: %s", proto)
		}
		_, err := target.Write(chunk)
		return err
	}
	if err := writeChunk(initial); err != nil {
		return err
	}
	buf := make([]byte, 32*1024)
	for {
		n, err := client.Read(buf)
		if n > 0 {
			if writeErr := writeChunk(buf[:n]); writeErr != nil {
				return writeErr
			}
		}
		if err != nil {
			return err
		}
	}
}

type protocolGuardUDPSession struct {
	target net.Conn
	last   time.Time
}

func (s *protocolGuardServer) serveUDP() {
	sessions := map[string]*protocolGuardUDPSession{}
	var sessionMu sync.Mutex
	closeSessions := func() {
		sessionMu.Lock()
		defer sessionMu.Unlock()
		for key, session := range sessions {
			_ = session.target.Close()
			delete(sessions, key)
		}
	}
	cleanupTicker := time.NewTicker(30 * time.Second)
	stopCleanup := make(chan struct{})
	defer func() {
		close(stopCleanup)
		cleanupTicker.Stop()
		closeSessions()
	}()
	go func() {
		for {
			select {
			case <-s.done:
				closeSessions()
				return
			case <-stopCleanup:
				return
			case <-cleanupTicker.C:
				now := time.Now()
				sessionMu.Lock()
				for key, session := range sessions {
					if now.Sub(session.last) <= protocolGuardUDPIdleTimeout {
						continue
					}
					_ = session.target.Close()
					delete(sessions, key)
				}
				sessionMu.Unlock()
			}
		}
	}()

	buf := make([]byte, 65535)
	for {
		n, clientAddr, err := s.udpConn.ReadFrom(buf)
		if err != nil {
			select {
			case <-s.done:
				return
			default:
				logf("protocol guard udp read rule=%d: %v", s.rule.RuleID, err)
				return
			}
		}
		if n <= 0 || clientAddr == nil {
			continue
		}
		packet := append([]byte(nil), buf[:n]...)
		key := clientAddr.String()
		sessionMu.Lock()
		session := sessions[key]
		if session == nil {
			target, err := net.DialTimeout("udp", net.JoinHostPort(s.rule.TargetIP, strconv.Itoa(s.rule.TargetPort)), 10*time.Second)
			if err != nil {
				sessionMu.Unlock()
				if shouldLogAgentReport(fmt.Sprintf("protocol-guard-udp-dial:%d", s.rule.RuleID), agentReportLogInterval) {
					logf("protocol guard udp dial target rule=%d: %v", s.rule.RuleID, err)
				}
				continue
			}
			session = &protocolGuardUDPSession{target: target, last: time.Now()}
			sessions[key] = session
			go s.copyUDPToClient(key, clientAddr, target, sessions, &sessionMu)
		}
		session.last = time.Now()
		target := session.target
		sessionMu.Unlock()
		if _, err := target.Write(packet); err != nil {
			sessionMu.Lock()
			if sessions[key] == session {
				delete(sessions, key)
			}
			sessionMu.Unlock()
			_ = target.Close()
			if shouldLogAgentReport(fmt.Sprintf("protocol-guard-udp-write:%d", s.rule.RuleID), agentReportLogInterval) {
				logf("protocol guard udp write target rule=%d client=%s: %v", s.rule.RuleID, key, err)
			}
		}
	}
}

func (s *protocolGuardServer) copyUDPToClient(key string, clientAddr net.Addr, target net.Conn, sessions map[string]*protocolGuardUDPSession, sessionMu *sync.Mutex) {
	buf := make([]byte, 65535)
	for {
		_ = target.SetReadDeadline(time.Now().Add(protocolGuardUDPIdleTimeout))
		n, err := target.Read(buf)
		if err != nil {
			break
		}
		if n > 0 {
			_, _ = s.udpConn.WriteTo(buf[:n], clientAddr)
		}
		sessionMu.Lock()
		if session := sessions[key]; session != nil && session.target == target {
			session.last = time.Now()
		}
		sessionMu.Unlock()
	}
	sessionMu.Lock()
	if session := sessions[key]; session != nil && session.target == target {
		delete(sessions, key)
	}
	sessionMu.Unlock()
	_ = target.Close()
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
	if len(data) < 4 {
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
		if isTransientAgentCommError(err) {
			logAgentCommError("protocol-block", err)
		} else {
			logf("protocol block report failed rule=%d protocol=%s: %v", rule.RuleID, proto, err)
		}
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
		if isTransientAgentCommError(err) {
			logAgentCommError("post:"+path, err)
		} else if shouldLogAgentReport("post-error:"+path, agentReportLogInterval) {
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
		return fmt.Errorf("%s: %s", res.Status, formatPanelErrorBody(decodedBody))
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

func formatPanelErrorBody(body []byte) string {
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		return ""
	}
	var panelErr panelErrorResp
	if err := json.Unmarshal(body, &panelErr); err != nil {
		return trimmed
	}
	parts := make([]string, 0, 3)
	if panelErr.Error != "" {
		parts = append(parts, panelErr.Error)
	}
	if panelErr.Message != "" && panelErr.Message != panelErr.Error {
		parts = append(parts, panelErr.Message)
	}
	if panelErr.Hint != "" {
		parts = append(parts, "提示: "+panelErr.Hint)
	}
	if len(parts) == 0 {
		return trimmed
	}
	return strings.Join(parts, "；")
}

func logAgentCommError(scope string, err error) {
	if err == nil {
		return
	}
	scope = strings.TrimSpace(scope)
	if scope == "" {
		scope = "unknown"
	}
	if isTransientAgentCommError(err) {
		if shouldLogAgentReport("agent-comm-transient:"+scope, transientAgentCommLogInterval) {
			logf("agent communication temporary issue scope=%s; will retry: %v", scope, err)
		}
		return
	}
	if shouldLogAgentReport("agent-comm-error:"+scope, agentReportLogInterval) {
		logf("agent communication error scope=%s: %v", scope, err)
	}
}

func isTransientAgentCommError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(strings.TrimSpace(err.Error()))
	if msg == "" {
		return false
	}
	permanentMarkers := []string{
		"400 bad request",
		"401 unauthorized",
		"403 forbidden",
		"mac verification failed",
		"invalid encrypted request",
		"decryption failed",
	}
	for _, marker := range permanentMarkers {
		if strings.Contains(msg, marker) {
			return false
		}
	}
	transientMarkers := []string{
		"520",
		"502 bad gateway",
		"503 service unavailable",
		"504 gateway timeout",
		"internal_error",
		"stream error",
		"connection reset",
		"connection refused",
		"connection aborted",
		"unexpected eof",
		"eof",
		"timeout",
		"temporarily unavailable",
		"tls handshake timeout",
		"no such host",
	}
	for _, marker := range transientMarkers {
		if strings.Contains(msg, marker) {
			return true
		}
	}
	return false
}

func isClockSyncCandidateError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "mac verification failed") {
		return false
	}
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
	if len(cmd) > shellInlineMaxBytes {
		logVerbosef("exec: long shell command bytes=%d via temp script", len(cmd))
	} else {
		logVerbosef("exec: %s", cmd)
	}
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), actionShellTimeout)
	defer cancel()
	c, cleanup, viaTemp, err := shellCommand(ctx, cmd)
	if err != nil {
		logf("exec failed before start err=%v %s", err, shellCommandLogSummary(cmd))
		return false
	}
	out, err := c.CombinedOutput()
	cleanup()
	retriedViaTemp := false
	if isArgumentListTooLong(err) && !viaTemp && ctx.Err() != context.DeadlineExceeded {
		logf("exec retry via temp script after argument list too long bytes=%d", len(cmd))
		c, cleanup, _, err = shellCommandTempScript(ctx, cmd)
		if err != nil {
			logf("exec failed before temp retry err=%v %s", err, shellCommandLogSummary(cmd))
			return false
		}
		retriedViaTemp = true
		viaTemp = true
		out, err = c.CombinedOutput()
		cleanup()
	}
	elapsed := time.Since(started)
	if len(out) > 0 && (err != nil || ctx.Err() == context.DeadlineExceeded || agentVerboseLogs) {
		logf("%s", strings.TrimSpace(string(out)))
	}
	if ctx.Err() == context.DeadlineExceeded {
		logf("exec timeout duration=%s temp=%v retriedTemp=%v outputBytes=%d %s", elapsed.Round(time.Millisecond), viaTemp, retriedViaTemp, len(out), shellCommandLogSummary(cmd))
		return false
	}
	if err != nil {
		logf("exec failed duration=%s temp=%v retriedTemp=%v outputBytes=%d err=%v %s", elapsed.Round(time.Millisecond), viaTemp, retriedViaTemp, len(out), err, shellCommandLogSummary(cmd))
		return false
	}
	if elapsed >= actionShellSlowThreshold {
		logf("exec slow duration=%s temp=%v retriedTemp=%v outputBytes=%d %s", elapsed.Round(time.Millisecond), viaTemp, retriedViaTemp, len(out), shellCommandLogSummary(cmd))
	}
	return true
}

func runShellQuiet(cmd string) bool {
	if strings.TrimSpace(cmd) == "" {
		return true
	}
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, cleanup, viaTemp, err := shellCommand(ctx, cmd)
	if err != nil {
		return false
	}
	err = c.Run()
	cleanup()
	retriedViaTemp := false
	if isArgumentListTooLong(err) && !viaTemp && ctx.Err() != context.DeadlineExceeded {
		c, cleanup, _, err = shellCommandTempScript(ctx, cmd)
		if err != nil {
			return false
		}
		retriedViaTemp = true
		viaTemp = true
		err = c.Run()
		cleanup()
	}
	elapsed := time.Since(started)
	ok := err == nil && ctx.Err() != context.DeadlineExceeded
	if ctx.Err() == context.DeadlineExceeded {
		logf("exec quiet timeout duration=%s temp=%v retriedTemp=%v %s", elapsed.Round(time.Millisecond), viaTemp, retriedViaTemp, shellCommandLogSummary(cmd))
	} else if elapsed >= actionShellSlowThreshold {
		logf("exec quiet slow ok=%v duration=%s temp=%v retriedTemp=%v %s", ok, elapsed.Round(time.Millisecond), viaTemp, retriedViaTemp, shellCommandLogSummary(cmd))
	}
	return ok
}

func runShellBatch(commands []string) bool {
	filtered := make([]string, 0, len(commands))
	for _, cmd := range commands {
		if strings.TrimSpace(cmd) != "" {
			filtered = append(filtered, cmd)
		}
	}
	if len(filtered) == 0 {
		return true
	}
	if len(filtered) == 1 {
		return runShell(filtered[0])
	}
	var script strings.Builder
	script.WriteString("set +e\n")
	script.WriteString("__forwardx_status=0\n")
	for _, cmd := range filtered {
		script.WriteString("(\n")
		script.WriteString(cmd)
		script.WriteString("\n) || __forwardx_status=1\n")
	}
	script.WriteString("exit $__forwardx_status\n")
	return runShell(script.String())
}

func isArgumentListTooLong(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "argument list too long")
}

func shellCommandLogSummary(cmd string) string {
	h := fnv.New64a()
	_, _ = h.Write([]byte(cmd))
	return fmt.Sprintf("cmdHash=%016x cmdBytes=%d", h.Sum64(), len(cmd))
}

func shellCommand(ctx context.Context, cmd string) (*exec.Cmd, func(), bool, error) {
	if len(cmd) <= shellInlineMaxBytes {
		return exec.CommandContext(ctx, "sh", "-lc", cmd), func() {}, false, nil
	}
	return shellCommandTempScript(ctx, cmd)
}

func shellCommandTempScript(ctx context.Context, cmd string) (*exec.Cmd, func(), bool, error) {
	dir := filepath.Join(os.TempDir(), "forwardx-agent")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, func() {}, true, err
	}
	file, err := os.CreateTemp(dir, "shell-*.sh")
	if err != nil {
		return nil, func() {}, true, err
	}
	path := file.Name()
	cleanup := func() {
		_ = os.Remove(path)
	}
	if _, err := file.WriteString("#!/bin/sh\n" + cmd + "\n"); err != nil {
		_ = file.Close()
		cleanup()
		return nil, func() {}, true, err
	}
	if err := file.Close(); err != nil {
		cleanup()
		return nil, func() {}, true, err
	}
	if err := os.Chmod(path, 0700); err != nil {
		cleanup()
		return nil, func() {}, true, err
	}
	return exec.CommandContext(ctx, "sh", path), cleanup, true, nil
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

type cpuTimes struct {
	Idle  uint64
	Total uint64
}

func cpuUsage() int {
	current, ok := readCPUTimes()
	if !ok {
		return cpuLoadAveragePercentFallback()
	}
	cpuUsageMu.Lock()
	ready := previousCPUReady
	if !ready {
		previousCPUTimes = current
		previousCPUReady = true
	}
	cpuUsageMu.Unlock()
	if !ready {
		time.Sleep(200 * time.Millisecond)
		if next, ok := readCPUTimes(); ok {
			current = next
		}
	}
	return cpuUsageFromTimes(current)
}

func cpuUsageFromTimes(current cpuTimes) int {
	cpuUsageMu.Lock()
	defer cpuUsageMu.Unlock()
	previous := previousCPUTimes
	previousCPUTimes = current
	previousCPUReady = true
	if current.Total <= previous.Total {
		return 0
	}
	totalDelta := current.Total - previous.Total
	idleDelta := uint64(0)
	if current.Idle > previous.Idle {
		idleDelta = current.Idle - previous.Idle
	}
	if idleDelta >= totalDelta {
		return 0
	}
	busyDelta := totalDelta - idleDelta
	usage := int((busyDelta*100 + totalDelta/2) / totalDelta)
	if usage < 0 {
		return 0
	}
	if usage > 100 {
		return 100
	}
	return usage
}

func readCPUTimes() (cpuTimes, bool) {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return cpuTimes{}, false
	}
	for _, line := range strings.Split(string(b), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 5 || fields[0] != "cpu" {
			continue
		}
		values := make([]uint64, 0, len(fields)-1)
		for _, field := range fields[1:] {
			value, err := strconv.ParseUint(field, 10, 64)
			if err != nil {
				value = 0
			}
			values = append(values, value)
		}
		total := uint64(0)
		for _, value := range values {
			total += value
		}
		idle := values[3]
		if len(values) > 4 {
			idle += values[4]
		}
		if total == 0 {
			return cpuTimes{}, false
		}
		return cpuTimes{Idle: idle, Total: total}, true
	}
	return cpuTimes{}, false
}

func cpuLoadAveragePercentFallback() int {
	b, _ := os.ReadFile("/proc/loadavg")
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	cores := runtime.NumCPU()
	if cores <= 0 {
		cores = 1
	}
	usage := int((v/float64(cores))*100 + 0.5)
	if usage < 0 {
		return 0
	}
	if usage > 100 {
		return 100
	}
	return usage
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

func diskStats() (usage int, used uint64, total uint64) {
	out, err := exec.Command("sh", "-lc", `df -P -B1 / | awk 'NR==2 {gsub("%","",$5); print $5, $3, $2}'`).Output()
	if err != nil {
		return 0, 0, 0
	}
	fields := strings.Fields(string(out))
	if len(fields) >= 1 {
		usage, _ = strconv.Atoi(fields[0])
	}
	if len(fields) >= 2 {
		used, _ = strconv.ParseUint(fields[1], 10, 64)
	}
	if len(fields) >= 3 {
		total, _ = strconv.ParseUint(fields[2], 10, 64)
	}
	return usage, used, total
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'"
}

func shouldLogAgentReport(key string, interval time.Duration) bool {
	now := time.Now()
	agentReportLogMu.Lock()
	defer agentReportLogMu.Unlock()
	pruneTimeMapLocked(agentReportLogAt, now, agentMemoryCacheRetention, agentReportLogMaxKeys)
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

func pruneAgentRuntimeData() {
	pruneAgentLocalLogs()
	pruneAgentMemoryCaches()
}

func pruneAgentLocalLogs() {
	agentLogMu.Lock()
	defer agentLogMu.Unlock()
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
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return
	}
	if info.Size() > agentLogMaxBytes {
		trimLogFileTail(path, agentLogTailBytes)
	}
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
	if changed {
		if len(retained) == 0 {
			_ = os.WriteFile(path, nil, 0644)
		} else {
			_ = os.WriteFile(path, []byte(strings.Join(retained, "\n")+"\n"), 0644)
		}
	}
	if info, err := os.Stat(path); err == nil && !info.IsDir() && info.Size() > agentLogMaxBytes {
		trimLogFileTail(path, agentLogTailBytes)
	}
}

func trimLogFileTail(path string, keepBytes int64) {
	if keepBytes <= 0 || keepBytes > int64(int(keepBytes)) {
		return
	}
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() || info.Size() <= keepBytes {
		return
	}
	buf := make([]byte, int(keepBytes))
	n, err := f.ReadAt(buf, info.Size()-keepBytes)
	if err != nil && err != io.EOF {
		return
	}
	data := buf[:n]
	if idx := bytes.IndexByte(data, '\n'); idx >= 0 && idx+1 < len(data) {
		data = data[idx+1:]
	}
	_ = os.WriteFile(path, data, 0644)
}

func pruneAgentMemoryCaches() {
	now := time.Now()
	if !agentMemoryPrunedAt.IsZero() && now.Sub(agentMemoryPrunedAt) < time.Hour {
		return
	}
	agentMemoryPrunedAt = now
	agentReportLogMu.Lock()
	pruneTimeMapLocked(agentReportLogAt, now, agentMemoryCacheRetention, agentReportLogMaxKeys)
	agentReportLogMu.Unlock()
	actionEpochMu.Lock()
	pruneIssuedAtMapLocked(latestActionIssuedAt, now, agentMemoryCacheRetention)
	actionEpochMu.Unlock()
	countingChainMu.Lock()
	pruneTimeMapLocked(countingChainCheckedAt, now, agentMemoryCacheRetention, 0)
	for key := range countingChainSignatures {
		if _, ok := countingChainCheckedAt[key]; !ok {
			delete(countingChainSignatures, key)
		}
	}
	countingChainMu.Unlock()
	runtimeActionMu.Lock()
	for key, state := range runtimeActionCache {
		if state.CheckedAt.IsZero() || now.Sub(state.CheckedAt) > agentMemoryCacheRetention {
			delete(runtimeActionCache, key)
		}
	}
	runtimeActionMu.Unlock()
}

func pruneTimeMapLocked(values map[string]time.Time, now time.Time, maxAge time.Duration, maxKeys int) {
	if len(values) == 0 {
		return
	}
	for key, seenAt := range values {
		if seenAt.IsZero() || now.Sub(seenAt) > maxAge {
			delete(values, key)
		}
	}
	if maxKeys <= 0 || len(values) <= maxKeys {
		return
	}
	type entry struct {
		key string
		at  time.Time
	}
	entries := make([]entry, 0, len(values))
	for key, seenAt := range values {
		entries = append(entries, entry{key: key, at: seenAt})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].at.Before(entries[j].at) })
	for i := 0; i < len(entries)-maxKeys; i++ {
		delete(values, entries[i].key)
	}
}

func pruneIssuedAtMapLocked(values map[string]int64, now time.Time, maxAge time.Duration) {
	for key, issuedAt := range values {
		at := unixMillisOrSecondsTime(issuedAt)
		if at.IsZero() || now.Sub(at) > maxAge {
			delete(values, key)
		}
	}
}

func unixMillisOrSecondsTime(value int64) time.Time {
	if value <= 0 {
		return time.Time{}
	}
	if value > 1_000_000_000_000 {
		return time.UnixMilli(value)
	}
	return time.Unix(value, 0)
}

func fatal(format string, args ...any) {
	logf(format, args...)
	os.Exit(1)
}
