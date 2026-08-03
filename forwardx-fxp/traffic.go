package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	trafficBatchInterval      = 10 * time.Second
	trafficDiagnosticInterval = time.Minute
)

type trafficBatchKey struct {
	panelURL   string
	token      string
	producerID string
}

type trafficBatchValue struct {
	bytesIn     uint64
	bytesOut    uint64
	connections uint64
}

type pendingTrafficBatch struct {
	reportID string
	byRule   map[int]trafficBatchValue
}

var trafficBatchMu sync.Mutex
var trafficBatchFlushMu sync.Mutex
var trafficBatchWorkerOnce sync.Once
var trafficBatchWake = make(chan struct{}, 1)
var trafficBatches = map[trafficBatchKey]map[int]trafficBatchValue{}
var trafficPendingReports = map[trafficBatchKey]pendingTrafficBatch{}
var trafficReportSequence atomic.Uint64
var trafficHTTPClient = &http.Client{Timeout: 10 * time.Second}
var trafficDiagnostics = struct {
	sync.Mutex
	last map[string]time.Time
}{last: make(map[string]time.Time)}

func enqueueTraffic(cfg config, bytesIn, bytesOut uint64, connectionDeltas ...uint64) {
	panelURL := strings.TrimRight(strings.TrimSpace(cfg.PanelURL), "/")
	token := strings.TrimSpace(cfg.Token)
	connections := uint64(0)
	if len(connectionDeltas) > 0 {
		connections = connectionDeltas[0]
	}
	if bytesIn == 0 && bytesOut == 0 && connections == 0 {
		return
	}
	missing := make([]string, 0, 3)
	if panelURL == "" {
		missing = append(missing, "panelUrl")
	}
	if token == "" {
		missing = append(missing, "token")
	}
	if cfg.RuleID <= 0 {
		missing = append(missing, "ruleId")
	}
	if len(missing) > 0 {
		logTrafficDiagnostic(
			trafficConfigDiagnosticKey(cfg, missing),
			"traffic report skipped role=%q tunnel=%d rule=%d listen=%d missing=%s",
			strings.ToLower(strings.TrimSpace(cfg.Role)),
			cfg.TunnelID,
			cfg.RuleID,
			cfg.ListenPort,
			strings.Join(missing, ","),
		)
		return
	}
	key := trafficBatchKey{panelURL: panelURL, token: token, producerID: fxpTrafficProducerID(cfg)}
	trafficBatchMu.Lock()
	byRule := trafficBatches[key]
	if byRule == nil {
		byRule = map[int]trafficBatchValue{}
		trafficBatches[key] = byRule
	}
	current := byRule[cfg.RuleID]
	current.bytesIn += bytesIn
	current.bytesOut += bytesOut
	current.connections += connections
	byRule[cfg.RuleID] = current
	trafficBatchMu.Unlock()
	startTrafficBatchWorker()
}

func trafficConfigDiagnosticKey(cfg config, missing []string) string {
	return fmt.Sprintf(
		"config:%s:%d:%d:%d:%s",
		strings.ToLower(strings.TrimSpace(cfg.Role)),
		cfg.TunnelID,
		cfg.RuleID,
		cfg.ListenPort,
		strings.Join(missing, ","),
	)
}

func logTrafficDiagnostic(key, format string, args ...any) {
	now := time.Now()
	trafficDiagnostics.Lock()
	last := trafficDiagnostics.last[key]
	if !last.IsZero() && now.Sub(last) < trafficDiagnosticInterval {
		trafficDiagnostics.Unlock()
		return
	}
	trafficDiagnostics.last[key] = now
	if len(trafficDiagnostics.last) > 1024 {
		for diagnosticKey, loggedAt := range trafficDiagnostics.last {
			if now.Sub(loggedAt) >= trafficDiagnosticInterval {
				delete(trafficDiagnostics.last, diagnosticKey)
			}
		}
	}
	trafficDiagnostics.Unlock()
	log.Printf(format, args...)
}

