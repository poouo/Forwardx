package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	agentStateDir              = "/var/lib/forwardx-agent"
	tcpingRuleBatchSize        = 24
	tcpingProbeBatchSize       = 12
	tcpingMaxConcurrency       = 32
	tcpingProbeTimeout         = 2 * time.Second
	tcpingWireGuardTimeout     = 8 * time.Second
	tcpingPingProbeCount       = 5
	systemPingConcurrency      = 8
	networkTargetDNSTTL        = 30 * time.Second
	networkTargetDNSFailureTTL = 5 * time.Second
	activeTrafficReportEvery   = 10 * time.Second
	steadyTrafficReportEvery   = 30 * time.Second
	idleHostTrafficReportEvery = 5 * time.Minute
)

var (
	tcpingCursorMu           sync.Mutex
	tcpingRuleCursor         int
	tcpingTunnelCursor       int
	tcpingForwardGroupCursor int
	tcpingServiceCursor      int
	tcpingCollectRunning     int32
	systemPingSlots          = make(chan struct{}, systemPingConcurrency)
	networkTargetDNSMu       sync.Mutex
	networkTargetDNSCache    = map[string]networkTargetDNSCacheEntry{}
	networkTargetDNSCalls    = map[string]*networkTargetDNSCall{}
	lookupNetworkTargetIPs   = net.DefaultResolver.LookupIPAddr
	dialNetworkTimeout       = net.DialTimeout
	trafficPrevMu            sync.Mutex
	trafficPrevCache         = map[string]trafficPrevState{}
	trafficStateDir          = agentStateDir
	lastRuleTrafficReportAt  time.Time
	lastHostTrafficReportAt  time.Time
	activeTrafficReportNanos atomic.Int64
	trafficReportSequence    atomic.Uint64
)

const (
	pendingTrafficReportFile  = "traffic_report.pending"
	trafficReportIdentityFile = "traffic_report.identity"
)

type networkTargetDNSCacheEntry struct {
	addresses []string
	expiresAt time.Time
}

type networkTargetDNSCall struct {
	done      chan struct{}
	addresses []string
}

type localRuleState struct {
	Port        string
	RuleID      int
	TunnelID    int
	ForwardType string
	TargetIP    string
	TargetPort  int
	Protocol    string
}

type trafficCounters struct {
	In  uint64
	Out uint64
}

func shouldCollectRuleTraffic(state localRuleState) bool {
	if state.RuleID <= 0 {
		return false
	}
	// ForwardX entry runtimes report payload bytes themselves. Sampling their
	// listener mangle counters as well would account the same traffic twice.
	return !strings.EqualFold(strings.TrimSpace(state.ForwardType), "forwardx")
}

// maxTrafficCounters merges two counter samples for the same port by keeping the
// larger value per direction. Counters are monotonic byte totals, so the larger
// sample is the one whose chain actually matched the traffic.
func maxTrafficCounters(left trafficCounters, right trafficCounters) trafficCounters {
	merged := left
	if right.In > merged.In {
		merged.In = right.In
	}
	if right.Out > merged.Out {
		merged.Out = right.Out
	}
	return merged
}

type trafficDiagnosticsSnapshot struct {
	iptablesMarkers   map[string]bool
	ip6tablesMarkers  map[string]bool
	nftMarkers        map[int]bool
	nftProcessMarkers map[string]bool
}

type trafficPrevState struct {
	ruleID int
	in     uint64
	out    uint64
	conns  uint64
}

type trafficBaselineUpdate struct {
	port  string
	state trafficPrevState
}

type persistedTrafficBaseline struct {
	Port   string `json:"port"`
	RuleID int    `json:"ruleId"`
	In     uint64 `json:"in"`
	Out    uint64 `json:"out"`
	Conns  uint64 `json:"conns"`
}

type pendingTrafficReport struct {
	Payload        map[string]any             `json:"payload"`
	Baselines      []persistedTrafficBaseline `json:"baselines,omitempty"`
	Identity       string                     `json:"identity"`
	HasRuleTraffic bool                       `json:"hasRuleTraffic"`
	HasHostTraffic bool                       `json:"hasHostTraffic"`
	StatCount      int                        `json:"statCount"`
}

type tcpingTask struct {
	Kind            string
	RuleID          int
	TunnelID        int
	GroupID         int
	MemberID        int
	ProbeType       string
	ServiceID       int
	Method          string
	TargetIP        string
	TargetPort      int
	HopIndex        int
	HopCount        int
	SeriesKey       string
	SeriesLabel     string
	WireGuardPeerID string
	SourcePort      int
	ProbeKey        string
	TopologyKey     string
}

type tcpingTaskResult struct {
	Kind    string
	Payload map[string]any
}

func compactTrafficStat(stat map[string]any) []any {
	return []any{
		stat["ruleId"],
		stat["bytesIn"],
		stat["bytesOut"],
		stat["connections"],
	}
}

func hostTrafficSnapshot() map[string]any {
	return map[string]any{
		"bytesIn":  netBytes(0),
		"bytesOut": netBytes(1),
	}
}

func newTrafficReportID() string {
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err == nil {
		return "agent-" + hex.EncodeToString(nonce)
	}
	// Keep collection available on systems whose entropy source is temporarily
	// unavailable. The process-local sequence prevents same-tick collisions.
	return fmt.Sprintf("agent-%x-%x", time.Now().UnixNano(), trafficReportSequence.Add(1))
}

func trafficReportProducerID(identity string) string {
	return "agent-" + strings.TrimSpace(identity)
}

func pendingTrafficReportPath() string {
	return trafficStateDir + "/" + pendingTrafficReportFile
}

func trafficReportIdentity(cfg Config) string {
	return trafficReportIdentityForPanel(cfg, currentPanelURL(cfg))
}

func trafficReportIdentityForPanel(cfg Config, panelURL string) string {
	panelURL = strings.TrimRight(strings.TrimSpace(panelURL), "/")
	// Authentication and encryption use the exact configured token bytes.
	// Identity ownership must use the same semantics.
	hash := sha256.Sum256([]byte(panelURL + "\x00" + cfg.Token))
	return hex.EncodeToString(hash[:])
}

func writeTrafficStateFile(path string, data []byte, mode os.FileMode) error {
	if err := ensureTrafficStateDirectoryDurable(trafficStateDir); err != nil {
		return err
	}
	if err := os.MkdirAll(trafficStateDir, 0755); err != nil {
		return err
	}
	file, err := os.CreateTemp(trafficStateDir, ".traffic-state-*")
	if err != nil {
		return err
	}
	tmp := file.Name()
	cleanup := func() {
		_ = file.Close()
		_ = os.Remove(tmp)
	}
	if err := file.Chmod(mode); err != nil {
		cleanup()
		return err
	}
	if _, err := file.Write(data); err != nil {
		cleanup()
		return err
	}
	if err := file.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := replaceTrafficStateFile(tmp, path, trafficStateDir); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func ensureTrafficReportIdentity(identity string) error {
	if strings.TrimSpace(identity) == "" {
		return fmt.Errorf("traffic report identity is empty")
	}
	if err := ensureTrafficStateDirectoryDurable(trafficStateDir); err != nil {
		return err
	}
	path := trafficStateDir + "/" + trafficReportIdentityFile
	raw, err := os.ReadFile(path)
	if err == nil && strings.TrimSpace(string(raw)) == identity {
		return nil
	}
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	// An absent identity is legacy state with unknown ownership. Clearing its
	// baselines is conservative, but prevents a simultaneous Panel/token change
	// during upgrade from attributing old traffic to the new identity.
	if err == nil || os.IsNotExist(err) {
		if clearErr := clearTrafficBaselinesForIdentityChange(); clearErr != nil {
			return clearErr
		}
	}
	return writeTrafficStateFile(path, []byte(identity+"\n"), 0600)
}

func trafficReportString(payload map[string]any, field string) (string, bool) {
	value, ok := payload[field].(string)
	if !ok || value == "" || value != strings.TrimSpace(value) {
		return "", false
	}
	return value, true
}

func trafficReportSlice(value any) ([]any, bool) {
	switch typed := value.(type) {
	case []any:
		return typed, true
	case [][]any:
		result := make([]any, len(typed))
		for index := range typed {
			result[index] = typed[index]
		}
		return result, true
	case []map[string]any:
		result := make([]any, len(typed))
		for index := range typed {
			result[index] = typed[index]
		}
		return result, true
	default:
		return nil, false
	}
}

func trafficReportInteger(value any) (int, bool) {
	var number int64
	switch typed := value.(type) {
	case int:
		return typed, typed > 0
	case int32:
		number = int64(typed)
	case int64:
		number = typed
	case uint:
		if uint64(typed) > uint64(^uint(0)>>1) {
			return 0, false
		}
		return int(typed), typed > 0
	case uint32:
		number = int64(typed)
	case uint64:
		if typed > uint64(^uint(0)>>1) {
			return 0, false
		}
		return int(typed), typed > 0
	case float64:
		if typed <= 0 || typed != math.Trunc(typed) {
			return 0, false
		}
		parsed, err := strconv.ParseInt(strconv.FormatFloat(typed, 'f', -1, 64), 10, strconv.IntSize)
		return int(parsed), err == nil
	case json.Number:
		parsed, err := strconv.ParseInt(typed.String(), 10, 64)
		if err != nil {
			return 0, false
		}
		number = parsed
	default:
		return 0, false
	}
	if number <= 0 || (strconv.IntSize == 32 && number > math.MaxInt32) {
		return 0, false
	}
	return int(number), true
}

func trafficReportUint(value any) (uint64, bool) {
	switch typed := value.(type) {
	case uint64:
		return typed, true
	case uint:
		return uint64(typed), true
	case uint32:
		return uint64(typed), true
	case int:
		return uint64(typed), typed >= 0
	case int32:
		return uint64(typed), typed >= 0
	case int64:
		return uint64(typed), typed >= 0
	case float64:
		if typed < 0 || typed != math.Trunc(typed) {
			return 0, false
		}
		parsed, err := strconv.ParseUint(strconv.FormatFloat(typed, 'f', -1, 64), 10, 64)
		return parsed, err == nil
	case json.Number:
		parsed, err := strconv.ParseUint(typed.String(), 10, 64)
		return parsed, err == nil
	default:
		return 0, false
	}
}

func validateTrafficReportNumbers(values ...any) bool {
	for _, value := range values {
		if _, ok := trafficReportUint(value); !ok {
			return false
		}
	}
	return true
}

func pendingTrafficPayloadSummary(payload map[string]any) ([]int, bool, error) {
	objectStats, hasObjectStats := payload["stats"]
	compactStats, hasCompactStats := payload["s"]
	if hasObjectStats == hasCompactStats {
		return nil, false, fmt.Errorf("traffic report must contain exactly one stats representation")
	}

	ruleIDs := []int{}
	if hasObjectStats {
		rows, ok := trafficReportSlice(objectStats)
		if !ok {
			return nil, false, fmt.Errorf("traffic report stats is not an array")
		}
		for _, rawRow := range rows {
			row, ok := rawRow.(map[string]any)
			if !ok {
				return nil, false, fmt.Errorf("traffic report stats contains an invalid row")
			}
			ruleID, ok := trafficReportInteger(row["ruleId"])
			if !ok || !validateTrafficReportNumbers(row["bytesIn"], row["bytesOut"], row["connections"]) {
				return nil, false, fmt.Errorf("traffic report stats contains invalid counters")
			}
			ruleIDs = append(ruleIDs, ruleID)
		}
		if _, exists := payload["h"]; exists {
			return nil, false, fmt.Errorf("traffic report mixes compact and object host traffic")
		}
		host, hasHost := payload["hostTraffic"]
		if hasHost {
			values, ok := host.(map[string]any)
			if !ok || !validateTrafficReportNumbers(values["bytesIn"], values["bytesOut"]) {
				return nil, false, fmt.Errorf("traffic report host traffic is invalid")
			}
		}
		return ruleIDs, hasHost, nil
	}

	rows, ok := trafficReportSlice(compactStats)
	if !ok {
		return nil, false, fmt.Errorf("traffic report compact stats is not an array")
	}
	for _, rawRow := range rows {
		row, ok := trafficReportSlice(rawRow)
		if !ok || len(row) != 4 {
			return nil, false, fmt.Errorf("traffic report compact stats contains an invalid row")
		}
		ruleID, ok := trafficReportInteger(row[0])
		if !ok || !validateTrafficReportNumbers(row[1], row[2], row[3]) {
			return nil, false, fmt.Errorf("traffic report compact stats contains invalid counters")
		}
		ruleIDs = append(ruleIDs, ruleID)
	}
	if _, exists := payload["hostTraffic"]; exists {
		return nil, false, fmt.Errorf("traffic report mixes object and compact host traffic")
	}
	host, hasHost := payload["h"]
	if hasHost {
		values, ok := trafficReportSlice(host)
		if !ok || len(values) != 2 || !validateTrafficReportNumbers(values...) {
			return nil, false, fmt.Errorf("traffic report compact host traffic is invalid")
		}
	}
	return ruleIDs, hasHost, nil
}

func validatePendingTrafficReport(report pendingTrafficReport) error {
	identity := report.Identity
	decodedIdentity, err := hex.DecodeString(identity)
	if err != nil || len(decodedIdentity) != sha256.Size || identity != strings.ToLower(identity) {
		return fmt.Errorf("traffic report identity is invalid")
	}
	reportID, ok := trafficReportString(report.Payload, "reportId")
	if !ok || len(reportID) > 128 {
		return fmt.Errorf("traffic report id is invalid")
	}
	producerID, ok := trafficReportString(report.Payload, "reportProducerId")
	if !ok || len(producerID) > 128 || producerID != trafficReportProducerID(identity) {
		return fmt.Errorf("traffic report producer id is invalid")
	}
	ruleIDs, hasHostTraffic, err := pendingTrafficPayloadSummary(report.Payload)
	if err != nil {
		return err
	}
	if report.StatCount != len(ruleIDs) || report.StatCount != len(report.Baselines) {
		return fmt.Errorf("traffic report stats and baselines do not match")
	}
	if report.HasRuleTraffic != (report.StatCount > 0) || report.HasHostTraffic != hasHostTraffic {
		return fmt.Errorf("traffic report content flags do not match payload")
	}
	if report.StatCount == 0 && !report.HasHostTraffic {
		return fmt.Errorf("traffic report has no traffic payload")
	}
	ruleCounts := make(map[int]int, len(ruleIDs))
	for _, ruleID := range ruleIDs {
		ruleCounts[ruleID]++
	}
	ports := make(map[string]struct{}, len(report.Baselines))
	for _, baseline := range report.Baselines {
		portText := strings.TrimSpace(baseline.Port)
		port, err := strconv.Atoi(portText)
		if err != nil || port <= 0 || port > 65535 || strconv.Itoa(port) != portText {
			return fmt.Errorf("traffic report baseline port is invalid")
		}
		if _, duplicate := ports[portText]; duplicate {
			return fmt.Errorf("traffic report contains duplicate baseline port %s", portText)
		}
		ports[portText] = struct{}{}
		if baseline.RuleID <= 0 || ruleCounts[baseline.RuleID] <= 0 {
			return fmt.Errorf("traffic report baseline rule does not match payload")
		}
		ruleCounts[baseline.RuleID]--
	}
	for _, remaining := range ruleCounts {
		if remaining != 0 {
			return fmt.Errorf("traffic report baseline rules do not match payload")
		}
	}
	return nil
}

func persistedTrafficBaselines(updates []trafficBaselineUpdate) []persistedTrafficBaseline {
	baselines := make([]persistedTrafficBaseline, 0, len(updates))
	for _, update := range updates {
		baselines = append(baselines, persistedTrafficBaseline{
			Port: update.port, RuleID: update.state.ruleID,
			In: update.state.in, Out: update.state.out, Conns: update.state.conns,
		})
	}
	return baselines
}

func pendingTrafficBaselineUpdates(baselines []persistedTrafficBaseline) []trafficBaselineUpdate {
	updates := make([]trafficBaselineUpdate, 0, len(baselines))
	for _, baseline := range baselines {
		if strings.TrimSpace(baseline.Port) == "" || baseline.RuleID <= 0 {
			continue
		}
		updates = append(updates, trafficBaselineUpdate{
			port: baseline.Port,
			state: trafficPrevState{
				ruleID: baseline.RuleID, in: baseline.In, out: baseline.Out, conns: baseline.Conns,
			},
		})
	}
	return updates
}

func savePendingTrafficReport(report pendingTrafficReport) error {
	if err := validatePendingTrafficReport(report); err != nil {
		return fmt.Errorf("validate pending traffic report: %w", err)
	}
	raw, err := json.Marshal(report)
	if err != nil {
		return err
	}
	return writeTrafficStateFile(pendingTrafficReportPath(), raw, 0600)
}

func clearTrafficBaselinesForIdentityChange() error {
	if err := ensureTrafficStateDirectoryDurable(trafficStateDir); err != nil {
		return err
	}
	files, err := os.ReadDir(trafficStateDir)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, file := range files {
		name := file.Name()
		if strings.HasPrefix(name, "traffic_") && strings.HasSuffix(name, ".prev") {
			if err := removeTrafficStateFile(trafficStateDir+"/"+name, trafficStateDir); err != nil {
				return err
			}
		}
	}
	if err := removeTrafficStateFile(pendingTrafficReportPath(), trafficStateDir); err != nil {
		return err
	}
	trafficPrevMu.Lock()
	trafficPrevCache = map[string]trafficPrevState{}
	trafficPrevMu.Unlock()
	lastRuleTrafficReportAt = time.Time{}
	lastHostTrafficReportAt = time.Time{}
	return nil
}

func loadPendingTrafficReport(expectedIdentity string) (pendingTrafficReport, bool, error) {
	if err := ensureTrafficStateDirectoryDurable(trafficStateDir); err != nil {
		return pendingTrafficReport{}, false, err
	}
	raw, err := os.ReadFile(pendingTrafficReportPath())
	if err != nil {
		if os.IsNotExist(err) {
			return pendingTrafficReport{}, false, nil
		}
		return pendingTrafficReport{}, false, err
	}
	var report pendingTrafficReport
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&report); err != nil {
		return pendingTrafficReport{}, false, fmt.Errorf("decode pending traffic report: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return pendingTrafficReport{}, false, fmt.Errorf("decode pending traffic report: multiple JSON values")
		}
		return pendingTrafficReport{}, false, fmt.Errorf("decode pending traffic report trailing data: %w", err)
	}
	if err := validatePendingTrafficReport(report); err != nil {
		return pendingTrafficReport{}, false, fmt.Errorf("validate pending traffic report: %w", err)
	}
	if expectedIdentity != "" && report.Identity != expectedIdentity {
		if err := clearTrafficBaselinesForIdentityChange(); err != nil {
			return pendingTrafficReport{}, false, err
		}
		return pendingTrafficReport{}, false, nil
	}
	return report, true, nil
}

func completePendingTrafficReport(report pendingTrafficReport) error {
	if err := ensureTrafficStateDirectoryDurable(trafficStateDir); err != nil {
		return err
	}
	if err := validatePendingTrafficReport(report); err != nil {
		return fmt.Errorf("validate pending traffic report: %w", err)
	}
	updates := pendingTrafficBaselineUpdates(report.Baselines)
	currentUpdates := updates[:0]
	for _, update := range updates {
		rawRuleID, err := os.ReadFile(trafficStateDir + "/port_" + update.port + ".rule")
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return fmt.Errorf("read current traffic rule port %s: %w", update.port, err)
		}
		currentRuleID, err := strconv.Atoi(strings.TrimSpace(string(rawRuleID)))
		if err != nil || currentRuleID <= 0 {
			return fmt.Errorf("read current traffic rule port %s: invalid rule id", update.port)
		}
		if currentRuleID == update.state.ruleID {
			currentUpdates = append(currentUpdates, update)
		}
	}
	if err := commitTrafficBaselines(true, currentUpdates); err != nil {
		return err
	}
	if err := removeTrafficStateFile(pendingTrafficReportPath(), trafficStateDir); err != nil {
		return err
	}
	if report.HasRuleTraffic {
		lastRuleTrafficReportAt = time.Now()
	}
	if report.HasHostTraffic {
		lastHostTrafficReportAt = time.Now()
	}
	return nil
}

func shouldReportRuleTraffic(statCount int, now time.Time) bool {
	return statCount > 0 && (lastRuleTrafficReportAt.IsZero() || now.Sub(lastRuleTrafficReportAt) >= currentActiveTrafficReportInterval())
}