func safeTrafficReportError(err error, token string) string {
	if err == nil {
		return "unknown error"
	}
	message := err.Error()
	if token = strings.TrimSpace(token); token != "" {
		message = strings.ReplaceAll(message, token, "[redacted]")
	}
	return message
}

func startTrafficBatchWorker() {
	trafficBatchWorkerOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(trafficBatchInterval)
			defer ticker.Stop()
			for {
				select {
				case <-ticker.C:
				case <-trafficBatchWake:
				}
				flushTrafficBatches()
			}
		}()
	})
}

func wakeTrafficBatchWorker() {
	startTrafficBatchWorker()
	select {
	case trafficBatchWake <- struct{}{}:
	default:
	}
}

func trafficBatchSnapshot() map[trafficBatchKey]map[int]trafficBatchValue {
	trafficBatchMu.Lock()
	defer trafficBatchMu.Unlock()
	snapshot := make(map[trafficBatchKey]map[int]trafficBatchValue, len(trafficBatches))
	for key, byRule := range trafficBatches {
		copied := make(map[int]trafficBatchValue, len(byRule))
		for ruleID, value := range byRule {
			if value.bytesIn > 0 || value.bytesOut > 0 || value.connections > 0 {
				copied[ruleID] = value
			}
		}
		if len(copied) > 0 {
			snapshot[key] = copied
		}
	}
	return snapshot
}

func acknowledgeTrafficBatch(key trafficBatchKey, sent map[int]trafficBatchValue) {
	trafficBatchMu.Lock()
	defer trafficBatchMu.Unlock()
	delete(trafficPendingReports, key)
	byRule := trafficBatches[key]
	for ruleID, value := range sent {
		current, ok := byRule[ruleID]
		if !ok {
			continue
		}
		if current.bytesIn >= value.bytesIn {
			current.bytesIn -= value.bytesIn
		} else {
			current.bytesIn = 0
		}
		if current.bytesOut >= value.bytesOut {
			current.bytesOut -= value.bytesOut
		} else {
			current.bytesOut = 0
		}
		if current.connections >= value.connections {
			current.connections -= value.connections
		} else {
			current.connections = 0
		}
		if current.bytesIn == 0 && current.bytesOut == 0 && current.connections == 0 {
			delete(byRule, ruleID)
		} else {
			byRule[ruleID] = current
		}
	}
	if len(byRule) == 0 {
		delete(trafficBatches, key)
	}
}

func newFXPTrafficReportID() string {
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err == nil {
		return "fxp-" + hex.EncodeToString(nonce)
	}
	return fmt.Sprintf("fxp-%x-%x-%x", time.Now().UnixNano(), os.Getpid(), trafficReportSequence.Add(1))
}

func fxpTrafficProducerID(cfg config) string {
	identity := fmt.Sprintf(
		"%s\x00%s\x00%s\x00%d\x00%d\x00%d",
		strings.TrimRight(strings.TrimSpace(cfg.PanelURL), "/"),
		strings.TrimSpace(cfg.Token),
		strings.ToLower(strings.TrimSpace(cfg.Role)),
		cfg.TunnelID,
		cfg.RuleID,
		cfg.ListenPort,
	)
	hash := sha256.Sum256([]byte(identity))
	return "fxp-" + hex.EncodeToString(hash[:])
}