func currentActiveTrafficReportInterval() time.Duration {
	return agentPeriodicInterval(configuredActiveTrafficReportInterval(), "traffic")
}

func configuredActiveTrafficReportInterval() time.Duration {
	interval := time.Duration(activeTrafficReportNanos.Load())
	if interval < activeTrafficReportEvery || interval > steadyTrafficReportEvery {
		return activeTrafficReportEvery
	}
	return interval
}

// The panel may relax ordinary traffic accounting to a larger batch window.
// Zero is intentionally ignored so an older panel keeps the conservative
// ten-second default.
func setActiveTrafficReportIntervalSeconds(seconds int) {
	if seconds <= 0 {
		return
	}
	interval := time.Duration(seconds) * time.Second
	if interval < activeTrafficReportEvery {
		interval = activeTrafficReportEvery
	}
	if interval > steadyTrafficReportEvery {
		interval = steadyTrafficReportEvery
	}
	previous := configuredActiveTrafficReportInterval()
	activeTrafficReportNanos.Store(int64(interval))
	if interval < previous {
		trafficCollectMu.Lock()
		if nextTrafficCollectInterval > interval {
			nextTrafficCollectInterval = interval
		}
		trafficCollectMu.Unlock()
		wakeAgentMetricsScheduler()
	}
}

func shouldIncludeHostTraffic(reportingRuleTraffic bool, now time.Time) bool {
	return reportingRuleTraffic || lastHostTrafficReportAt.IsZero() || now.Sub(lastHostTrafficReportAt) >= idleHostTrafficReportEvery
}

func scheduleTrafficCollection(cfg Config) bool {
	now := time.Now()
	trafficCollectMu.Lock()
	if trafficCollectRunning || (!lastTrafficCollectAt.IsZero() && now.Sub(lastTrafficCollectAt) < nextTrafficCollectInterval) {
		trafficCollectMu.Unlock()
		return false
	}
	if atomic.LoadInt64(&actionPendingCount) > 0 {
		trafficCollectMu.Unlock()
		return false
	}
	trafficCollectRunning = true
	lastTrafficCollectAt = now
	trafficCollectMu.Unlock()
	go func() {
		next := collectTraffic(cfg)
		trafficCollectMu.Lock()
		nextTrafficCollectInterval = next
		lastTrafficCollectAt = time.Now()
		trafficCollectRunning = false
		trafficCollectMu.Unlock()
	}()
	return true
}

func prioritizeTrafficCollectionForRules(ruleCount int) {
	if ruleCount <= 0 {
		return
	}
	trafficCollectMu.Lock()
	if nextTrafficCollectInterval >= idleHostTrafficReportEvery {
		lastTrafficCollectAt = time.Time{}
		nextTrafficCollectInterval = trafficCollectInterval
	}
	trafficCollectMu.Unlock()
}

func collectTraffic(cfg Config) time.Duration {
	started := time.Now()
	states := readLocalRuleStates()
	nextInterval := trafficCollectionIntervalForRuleCount(len(states))
	defer func() {
		elapsed := time.Since(started)
		if elapsed >= nextInterval/2 {
			if shouldLogAgentReport("traffic-collect-slow", 5*time.Minute) {
				logf("traffic collect slow rules=%d duration=%s nextInterval=%s", len(states), elapsed.Truncate(time.Millisecond), trafficCollectBackoffInterval(nextInterval, elapsed))
			}
		}
	}()
	stats := []map[string]any{}
	pendingBaselines := make([]trafficBaselineUpdate, 0, len(states))
	watched := len(states)
	reportPanelURL := currentPanelURL(cfg)
	reportIdentity := trafficReportIdentityForPanel(cfg, reportPanelURL)
	if err := ensureTrafficReportIdentity(reportIdentity); err != nil {
		if shouldLogAgentReport("traffic-report-identity-failed", agentReportLogInterval) {
			logf("traffic report identity state failed: %v", err)
		}
		return trafficCollectBackoffInterval(nextInterval, time.Since(started))
	}
	pending, hasPending, err := loadPendingTrafficReport(reportIdentity)
	if err != nil {
		if shouldLogAgentReport("traffic-report-pending-load-failed", agentReportLogInterval) {
			logf("traffic report pending state load failed: %v", err)
		}
		return trafficCollectBackoffInterval(nextInterval, time.Since(started))
	}
	if hasPending {
		response := map[string]any{}
		if err := postToPanelURL(cfg, reportPanelURL, "/api/agent/traffic", pending.Payload, &response); err != nil {
			if isTransientAgentCommError(err) {
				logAgentCommError("traffic-report-retry", err)
			} else if shouldLogAgentReport("traffic-report-retry-failed", agentReportLogInterval) {
				logf("traffic report retry failed stats=%d: %v", pending.StatCount, err)
			}
		} else {
			if seconds, ok := response["trafficReportInterval"].(float64); ok {
				setActiveTrafficReportIntervalSeconds(int(seconds))
			}
			if err := completePendingTrafficReport(pending); err != nil && shouldLogAgentReport("traffic-report-complete-failed", agentReportLogInterval) {
				logf("traffic report baseline commit failed stats=%d: %v", pending.StatCount, err)
			}
		}
		nextInterval = trafficCollectionIntervalForRuleCount(len(states))
		return trafficCollectBackoffInterval(nextInterval, time.Since(started))
	}
	if len(states) > 0 {
		iptablesCounters, diagnostics := iptablesCounterSnapshotWithDiagnostics()
		nftCounters, nftMarkers := nftablesCounterSnapshotWithDiagnostics()
		diagnostics.nftMarkers = nftMarkers
		nftProcessCounters, nftProcessMarkers := nftProcessCounterSnapshotWithDiagnostics()
		diagnostics.nftProcessMarkers = nftProcessMarkers
		connCounts := conntrackConnectionsSnapshot(states)
		for _, state := range states {
			if !shouldCollectRuleTraffic(state) {
				continue
			}
			counters := iptablesCounters[state.Port]
			if state.ForwardType == "nftables" {
				if nft, ok := nftCounters[state.RuleID]; ok {
					counters = nft
				}
			} else if diagnostics.nftProcessMarkers[state.Port] {
				// Both counter families are installed for every port, but they
				// cover different hooks: only one of them may have seen the
				// traffic. Take the larger sample per direction instead of
				// replacing, so a chain that matched nothing cannot zero out a
				// chain that did.
				counters = maxTrafficCounters(counters, nftProcessCounters[state.Port])
			}
			curConns := connCounts[state.Port]
			prevRuleID, prevIn, prevOut, prevConns := readPrev(state.Port)
			initialBaseline := prevRuleID <= 0 || prevRuleID != state.RuleID
			if initialBaseline {
				prevIn, prevOut = counters.In, counters.Out
				prevConns = curConns
			}
			din, dout, dconns := delta(counters.In, prevIn), delta(counters.Out, prevOut), delta(curConns, prevConns)
			nextBaseline := trafficPrevState{ruleID: state.RuleID, in: counters.In, out: counters.Out, conns: curConns}
			if din > 0 || dout > 0 || dconns > 0 {
				stats = append(stats, map[string]any{"ruleId": state.RuleID, "bytesIn": din, "bytesOut": dout, "connections": dconns})
				pendingBaselines = append(pendingBaselines, trafficBaselineUpdate{port: state.Port, state: nextBaseline})
			} else {
				if err := writePrevState(state.Port, nextBaseline); err != nil && shouldLogAgentReport("traffic-baseline-write-failed", agentReportLogInterval) {
					logf("traffic baseline write failed port=%s rule=%d: %v", state.Port, state.RuleID, err)
				}
			}
			logTrafficCounterDiagnostic(state, counters, din, dout, curConns, nftCounters, diagnostics)
		}
	}
	now := time.Now()
	reportRuleTraffic := shouldReportRuleTraffic(len(stats), now)
	var hostTraffic map[string]any
	if shouldIncludeHostTraffic(reportRuleTraffic, now) {
		hostTraffic = hostTrafficSnapshot()
	}
	payload := map[string]any{"stats": stats}
	if hostTraffic != nil {
		payload["hostTraffic"] = hostTraffic
	}
	if compactAgentReports.Load() {
		compactStats := make([][]any, 0, len(stats))
		for _, stat := range stats {
			compactStats = append(compactStats, compactTrafficStat(stat))
		}
		payload = map[string]any{"s": compactStats}
		if hostTraffic != nil {
			payload["h"] = []any{hostTraffic["bytesIn"], hostTraffic["bytesOut"]}
		}
	}
	if reportRuleTraffic || hostTraffic != nil {
		payload["reportId"] = newTrafficReportID()
		payload["reportProducerId"] = trafficReportProducerID(reportIdentity)
		pending := pendingTrafficReport{
			Payload: payload, Baselines: persistedTrafficBaselines(pendingBaselines),
			Identity: reportIdentity, HasRuleTraffic: len(stats) > 0,
			HasHostTraffic: hostTraffic != nil, StatCount: len(stats),
		}
		if err := savePendingTrafficReport(pending); err != nil {
			if shouldLogAgentReport("traffic-report-persist-failed", agentReportLogInterval) {
				logf("traffic report pending state failed stats=%d: %v", len(stats), err)
			}
			nextInterval = trafficCollectionIntervalForRuleCount(len(states))
			return trafficCollectBackoffInterval(nextInterval, time.Since(started))
		}
		response := map[string]any{}
		if err := postToPanelURL(cfg, reportPanelURL, "/api/agent/traffic", payload, &response); err != nil {
			if isTransientAgentCommError(err) {
				logAgentCommError("traffic-report", err)
			} else if shouldLogAgentReport("traffic-report-failed", agentReportLogInterval) {
				logf("traffic report failed watched=%d stats=%d: %v", watched, len(stats), err)
			}
		} else {
			if seconds, ok := response["trafficReportInterval"].(float64); ok {
				setActiveTrafficReportIntervalSeconds(int(seconds))
			}
			completeErr := completePendingTrafficReport(pending)
			if completeErr != nil && shouldLogAgentReport("traffic-report-complete-failed", agentReportLogInterval) {
				logf("traffic report baseline commit failed stats=%d: %v", pending.StatCount, completeErr)
			}
			if completeErr == nil && agentVerboseLogs && len(stats) > 0 && shouldLogAgentReport("traffic-report-ok", 5*time.Minute) {
				logf("traffic report ok watched=%d stats=%d", watched, len(stats))
			}
		}
	}
	nextInterval = trafficCollectionIntervalForRuleCount(len(states))
	return trafficCollectBackoffInterval(nextInterval, time.Since(started))
}

func trafficCollectionIntervalForRuleCount(count int) time.Duration {
	interval := trafficCollectIntervalForRuleCount(count)
	if count > 0 {
		if reportInterval := currentActiveTrafficReportInterval(); reportInterval > interval {
			interval = reportInterval
		}
	}
	return interval
}

func trafficCollectIntervalForRuleCount(count int) time.Duration {
	switch {
	case count <= 0:
		return idleHostTrafficReportEvery
	case count >= 500:
		return 15 * time.Second
	case count >= 300:
		return 12 * time.Second
	case count >= 150:
		return 8 * time.Second
	case count >= 50:
		return 5 * time.Second
	default:
		return trafficCollectInterval
	}
}

func trafficCollectBackoffInterval(base time.Duration, elapsed time.Duration) time.Duration {
	if base >= idleHostTrafficReportEvery {
		return base
	}
	next := base
	if elapsed >= 5*time.Second {
		next = base * 3
	} else if elapsed >= 2*time.Second {
		next = base * 2
	}
	if next < trafficCollectInterval {
		next = trafficCollectInterval
	}
	if next > trafficCollectMaxInterval {
		next = trafficCollectMaxInterval
	}
	return next
}

func collectTCPing(cfg Config, ruleProbes []ruleLatencyProbe, probes []tunnelProbe, groupProbes []forwardGroupProbe, serviceProbes []hostProbeServiceProbe, force bool, startActionEpoch uint64, startedWithActionsPending bool) {
	ruleTasks := []tcpingTask{}
	for _, state := range readLocalRuleStates() {
		if task, ok := buildRuleLatencyProbeTask(state); ok {
			ruleTasks = append(ruleTasks, task)
		}
	}
	for _, probe := range ruleProbes {
		if task, ok := buildExplicitRuleLatencyProbeTask(probe); ok {
			ruleTasks = append(ruleTasks, task)
		}
	}

	tunnelTasks := buildTunnelProbeTasks(probes)

	serviceTasks := []tcpingTask{}
	for _, probe := range serviceProbes {
		if probe.ServiceID <= 0 || probe.TargetIP == "" {
			continue
		}
		method := strings.ToLower(strings.TrimSpace(probe.Method))
		if method == "ping" {
			serviceTasks = append(serviceTasks, tcpingTask{
				Kind:      "service",
				ServiceID: probe.ServiceID,
				Method:    method,
				TargetIP:  probe.TargetIP,
				ProbeKey:  fmt.Sprintf("service:%d:%s:ping", probe.ServiceID, strings.ToLower(strings.TrimSpace(probe.TargetIP))),
			})
			continue
		}
		if probe.TargetPort <= 0 {
			continue
		}
		serviceTasks = append(serviceTasks, tcpingTask{
			Kind:       "service",
			ServiceID:  probe.ServiceID,
			Method:     "tcping",
			TargetIP:   probe.TargetIP,
			TargetPort: probe.TargetPort,
			ProbeKey:   fmt.Sprintf("service:%d:%s:%d:tcping", probe.ServiceID, strings.ToLower(strings.TrimSpace(probe.TargetIP)), probe.TargetPort),
		})
	}

	forwardGroupTasks := []tcpingTask{}
	for _, probe := range groupProbes {
		if probe.GroupID <= 0 || probe.TargetIP == "" || probe.HopCount <= 0 {
			continue
		}
		method := strings.ToLower(strings.TrimSpace(probe.Method))
		if method != "ping" && probe.TargetPort <= 0 {
			continue
		}
		if method != "ping" {
			method = "tcp"
		}
		forwardGroupTasks = append(forwardGroupTasks, tcpingTask{
			Kind:        "forwardGroup",
			GroupID:     probe.GroupID,
			MemberID:    probe.MemberID,
			ProbeType:   probe.ProbeType,
			Method:      method,
			TargetIP:    probe.TargetIP,
			TargetPort:  probe.TargetPort,
			HopIndex:    probe.HopIndex,
			HopCount:    probe.HopCount,
			ProbeKey:    probe.ProbeKey,
			TopologyKey: probe.TopologyKey,
		})
	}

	cycleInterval := tcpingDueInterval(serviceProbes, len(ruleTasks), len(tunnelTasks)+len(forwardGroupTasks))
	ruleRounds := tcpingRoundsForWindow(cycleInterval, 3*time.Minute)
	ruleLimit := tcpingDynamicBatchLimit(len(ruleTasks), tcpingRuleBatchSize, ruleRounds, 256)
	probeLimit := len(forwardGroupTasks)
	serviceLimit := tcpingDynamicBatchLimit(len(serviceTasks), tcpingProbeBatchSize, 1, 96)
	if force {
		ruleLimit = len(ruleTasks)
		serviceLimit = len(serviceTasks)
	}
	tunnelProbeLimit := len(tunnelTasks)
	tcpingCursorMu.Lock()
	selected := []tcpingTask{}
	selected = append(selected, rotateTCPingTasks(ruleTasks, &tcpingRuleCursor, ruleLimit)...)
	selected = append(selected, rotateTCPingTasks(tunnelTasks, &tcpingTunnelCursor, tunnelProbeLimit)...)
	selected = append(selected, rotateTCPingTasks(forwardGroupTasks, &tcpingForwardGroupCursor, probeLimit)...)
	selected = append(selected, rotateTCPingTasks(serviceTasks, &tcpingServiceCursor, serviceLimit)...)
	tcpingCursorMu.Unlock()
	if len(selected) == 0 {
		return
	}

	results, tunnels, forwardGroups, services := runTCPingTasks(selected)
	results, tunnels, forwardGroups, services = filterRuntimeProbeResultsAfterActions(
		startActionEpoch,
		startedWithActionsPending,
		results,
		tunnels,
		forwardGroups,
		services,
	)
	reportPlan := agentTCPingReportGate.plan(results, tunnels, forwardGroups, services, force, time.Now())
	results = reportPlan.results
	tunnels = reportPlan.tunnels
	forwardGroups = reportPlan.forwardGroups
	services = reportPlan.services
	if len(results) > 0 || len(tunnels) > 0 || len(forwardGroups) > 0 || len(services) > 0 {
		payload := map[string]any{"results": results, "tunnels": tunnels, "forwardGroups": forwardGroups, "services": services, "force": force}
		if err := post(cfg, "/api/agent/tcping", payload, &map[string]any{}); err != nil {
			if isTransientAgentCommError(err) {
				logAgentCommError("tcping-report", err)
			} else if shouldLogAgentReport("tcping-report-failed", agentReportLogInterval) {
				logf("tcping report failed rules=%d tunnels=%d groups=%d services=%d: %v", len(results), len(tunnels), len(forwardGroups), len(services), err)
			}
		} else {
			agentTCPingReportGate.commit(reportPlan)
			if agentVerboseLogs && (len(tunnels) > 0 || len(forwardGroups) > 0 || len(services) > 0) {
				total, timeouts, avgLatency := summarizeTCPingReport(results, tunnels, forwardGroups, services)
				if shouldLogAgentReport("tcping-report-ok", agentReportLogInterval) {
					logf("tcping report ok rules=%d tunnels=%d groups=%d services=%d timeouts=%d/%d avg=%s", len(results), len(tunnels), len(forwardGroups), len(services), timeouts, total, avgLatency)
				}
			}
		}
	}
}

func filterRuntimeProbeResultsAfterActions(startActionEpoch uint64, startedWithActionsPending bool, results, tunnels, forwardGroups, services []map[string]any) ([]map[string]any, []map[string]any, []map[string]any, []map[string]any) {
	endActionEpoch := runtimeActionEpoch.Load()
	pending := atomic.LoadInt64(&actionPendingCount)
	if !startedWithActionsPending && pending == 0 && endActionEpoch == startActionEpoch {
		return results, tunnels, forwardGroups, services
	}
	if len(results) > 0 || len(tunnels) > 0 || len(forwardGroups) > 0 {
		logVerbosef(
			"tcping runtime results discarded after action change epoch=%d->%d pending=%d rules=%d tunnels=%d groups=%d",
			startActionEpoch,
			endActionEpoch,
			pending,
			len(results),
			len(tunnels),
			len(forwardGroups),
		)
	}
	return nil, nil, nil, services
}

func buildTunnelProbeTasks(probes []tunnelProbe) []tcpingTask {
	tasks := make([]tcpingTask, 0, len(probes))
	for _, probe := range probes {
		if probe.TunnelID <= 0 || strings.TrimSpace(probe.TargetIP) == "" || probe.TargetPort <= 0 {
			continue
		}
		tasks = append(tasks, tcpingTask{
			Kind:            "tunnel",
			TunnelID:        probe.TunnelID,
			TargetIP:        probe.TargetIP,
			TargetPort:      probe.TargetPort,
			Method:          "tcp",
			HopIndex:        probe.HopIndex,
			HopCount:        probe.HopCount,
			SeriesKey:       probe.SeriesKey,
			SeriesLabel:     probe.SeriesLabel,
			WireGuardPeerID: probe.WireGuardPeerID,
			ProbeKey:        probe.ProbeKey,
			TopologyKey:     probe.TopologyKey,
		})
	}
	return tasks
}

func buildRuleLatencyProbeTask(state localRuleState) (tcpingTask, bool) {
	port := parseStatePort(state.Port)
	if desired, ok := desiredRunningRuleForStatePort(state.RuleID, port); ok {
		state.TunnelID = desired.TunnelID
		state.ForwardType = desired.ForwardType
		state.TargetIP = desired.TargetIP
		state.TargetPort = desired.TargetPort
		state.Protocol = desired.Protocol
	}
	// Tunnel rules are measured from an explicit exit-host probe supplied by
	// the panel. Probing their final target from an entry or relay host bypasses
	// the tunnel and produces unrelated latency or false timeouts.
	if state.TunnelID > 0 {
		return tcpingTask{}, false
	}
	if state.RuleID <= 0 || port <= 0 || strings.TrimSpace(state.TargetIP) == "" || state.TargetPort <= 0 {
		return tcpingTask{}, false
	}
	method := "tcping"
	if normalizeRuntimeProtocol(state.Protocol) == "udp" {
		method = "ping"
	}
	return tcpingTask{
		Kind:       "rule",
		RuleID:     state.RuleID,
		Method:     method,
		TargetIP:   state.TargetIP,
		TargetPort: state.TargetPort,
		SourcePort: port,
		ProbeKey:   fmt.Sprintf("rule:%d:%s:%d:%s", state.RuleID, strings.ToLower(strings.TrimSpace(state.TargetIP)), state.TargetPort, method),
	}, true
}