func postTrafficBatch(key trafficBatchKey, pending pendingTrafficBatch) bool {
	byRule := pending.byRule
	ruleIDs := make([]int, 0, len(byRule))
	for ruleID := range byRule {
		ruleIDs = append(ruleIDs, ruleID)
	}
	sort.Ints(ruleIDs)
	stats := make([]map[string]any, 0, len(ruleIDs))
	for _, ruleID := range ruleIDs {
		value := byRule[ruleID]
		stats = append(stats, map[string]any{
			"ruleId": ruleID, "bytesIn": value.bytesIn, "bytesOut": value.bytesOut, "connections": value.connections,
		})
	}
	env, err := encryptEnvelope(map[string]any{
		"stats":            stats,
		"reportId":         pending.reportID,
		"reportProducerId": key.producerID,
	}, key.token)
	if err != nil {
		logTrafficDiagnostic(
			"encrypt:"+key.producerID,
			"traffic batch encrypt failed rules=%d: %s",
			len(stats),
			safeTrafficReportError(err, key.token),
		)
		return false
	}
	body, _ := json.Marshal(env)
	resp, err := postFXPEncryptedPanelRequest(
		trafficHTTPClient,
		key.panelURL,
		key.token,
		"/api/agent/traffic",
		body,
	)
	if err != nil {
		logTrafficDiagnostic(
			"request:"+key.producerID,
			"traffic batch report request failed firstRule=%d rules=%d: %s",
			firstTrafficRuleID(ruleIDs),
			len(stats),
			safeTrafficReportError(err, key.token),
		)
		return false
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		logTrafficDiagnostic(
			"status:"+key.producerID,
			"traffic batch report rejected firstRule=%d rules=%d status=%d",
			firstTrafficRuleID(ruleIDs),
			len(stats),
			resp.StatusCode,
		)
		return false
	}
	return true

}

func firstTrafficRuleID(ruleIDs []int) int {
	if len(ruleIDs) == 0 {
		return 0
	}
	return ruleIDs[0]
}

func flushTrafficBatches() {
	trafficBatchFlushMu.Lock()
	defer trafficBatchFlushMu.Unlock()
	for key, pending := range trafficBatchPendingSnapshot() {
		if postTrafficBatch(key, pending) {
			acknowledgeTrafficBatch(key, pending.byRule)
		}
	}
}

func trafficBatchPendingSnapshot() map[trafficBatchKey]pendingTrafficBatch {
	trafficBatchMu.Lock()
	defer trafficBatchMu.Unlock()
	keys := make(map[trafficBatchKey]struct{}, len(trafficBatches)+len(trafficPendingReports))
	for key := range trafficBatches {
		keys[key] = struct{}{}
	}
	for key := range trafficPendingReports {
		keys[key] = struct{}{}
	}
	out := make(map[trafficBatchKey]pendingTrafficBatch, len(keys))
	for key := range keys {
		if pending := trafficPendingReports[key]; len(pending.byRule) > 0 {
			copy := make(map[int]trafficBatchValue, len(pending.byRule))
			for ruleID, value := range pending.byRule {
				copy[ruleID] = value
			}
			out[key] = pendingTrafficBatch{reportID: pending.reportID, byRule: copy}
			continue
		}
		current := trafficBatches[key]
		if len(current) == 0 {
			continue
		}
		copy := make(map[int]trafficBatchValue, len(current))
		for ruleID, value := range current {
			if value.bytesIn > 0 || value.bytesOut > 0 || value.connections > 0 {
				copy[ruleID] = value
			}
		}
		if len(copy) > 0 {
			pending := pendingTrafficBatch{reportID: newFXPTrafficReportID(), byRule: copy}
			trafficPendingReports[key] = pending
			out[key] = pending
		}
	}
	return out
}

func startTrafficReporter(cfg config, counter *trafficCounter) func() {
	done := make(chan struct{})
	var reportMu sync.Mutex
	var lastIn, lastOut, lastConnections uint64
	reportDelta := func() {
		reportMu.Lock()
		defer reportMu.Unlock()
		curIn := counter.in.Load()
		curOut := counter.out.Load()
		deltaIn := curIn - lastIn
		deltaOut := curOut - lastOut
		curConnections := counter.connections.Load()
		deltaConnections := curConnections - lastConnections
		if deltaIn > 0 || deltaOut > 0 || deltaConnections > 0 {
			enqueueTraffic(cfg, deltaIn, deltaOut, deltaConnections)
			lastIn = curIn
			lastOut = curOut
			lastConnections = curConnections
		}
	}
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				reportDelta()
			case <-done:
				return
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			close(done)
			reportDelta()
			wakeTrafficBatchWorker()
		})
	}
}