func buildExplicitRuleLatencyProbeTask(probe ruleLatencyProbe) (tcpingTask, bool) {
	method := strings.ToLower(strings.TrimSpace(probe.Method))
	if method != "ping" {
		method = "tcping"
	}
	if probe.RuleID <= 0 || probe.TunnelID <= 0 || strings.TrimSpace(probe.TargetIP) == "" || probe.TargetPort <= 0 {
		return tcpingTask{}, false
	}
	probeKey := strings.TrimSpace(probe.ProbeKey)
	if probeKey == "" {
		probeKey = fmt.Sprintf("rule:%d:tunnel:%d:%s:%d:%s", probe.RuleID, probe.TunnelID, strings.ToLower(strings.TrimSpace(probe.TargetIP)), probe.TargetPort, method)
	}
	return tcpingTask{
		Kind:        "rule",
		RuleID:      probe.RuleID,
		TunnelID:    probe.TunnelID,
		Method:      method,
		TargetIP:    probe.TargetIP,
		TargetPort:  probe.TargetPort,
		ProbeKey:    probeKey,
		TopologyKey: strings.TrimSpace(probe.TopologyKey),
	}, true
}

func scheduleTCPingCollection(cfg Config, ruleProbes []ruleLatencyProbe, probes []tunnelProbe, groupProbes []forwardGroupProbe, serviceProbes []hostProbeServiceProbe, force bool) bool {
	startActionEpoch := runtimeActionEpoch.Load()
	startedWithActionsPending := atomic.LoadInt64(&actionPendingCount) > 0
	if startedWithActionsPending && (len(ruleProbes) > 0 || len(probes) > 0 || len(groupProbes) > 0) {
		logVerbosef("tcping collect deferred while runtime actions are pending=%d", atomic.LoadInt64(&actionPendingCount))
		return false
	}
	if !atomic.CompareAndSwapInt32(&tcpingCollectRunning, 0, 1) {
		logVerbosef("tcping collect skip because previous run is still active")
		return false
	}
	ruleProbesCopy := append([]ruleLatencyProbe(nil), ruleProbes...)
	probesCopy := append([]tunnelProbe(nil), probes...)
	groupProbesCopy := append([]forwardGroupProbe(nil), groupProbes...)
	serviceProbesCopy := append([]hostProbeServiceProbe(nil), serviceProbes...)
	go func() {
		started := time.Now()
		defer atomic.StoreInt32(&tcpingCollectRunning, 0)
		collectTCPing(cfg, ruleProbesCopy, probesCopy, groupProbesCopy, serviceProbesCopy, force, startActionEpoch, startedWithActionsPending)
		if elapsed := time.Since(started); elapsed >= 5*time.Second && shouldLogAgentReport("tcping-collect-slow-async", 5*time.Minute) {
			logf("tcping collect slow duration=%s ruleProbes=%d tunnels=%d groups=%d services=%d force=%v", elapsed.Round(time.Millisecond), len(ruleProbesCopy), len(probesCopy), len(groupProbesCopy), len(serviceProbesCopy), force)
		}
	}()
	return true
}

func tcpingDynamicBatchLimit(total, minimum, targetRounds, maximum int) int {
	if total <= 0 {
		return 0
	}
	if targetRounds <= 0 {
		targetRounds = 1
	}
	limit := (total + targetRounds - 1) / targetRounds
	if limit < minimum {
		limit = minimum
	}
	if maximum > 0 && limit > maximum {
		limit = maximum
	}
	if limit > total {
		limit = total
	}
	return limit
}

func tcpingRoundsForWindow(interval time.Duration, window time.Duration) int {
	if interval <= 0 || window <= interval {
		return 1
	}
	return int((window + interval - 1) / interval)
}

func summarizeTCPingReport(results, tunnels, forwardGroups, services []map[string]any) (int, int, string) {
	groups := [][]map[string]any{results, tunnels, forwardGroups, services}
	total := 0
	timeouts := 0
	latencyTotal := 0
	latencyCount := 0
	for _, group := range groups {
		for _, item := range group {
			total++
			if timeout, _ := item["isTimeout"].(bool); timeout {
				timeouts++
			}
			switch value := item["latencyMs"].(type) {
			case int:
				if value > 0 {
					latencyTotal += value
					latencyCount++
				}
			case int64:
				if value > 0 {
					latencyTotal += int(value)
					latencyCount++
				}
			case float64:
				if value > 0 {
					latencyTotal += int(value)
					latencyCount++
				}
			}
		}
	}
	if latencyCount == 0 {
		return total, timeouts, "-"
	}
	return total, timeouts, fmt.Sprintf("%dms", latencyTotal/latencyCount)
}

func readLocalRuleStates() []localRuleState {
	files, err := os.ReadDir(agentStateDir)
	if err != nil {
		return nil
	}
	states := make([]localRuleState, 0, len(files))
	for _, f := range files {
		name := f.Name()
		if !strings.HasPrefix(name, "port_") || !strings.HasSuffix(name, ".rule") {
			continue
		}
		port := strings.TrimSuffix(strings.TrimPrefix(name, "port_"), ".rule")
		ridBytes, err := os.ReadFile(agentStateDir + "/" + name)
		if err != nil {
			continue
		}
		ruleID, _ := strconv.Atoi(strings.TrimSpace(string(ridBytes)))
		if desired, ok := desiredRunningRuleForStatePort(ruleID, parseStatePort(port)); ok {
			states = append(states, localRuleState{
				Port:        port,
				RuleID:      ruleID,
				TunnelID:    desired.TunnelID,
				ForwardType: desired.ForwardType,
				TargetIP:    desired.TargetIP,
				TargetPort:  desired.TargetPort,
				Protocol:    desired.Protocol,
			})
			continue
		}
		targetIP, targetPort, protocol, _ := readTargetInfo(port)
		states = append(states, localRuleState{
			Port:        port,
			RuleID:      ruleID,
			TunnelID:    readRuleTunnelIDByPort(port),
			ForwardType: readForwardTypeByPort(port),
			TargetIP:    targetIP,
			TargetPort:  targetPort,
			Protocol:    protocol,
		})
	}
	sort.Slice(states, func(i, j int) bool {
		if states[i].RuleID != states[j].RuleID {
			return states[i].RuleID < states[j].RuleID
		}
		return states[i].Port < states[j].Port
	})
	return states
}

func parseStatePort(value string) int {
	port, _ := strconv.Atoi(strings.TrimSpace(value))
	return port
}

func rotateTCPingTasks(tasks []tcpingTask, cursor *int, limit int) []tcpingTask {
	if len(tasks) == 0 || limit <= 0 {
		return nil
	}
	if limit >= len(tasks) {
		*cursor = 0
		return append([]tcpingTask(nil), tasks...)
	}
	start := *cursor % len(tasks)
	if start < 0 {
		start = 0
	}
	selected := make([]tcpingTask, 0, limit)
	for i := 0; i < limit; i++ {
		selected = append(selected, tasks[(start+i)%len(tasks)])
	}
	*cursor = (start + limit) % len(tasks)
	return selected
}

func runTCPingTasks(tasks []tcpingTask) ([]map[string]any, []map[string]any, []map[string]any, []map[string]any) {
	workerCount := tcpingTaskConcurrency(len(tasks))
	out := make(chan tcpingTaskResult, len(tasks))
	jobs := make(chan tcpingTask, workerCount)
	var wg sync.WaitGroup
	for worker := 0; worker < workerCount; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for task := range jobs {
				out <- executeTCPingTask(task)
			}
		}()
	}
	for _, task := range tasks {
		jobs <- task
	}
	close(jobs)
	wg.Wait()
	close(out)
	results := []map[string]any{}
	tunnels := []map[string]any{}
	forwardGroups := []map[string]any{}
	services := []map[string]any{}
	for result := range out {
		if result.Payload == nil {
			continue
		}
		switch result.Kind {
		case "rule":
			results = append(results, result.Payload)
		case "tunnel":
			tunnels = append(tunnels, result.Payload)
		case "forwardGroup":
			forwardGroups = append(forwardGroups, result.Payload)
		case "service":
			services = append(services, result.Payload)
		}
	}
	return results, tunnels, forwardGroups, services
}

func tcpingTaskConcurrency(taskCount int) int {
	if taskCount <= 0 {
		return 0
	}
	limit := runtime.NumCPU() * 8
	if limit < 16 {
		limit = 16
	}
	if limit > tcpingMaxConcurrency {
		limit = tcpingMaxConcurrency
	}
	if atomic.LoadInt64(&actionPendingCount) > 0 && limit > 4 {
		limit = 4
	}
	if limit > taskCount {
		limit = taskCount
	}
	return limit
}

func executeTCPingTask(task tcpingTask) tcpingTaskResult {
	return executeTCPingTaskWithWireGuardProbe(task, wireGuardTCPLatencyDetailed)
}

func executeTCPingTaskWithWireGuardProbe(task tcpingTask, wireGuardProbe func(int, string, int, time.Duration) (int, wireGuardProbeStatus)) tcpingTaskResult {
	var latency int
	var reachable bool
	if (task.Kind == "rule" || task.Kind == "forwardGroup" || task.Kind == "service") && task.Method == "ping" {
		latency, reachable, _ = pingLatencyWithCount(task.TargetIP, tcpingProbeTimeout, tcpingPingProbeCount)
	} else if task.Kind == "tunnel" && task.WireGuardPeerID != "" {
		status := wireGuardProbeTimeout
		if wireGuardProbe != nil {
			latency, status = wireGuardProbe(task.TunnelID, task.WireGuardPeerID, task.TargetPort, tcpingWireGuardTimeout)
		}
		if status == wireGuardProbeNotReady {
			return tcpingTaskResult{}
		}
		reachable = status == wireGuardProbeSuccess
	} else {
		latency, reachable = tcpLatency(task.TargetIP, task.TargetPort, tcpingProbeTimeout)
	}
	payload := map[string]any{}
	switch task.Kind {
	case "rule":
		payload["ruleId"] = task.RuleID
		payload["tunnelId"] = task.TunnelID
		payload["sourcePort"] = task.SourcePort
	case "tunnel":
		payload["tunnelId"] = task.TunnelID
		if task.HopCount > 0 {
			payload["hopIndex"] = task.HopIndex
			payload["hopCount"] = task.HopCount
		}
		if task.SeriesKey != "" {
			payload["seriesKey"] = task.SeriesKey
		}
		if task.SeriesLabel != "" {
			payload["seriesLabel"] = task.SeriesLabel
		}
	case "forwardGroup":
		payload["groupId"] = task.GroupID
		if task.MemberID > 0 {
			payload["memberId"] = task.MemberID
		}
		if task.ProbeType != "" {
			payload["probeType"] = task.ProbeType
		}
		payload["method"] = task.Method
		payload["hopIndex"] = task.HopIndex
		payload["hopCount"] = task.HopCount
	case "service":
		payload["serviceId"] = task.ServiceID
		payload["method"] = task.Method
	default:
		return tcpingTaskResult{}
	}
	if task.TargetIP != "" {
		payload["targetIp"] = task.TargetIP
	}
	if task.TargetPort > 0 {
		payload["targetPort"] = task.TargetPort
	}
	if task.Method != "" {
		payload["method"] = task.Method
	}
	if task.ProbeKey != "" {
		payload["probeKey"] = task.ProbeKey
	}
	if task.TopologyKey != "" {
		payload["topologyKey"] = task.TopologyKey
	}
	if reachable {
		payload["latencyMs"] = latency
		payload["isTimeout"] = false
	} else {
		payload["latencyMs"] = 0
		payload["isTimeout"] = true
	}
	return tcpingTaskResult{Kind: task.Kind, Payload: payload}
}

func readTargetInfo(port string) (string, int, string, bool) {
	b, err := os.ReadFile("/var/lib/forwardx-agent/target_" + port + ".info")
	if err != nil {
		return "", 0, "tcp", false
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) < 2 {
		return "", 0, "tcp", false
	}
	targetIP := strings.TrimSpace(lines[0])
	targetPort, _ := strconv.Atoi(strings.TrimSpace(lines[1]))
	protocol := "tcp"
	if len(lines) >= 3 {
		protocol = normalizeRuntimeProtocol(lines[2])
	}
	return targetIP, targetPort, protocol, targetIP != "" && targetPort > 0
}

func tcpLatency(ip string, port int, timeout time.Duration) (int, bool) {
	latency, ok, _ := tcpLatencyResolved(ip, port, timeout)
	return latency, ok
}

func tcpLatencyResolved(host string, port int, timeout time.Duration) (int, bool, string) {
	target := normalizeNetworkTargetHost(host)
	if target == "" || port <= 0 {
		return 0, false, ""
	}
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	deadline := time.Now().Add(timeout)
	targets := []string{target}
	if net.ParseIP(target) == nil {
		resolved := resolveNetworkTargetIPs(target, time.Until(deadline))
		if len(resolved) == 0 {
			return 0, false, ""
		}
		targets = resolved
	}
	for _, dialHost := range targets {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		start := time.Now()
		conn, err := dialNetworkTimeout("tcp", net.JoinHostPort(dialHost, strconv.Itoa(port)), remaining)
		if err != nil {
			continue
		}
		_ = conn.Close()
		latency := int(time.Since(start).Milliseconds())
		if latency < 1 {
			latency = 1
		}
		return latency, true, dialHost
	}
	return 0, false, ""
}

func resolveNetworkTargetIPs(host string, timeout time.Duration) []string {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	now := time.Now()
	networkTargetDNSMu.Lock()
	if cached, ok := networkTargetDNSCache[host]; ok && now.Before(cached.expiresAt) {
		addresses := append([]string(nil), cached.addresses...)
		networkTargetDNSMu.Unlock()
		return addresses
	}
	if call := networkTargetDNSCalls[host]; call != nil {
		done := call.done
		networkTargetDNSMu.Unlock()
		select {
		case <-done:
			return append([]string(nil), call.addresses...)
		case <-ctx.Done():
			return nil
		}
	}
	call := &networkTargetDNSCall{done: make(chan struct{})}
	networkTargetDNSCalls[host] = call
	networkTargetDNSMu.Unlock()

	addrs, err := lookupNetworkTargetIPs(ctx, host)
	if err != nil {
		addrs = nil
	}
	seen := map[string]bool{}
	targets := make([]string, 0, len(addrs))
	for _, addr := range addrs {
		value := strings.TrimSpace(addr.String())
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		targets = append(targets, value)
	}
	ttl := networkTargetDNSTTL
	if len(targets) == 0 {
		ttl = networkTargetDNSFailureTTL
	}
	networkTargetDNSMu.Lock()
	call.addresses = append([]string(nil), targets...)
	networkTargetDNSCache[host] = networkTargetDNSCacheEntry{
		addresses: append([]string(nil), targets...),
		expiresAt: time.Now().Add(ttl),
	}
	delete(networkTargetDNSCalls, host)
	close(call.done)
	networkTargetDNSMu.Unlock()
	return targets
}

func pingLatency(host string, timeout time.Duration) (int, bool, string) {
	return pingLatencyWithCount(host, timeout, 1)
}

func normalizeNetworkTargetHost(host string) string {
	target := strings.TrimSpace(strings.ReplaceAll(host, "：", ":"))
	if target == "" {
		return ""
	}
	lower := strings.ToLower(target)
	for _, prefix := range []string{"tcp://", "udp://"} {
		if strings.HasPrefix(lower, prefix) {
			target = strings.TrimSpace(target[len(prefix):])
			lower = strings.ToLower(target)
			break
		}
	}
	if parsedHost, _, err := net.SplitHostPort(target); err == nil {
		return strings.TrimSpace(parsedHost)
	}
	if strings.HasPrefix(target, "[") {
		if end := strings.Index(target, "]"); end > 0 {
			return strings.TrimSpace(target[1:end])
		}
	}
	return target
}

func pingFamilyArg(host string) string {
	ip := net.ParseIP(normalizeNetworkTargetHost(host))
	if ip == nil {
		return ""
	}
	if ip.To4() != nil {
		return "-4"
	}
	return "-6"
}

func pingLatencyWithCount(host string, timeout time.Duration, count int) (int, bool, string) {
	target := normalizeNetworkTargetHost(host)
	if target == "" {
		return 0, false, "目标为空"
	}
	if count < 1 {
		count = 1
	}
	if latency, ok, detail, err := nativePingLatencyWithCount(target, timeout, count); err == nil {
		return latency, ok, detail
	} else if shouldLogAgentReport("native-ping-fallback", 5*time.Minute) {
		logf("native ping unavailable target=%s: %v; falling back to system ping", target, err)
	}
	start := time.Now()
	ctxTimeout := timeout + time.Second
	if count > 1 {
		ctxTimeout = timeout*time.Duration(count) + 2*time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), ctxTimeout)
	defer cancel()
	select {
	case systemPingSlots <- struct{}{}:
		defer func() { <-systemPingSlots }()
	case <-ctx.Done():
		return 0, false, "system ping queue timeout"
	}
	timeoutSeconds := int(timeout.Seconds())
	if timeoutSeconds < 1 {
		timeoutSeconds = 1
	}
	familyArg := pingFamilyArg(target)
	args := []string{}
	if familyArg != "" {
		args = append(args, familyArg)
	}
	args = append(args, "-c", strconv.Itoa(count), "-W", strconv.Itoa(timeoutSeconds), target)
	if runtime.GOOS == "windows" {
		args = []string{}
		if familyArg != "" {
			args = append(args, familyArg)
		}
		args = append(args, "-n", strconv.Itoa(count), "-w", strconv.Itoa(int(timeout.Milliseconds())), target)
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
	if parsed := parsePingLatencyMs(text); parsed > 0 {
		return parsed, true, ""
	}
	if err != nil {
		detail := strings.TrimSpace(text)
		if detail == "" {
			detail = err.Error()
		}
		return 0, false, detail
	}
	return elapsed, true, ""
}

func nativePingLatencyWithCount(target string, timeout time.Duration, count int) (int, bool, string, error) {
	if runtime.GOOS == "windows" {
		return 0, false, "", fmt.Errorf("native ping unsupported on windows")
	}
	if timeout <= 0 {
		timeout = tcpingProbeTimeout
	}
	targets := []string{target}
	if net.ParseIP(target) == nil {
		resolved := resolveNetworkTargetIPs(target, timeout)
		if len(resolved) == 0 {
			return 0, false, "resolve failed", nil
		}
		targets = resolved
	}
	var lastErr error
	for _, value := range targets {
		ip := net.ParseIP(value)
		if ip == nil {
			continue
		}
		latency, ok, err := nativePingIP(ip, timeout, count)
		if err != nil {
			lastErr = err
			continue
		}
		if ok {
			return latency, true, value, nil
		}
	}
	if lastErr != nil {
		return 0, false, "", lastErr
	}
	return 0, false, "timeout", nil
}

func nativePingIP(ip net.IP, timeout time.Duration, count int) (int, bool, error) {
	ipv4 := ip.To4()
	if ipv4 == nil {
		return 0, false, fmt.Errorf("native ping currently supports ipv4 only")
	}
	conn, err := net.ListenPacket("ip4:icmp", "0.0.0.0")
	if err != nil {
		return 0, false, err
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return 0, false, err
	}
	id := os.Getpid() & 0xffff
	baseSeq := int(time.Now().UnixNano()) & 0xffff
	sentAt := map[int]time.Time{}
	for i := 0; i < count; i++ {
		seq := (baseSeq + i) & 0xffff
		packet := buildICMPEchoRequest(8, id, seq)
		sentAt[seq] = time.Now()
		if _, err := conn.WriteTo(packet, &net.IPAddr{IP: ipv4}); err != nil {
			return 0, false, err
		}
	}
	buf := make([]byte, 1500)
	totalLatency := 0
	successes := 0
	for {
		n, addr, err := conn.ReadFrom(buf)
		if err != nil {
			break
		}
		if ipAddr, ok := addr.(*net.IPAddr); ok && !ipAddr.IP.Equal(ipv4) {
			continue
		}
		msg := stripIPv4Header(buf[:n])
		if len(msg) < 8 || msg[0] != 0 || msg[1] != 0 {
			continue
		}
		if int(binary.BigEndian.Uint16(msg[4:6])) != id {
			continue
		}
		seq := int(binary.BigEndian.Uint16(msg[6:8]))
		started, ok := sentAt[seq]
		if !ok {
			continue
		}
		delete(sentAt, seq)
		latency := int(time.Since(started).Milliseconds())
		if latency < 1 {
			latency = 1
		}
		totalLatency += latency
		successes++
		if successes >= count {
			break
		}
	}
	if successes == 0 {
		return 0, false, nil
	}
	return totalLatency / successes, true, nil
}

func buildICMPEchoRequest(typ byte, id int, seq int) []byte {
	payload := make([]byte, 24)
	payload[0] = typ
	binary.BigEndian.PutUint16(payload[4:6], uint16(id))
	binary.BigEndian.PutUint16(payload[6:8], uint16(seq))
	binary.BigEndian.PutUint64(payload[8:16], uint64(time.Now().UnixNano()))
	copy(payload[16:], []byte("forwardx"))
	checksum := icmpChecksum(payload)
	binary.BigEndian.PutUint16(payload[2:4], checksum)
	return payload
}

func stripIPv4Header(packet []byte) []byte {
	if len(packet) < 20 || packet[0]>>4 != 4 {
		return packet
	}
	headerLen := int(packet[0]&0x0f) * 4
	if headerLen < 20 || len(packet) < headerLen+8 {
		return packet
	}
	return packet[headerLen:]
}

func icmpChecksum(data []byte) uint16 {
	sum := uint32(0)
	for i := 0; i+1 < len(data); i += 2 {
		sum += uint32(binary.BigEndian.Uint16(data[i : i+2]))
	}
	if len(data)%2 == 1 {
		sum += uint32(data[len(data)-1]) << 8
	}
	for sum>>16 != 0 {
		sum = (sum & 0xffff) + (sum >> 16)
	}
	return ^uint16(sum)
}

func parsePingLatencyMs(output string) int {
	summaryPatterns := []*regexp.Regexp{
		regexp.MustCompile(`(?i)(?:rtt|round-trip)[^=]*=\s*[0-9]+(?:\.[0-9]+)?/([0-9]+(?:\.[0-9]+)?)`),
		regexp.MustCompile(`(?i)Average\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*ms`),
		regexp.MustCompile(`(?i)avg[/=]\s*([0-9]+(?:\.[0-9]+)?)`),
	}
	for _, pattern := range summaryPatterns {
		matches := pattern.FindStringSubmatch(output)
		if len(matches) >= 2 {
			if latency := roundPositiveLatency(matches[1]); latency > 0 {
				return latency
			}
		}
	}
	timePattern := regexp.MustCompile(`time[=<]\s*([0-9]+(?:\.[0-9]+)?)\s*ms`)
	timeMatches := timePattern.FindAllStringSubmatch(output, -1)
	if len(timeMatches) > 0 {
		total := 0
		count := 0
		for _, match := range timeMatches {
			if len(match) < 2 {
				continue
			}
			if latency := roundPositiveLatency(match[1]); latency > 0 {
				total += latency
				count++
			}
		}
		if count > 0 {
			return total / count
		}
	}
	patterns := []*regexp.Regexp{
		regexp.MustCompile(`(?i)time[=<]\s*([0-9]+(?:\.[0-9]+)?)\s*ms`),
	}
	for _, pattern := range patterns {
		matches := pattern.FindStringSubmatch(output)
		if len(matches) < 2 {
			continue
		}
		if latency := roundPositiveLatency(matches[1]); latency > 0 {
			return latency
		}
	}
	return 0
}

func roundPositiveLatency(value string) int {
	latencyValue, err := strconv.ParseFloat(value, 64)
	if err != nil || latencyValue <= 0 {
		return 0
	}
	latency := int(latencyValue + 0.5)
	if latency < 1 {
		latency = 1
	}
	return latency
}

func iptablesCounterSnapshot() map[string]trafficCounters {
	counters, _ := iptablesCounterSnapshotWithDiagnostics()
	return counters
}

func iptablesCounterSnapshotWithDiagnostics() (map[string]trafficCounters, trafficDiagnosticsSnapshot) {
	chainCounters := map[string]map[string]uint64{}
	diagnostics := trafficDiagnosticsSnapshot{
		iptablesMarkers:  map[string]bool{},
		ip6tablesMarkers: map[string]bool{},
		nftMarkers:       map[int]bool{},
	}
	parseIptablesCounterSnapshot("iptables", chainCounters, diagnostics.iptablesMarkers)
	parseIptablesCounterSnapshot("ip6tables", chainCounters, diagnostics.ip6tablesMarkers)

	out := map[string]trafficCounters{}
	for marker, byChain := range chainCounters {
		parts := strings.SplitN(marker, ":", 2)
		if len(parts) != 2 {
			continue
		}
		port, direction := parts[0], parts[1]
		maxBytes := uint64(0)
		for _, value := range byChain {
			if value > maxBytes {
				maxBytes = value
			}
		}
		counters := out[port]
		if direction == "in" {
			counters.In = maxBytes
		} else {
			counters.Out = maxBytes
		}
		out[port] = counters
	}
	return out, diagnostics
}

func parseIptablesCounterSnapshot(binary string, chainCounters map[string]map[string]uint64, markers map[string]bool) {
	raw, err := commandOutputWithTimeout(5*time.Second, binary, "-t", "mangle", "-nvxL")
	if err != nil {
		return
	}
	markerPattern := regexp.MustCompile(`fwx-stat-([0-9]+):(in|out)`)
	currentChain := ""
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "Chain ") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				currentChain = fields[1]
			}
			continue
		}
		match := markerPattern.FindStringSubmatch(line)
		if len(match) < 3 || currentChain == "" {
			continue
		}
		markers[match[1]] = true
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		bytesValue, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		marker := match[1] + ":" + match[2]
		if chainCounters[marker] == nil {
			chainCounters[marker] = map[string]uint64{}
		}
		chainCounters[marker][currentChain] += bytesValue
	}
}

func nftablesCounterSnapshot() map[int]trafficCounters {
	counters, _ := nftablesCounterSnapshotWithDiagnostics()
	return counters
}

func nftablesCounterSnapshotWithDiagnostics() (map[int]trafficCounters, map[int]bool) {
	out := map[int]trafficCounters{}
	markers := map[int]bool{}
	raw, err := commandOutputWithTimeout(5*time.Second, "nft", "-a", "list", "table", "inet", "forwardx")
	if err != nil {
		return out, markers
	}
	commentPattern := regexp.MustCompile(`fwx-rule-([0-9]+)(?::|-)(in|out)`)
	chainPattern := regexp.MustCompile(`^chain\s+(in|out)_([0-9]+)\s+\{`)
	currentLegacyDirection := ""
	currentLegacyRuleID := 0
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if match := chainPattern.FindStringSubmatch(line); len(match) >= 3 {
			currentLegacyDirection = match[1]
			currentLegacyRuleID, _ = strconv.Atoi(match[2])
			if currentLegacyRuleID > 0 {
				markers[currentLegacyRuleID] = true
			}
			continue
		}
		if strings.HasPrefix(line, "chain ") {
			currentLegacyDirection = ""
			currentLegacyRuleID = 0
		}
		commentMatch := commentPattern.FindStringSubmatch(line)
		if len(commentMatch) >= 3 {
			ruleID, _ := strconv.Atoi(commentMatch[1])
			if ruleID > 0 {
				markers[ruleID] = true
			}
		}
		bytesValue, ok := nftCounterBytes(line)
		if !ok {
			continue
		}
		if len(commentMatch) >= 3 {
			ruleID, _ := strconv.Atoi(commentMatch[1])
			counters := out[ruleID]
			if commentMatch[2] == "in" {
				counters.In += bytesValue
			} else {
				counters.Out += bytesValue
			}
			out[ruleID] = counters
			continue
		}
		if currentLegacyRuleID > 0 && currentLegacyDirection != "" {
			counters := out[currentLegacyRuleID]
			if currentLegacyDirection == "in" {
				counters.In += bytesValue
			} else {
				counters.Out += bytesValue
			}
			out[currentLegacyRuleID] = counters
		}
	}
	return out, markers
}

func nftProcessCounterSnapshotWithDiagnostics() (map[string]trafficCounters, map[string]bool) {
	out := map[string]trafficCounters{}
	markers := map[string]bool{}
	raw, err := commandOutputWithTimeout(5*time.Second, "nft", "-a", "list", "table", "inet", nftProcessTrafficTable)
	if err != nil {
		return out, markers
	}
	return parseNftProcessCounterSnapshot(string(raw))
}

func parseNftProcessCounterSnapshot(raw string) (map[string]trafficCounters, map[string]bool) {
	out := map[string]trafficCounters{}
	markers := map[string]bool{}
	markerPattern := regexp.MustCompile(`fwx-stat-([0-9]+):(in|out)`)
	for _, line := range strings.Split(raw, "\n") {
		match := markerPattern.FindStringSubmatch(line)
		if len(match) < 3 {
			continue
		}
		port, direction := match[1], match[2]
		markers[port] = true
		bytesValue, ok := nftCounterBytes(line)
		if !ok {
			continue
		}
		counters := out[port]
		if direction == "in" {
			counters.In += bytesValue
		} else {
			counters.Out += bytesValue
		}
		out[port] = counters
	}
	return out, markers
}

func nftCounterBytes(line string) (uint64, bool) {
	fields := strings.Fields(line)
	for i := 0; i+1 < len(fields); i++ {
		if fields[i] != "bytes" {
			continue
		}
		value, err := strconv.ParseUint(fields[i+1], 10, 64)
		if err == nil {
			return value, true
		}
	}
	return 0, false
}

func logTrafficCounterDiagnostic(state localRuleState, counters trafficCounters, din uint64, dout uint64, connections uint64, nftCounters map[int]trafficCounters, diagnostics trafficDiagnosticsSnapshot) {
	if state.RuleID <= 0 || state.Port == "" {
		return
	}
	key := "traffic-diag:" + strconv.Itoa(state.RuleID) + ":" + state.Port
	if !shouldLogAgentReport(key, 5*time.Minute) {
		return
	}
	target := strings.Trim(strings.TrimSpace(state.TargetIP), "[]")
	targetIPv6 := strings.Contains(target, ":")
	iptablesMarker := diagnostics.iptablesMarkers[state.Port]
	ip6tablesMarker := diagnostics.ip6tablesMarkers[state.Port]
	nftMarker := false
	if state.ForwardType == "nftables" {
		nftMarker = diagnostics.nftMarkers[state.RuleID]
	}
	nftProcessMarker := diagnostics.nftProcessMarkers[state.Port]
	_, nftCounter := nftCounters[state.RuleID]
	if counters.In == 0 && counters.Out == 0 && connections > 0 {
		logf("traffic diag missing counters rule=%d port=%s type=%s target=%s:%d targetIPv6=%v counters=0/0 delta=%d/%d conns=%d iptablesMarker=%v ip6tablesMarker=%v nftMarker=%v nftProcessMarker=%v nftCounter=%v hint=traffic-is-flowing-but-counter-rule-did-not-match", state.RuleID, state.Port, state.ForwardType, target, state.TargetPort, targetIPv6, din, dout, connections, iptablesMarker, ip6tablesMarker, nftMarker, nftProcessMarker, nftCounter)
		return
	}
	if agentVerboseLogs && counters.In == 0 && counters.Out == 0 && connections == 0 {
		logf("traffic diag rule=%d port=%s type=%s target=%s:%d targetIPv6=%v counters=0/0 delta=0/0 conns=0 iptablesMarker=%v ip6tablesMarker=%v nftMarker=%v nftProcessMarker=%v nftCounter=%v", state.RuleID, state.Port, state.ForwardType, target, state.TargetPort, targetIPv6, iptablesMarker, ip6tablesMarker, nftMarker, nftProcessMarker, nftCounter)
		return
	}
	if agentVerboseLogs && (din > 0 || dout > 0 || connections > 0 || targetIPv6 || state.ForwardType == "nftables" || state.ForwardType == "iptables") {
		logf("traffic diag rule=%d port=%s type=%s target=%s:%d targetIPv6=%v counters=%d/%d delta=%d/%d conns=%d iptablesMarker=%v ip6tablesMarker=%v nftMarker=%v nftProcessMarker=%v nftCounter=%v", state.RuleID, state.Port, state.ForwardType, target, state.TargetPort, targetIPv6, counters.In, counters.Out, din, dout, connections, iptablesMarker, ip6tablesMarker, nftMarker, nftProcessMarker, nftCounter)
	}
}

func conntrackConnectionsSnapshot(states []localRuleState) map[string]uint64 {
	out := map[string]uint64{}
	ports := map[string]bool{}
	for _, state := range states {
		if state.Port != "" {
			ports[state.Port] = true
		}
	}
	if len(ports) == 0 {
		return out
	}
	raw, err := os.ReadFile("/proc/net/nf_conntrack")
	if err != nil {
		raw, err = os.ReadFile("/proc/net/ip_conntrack")
		if err != nil {
			return out
		}
	}
	dportPattern := regexp.MustCompile(`\bdport=([0-9]+)\b`)
	for _, line := range strings.Split(string(raw), "\n") {
		if line == "" {
			continue
		}
		seen := map[string]bool{}
		for _, match := range dportPattern.FindAllStringSubmatch(line, -1) {
			if len(match) < 2 || !ports[match[1]] || seen[match[1]] {
				continue
			}
			out[match[1]]++
			seen[match[1]] = true
		}
	}
	return out
}

func conntrackConnections(port string) uint64 {
	cmd := fmt.Sprintf(`awk -v p="dport=%s" 'index($0,p" ")>0 {c++} END{print c+0}' /proc/net/nf_conntrack 2>/dev/null`, port)
	out, err := commandOutputWithTimeout(5*time.Second, "sh", "-lc", cmd)
	if err != nil {
		return 0
	}
	v, _ := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
	return v
}

func iptablesBytes(port string, direction string) uint64 {
	counters := iptablesCounterSnapshot()[port]
	if direction == "out" {
		if counters.Out > 0 {
			return counters.Out
		}
	} else if counters.In > 0 {
		return counters.In
	}
	legacyChain := "FWX_IN_" + port
	if direction == "out" {
		legacyChain = "FWX_OUT_" + port
	}
	return iptablesLegacyBytes(legacyChain)
}

func iptablesLegacyBytes(chain string) uint64 {
	parentChains := []string{"PREROUTING", "INPUT", "FORWARD", "OUTPUT", "POSTROUTING"}
	byChain := map[string]uint64{}
	for _, binary := range []string{"iptables", "ip6tables"} {
		for _, parent := range parentChains {
			raw, err := commandOutputWithTimeout(5*time.Second, binary, "-t", "mangle", "-nvxL", parent)
			if err != nil {
				continue
			}
			for _, line := range strings.Split(string(raw), "\n") {
				if !strings.Contains(line, chain) {
					continue
				}
				fields := strings.Fields(line)
				if len(fields) < 2 {
					continue
				}
				value, err := strconv.ParseUint(fields[1], 10, 64)
				if err != nil {
					continue
				}
				byChain[parent] += value
			}
		}
	}
	maxBytes := uint64(0)
	for _, value := range byChain {
		if value > maxBytes {
			maxBytes = value
		}
	}
	return maxBytes
}

func nftablesBytes(ruleID int, port string) (uint64, uint64) {
	in := nftablesRuleBytes("traffic_forward", ruleID, "in")
	out := nftablesRuleBytes("traffic_forward", ruleID, "out")
	if in == 0 {
		in = nftablesRuleBytes("traffic_prerouting", ruleID, "in")
	}
	if out == 0 {
		out = nftablesRuleBytes("traffic_postrouting", ruleID, "out")
	}
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
	colonMarker := fmt.Sprintf("fwx-rule-%d:%s", ruleID, direction)
	dashMarker := fmt.Sprintf("fwx-rule-%d-%s", ruleID, direction)
	cmd := fmt.Sprintf(`nft -a list chain inet forwardx %s 2>/dev/null | awk -v colon=%s -v dash=%s '(index($0, colon) || index($0, dash)) && /counter packets/ {for(i=1;i<=NF;i++) if($i=="bytes") {s+=$(i+1)}} END{print s+0}'`, shellQuote(chain), shellQuote(colonMarker), shellQuote(dashMarker))
	out, err := commandOutputWithTimeout(5*time.Second, "sh", "-lc", cmd)
	if err != nil {
		return 0
	}
	v, _ := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
	return v
}

func nftablesChainBytes(chain string) uint64 {
	cmd := fmt.Sprintf(`nft -a list chain inet forwardx %s 2>/dev/null | awk '/counter packets/ {for(i=1;i<=NF;i++) if($i=="bytes") {s+=$(i+1)}} END{print s+0}'`, shellQuote(chain))
	out, err := commandOutputWithTimeout(5*time.Second, "sh", "-lc", cmd)
	if err != nil {
		return 0
	}
	v, _ := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
	return v
}

func readPrev(port string) (int, uint64, uint64, uint64) {
	trafficPrevMu.Lock()
	if cached, ok := trafficPrevCache[port]; ok {
		trafficPrevMu.Unlock()
		return cached.ruleID, cached.in, cached.out, cached.conns
	}
	trafficPrevMu.Unlock()
	raw, err := os.ReadFile(trafficStateDir + "/traffic_" + port + ".prev")
	if err != nil {
		cacheTrafficPrev(port, trafficPrevState{})
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
		cacheTrafficPrev(port, trafficPrevState{ruleID: rid, in: prevIn, out: prevOut, conns: prevConns})
		return rid, prevIn, prevOut, prevConns
	}
	// 3-line legacy format: ruleID, in, out (no conns)
	if len(lines) >= 3 {
		rid, _ := strconv.Atoi(strings.TrimSpace(lines[0]))
		prevIn, _ := strconv.ParseUint(strings.TrimSpace(lines[1]), 10, 64)
		prevOut, _ := strconv.ParseUint(strings.TrimSpace(lines[2]), 10, 64)
		cacheTrafficPrev(port, trafficPrevState{ruleID: rid, in: prevIn, out: prevOut})
		return rid, prevIn, prevOut, 0
	}
	// 2-line legacy format: in, out (no ruleID, no conns)
	prevIn, _ := strconv.ParseUint(strings.TrimSpace(lines[0]), 10, 64)
	prevOut, _ := strconv.ParseUint(strings.TrimSpace(lines[1]), 10, 64)
	cacheTrafficPrev(port, trafficPrevState{in: prevIn, out: prevOut})
	return 0, prevIn, prevOut, 0
}

func writePrev(port string, ruleID int, in, out, conns uint64) {
	_ = writePrevState(port, trafficPrevState{ruleID: ruleID, in: in, out: out, conns: conns})
}

func writePrevState(port string, next trafficPrevState) error {
	trafficPrevMu.Lock()
	previous, exists := trafficPrevCache[port]
	trafficPrevMu.Unlock()
	if exists && previous == next {
		return nil
	}
	path := trafficStateDir + "/traffic_" + port + ".prev"
	data := []byte(fmt.Sprintf("%d\n%d\n%d\n%d\n", next.ruleID, next.in, next.out, next.conns))
	if err := writeTrafficStateFile(path, data, 0644); err != nil {
		return err
	}
	cacheTrafficPrev(port, next)
	return nil
}

func commitTrafficBaselines(reportSucceeded bool, updates []trafficBaselineUpdate) error {
	if !reportSucceeded {
		return nil
	}
	for _, update := range updates {
		if err := writePrevState(update.port, update.state); err != nil {
			return fmt.Errorf("persist traffic baseline port %s: %w", update.port, err)
		}
	}
	return nil
}

func cacheTrafficPrev(port string, state trafficPrevState) {
	trafficPrevMu.Lock()
	trafficPrevCache[port] = state
	trafficPrevMu.Unlock()
}

func invalidateTrafficPrev(port string) {
	trafficPrevMu.Lock()
	delete(trafficPrevCache, port)
	trafficPrevMu.Unlock()
}

func delta(cur, prev uint64) uint64 {
	if cur >= prev {
		return cur - prev
	}
	return cur
}
