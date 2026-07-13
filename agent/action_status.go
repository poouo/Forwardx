package main

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

const actionStatusBatchSize = 200
const actionStatusFlushInterval = 100 * time.Millisecond
const actionStatusRetryMinDelay = time.Second
const actionStatusRetryMaxDelay = 30 * time.Second

type actionStatusPayload struct {
	RuleID      int    `json:"ruleId"`
	TunnelID    int    `json:"tunnelId"`
	StatusType  string `json:"statusType,omitempty"`
	SourcePort  int    `json:"sourcePort,omitempty"`
	IsRunning   bool   `json:"isRunning"`
	Message     string `json:"message,omitempty"`
	ForwardType string `json:"forwardType,omitempty"`
}

type actionStatusReport struct {
	key     string
	cfg     Config
	payload actionStatusPayload
}

type queuedActionStatusReport = actionStatusReport

var actionStatusReportsMu sync.Mutex
var actionStatusReports = map[string]actionStatusReport{}
var actionStatusReportOrder []string
var actionStatusReporterOnce sync.Once
var actionStatusReporterWake = make(chan struct{}, 1)

func actionStatusReportKey(payload actionStatusPayload) string {
	statusType := strings.TrimSpace(payload.StatusType)
	if statusType == "" {
		statusType = "rule"
	}
	return fmt.Sprintf("%s:%d:%d:%d:%s", statusType, payload.RuleID, payload.TunnelID, payload.SourcePort, strings.TrimSpace(payload.ForwardType))
}

func enqueueActionStatusReport(cfg Config, a action, running bool, message string) {
	payload := actionStatusPayload{
		RuleID:      a.RuleID,
		TunnelID:    a.TunnelID,
		StatusType:  strings.TrimSpace(a.StatusType),
		SourcePort:  a.SourcePort,
		IsRunning:   running,
		Message:     strings.TrimSpace(message),
		ForwardType: strings.TrimSpace(a.ForwardType),
	}
	if payload.StatusType == "" {
		payload.StatusType = "rule"
	}
	key := actionStatusReportKey(payload)
	actionStatusReportsMu.Lock()
	if _, exists := actionStatusReports[key]; !exists {
		actionStatusReportOrder = append(actionStatusReportOrder, key)
	}
	actionStatusReports[key] = actionStatusReport{key: key, cfg: cfg, payload: payload}
	pending := len(actionStatusReports)
	actionStatusReportsMu.Unlock()
	if pending >= actionStatusBatchSize {
		wakeActionStatusReporter()
		return
	}
	wakeActionStatusReporter()
}

func wakeActionStatusReporter() {
	select {
	case actionStatusReporterWake <- struct{}{}:
	default:
	}
}

func takeActionStatusReports(limit int) []actionStatusReport {
	if limit <= 0 {
		return nil
	}
	actionStatusReportsMu.Lock()
	defer actionStatusReportsMu.Unlock()
	if len(actionStatusReportOrder) == 0 {
		return nil
	}
	if limit > len(actionStatusReportOrder) {
		limit = len(actionStatusReportOrder)
	}
	reports := make([]actionStatusReport, 0, limit)
	consumed := 0
	for consumed < len(actionStatusReportOrder) && len(reports) < limit {
		key := actionStatusReportOrder[consumed]
		consumed++
		report, ok := actionStatusReports[key]
		if !ok {
			continue
		}
		delete(actionStatusReports, key)
		reports = append(reports, report)
	}
	actionStatusReportOrder = append([]string(nil), actionStatusReportOrder[consumed:]...)
	return reports
}

func pendingActionStatusReportCount() int {
	actionStatusReportsMu.Lock()
	defer actionStatusReportsMu.Unlock()
	return len(actionStatusReports)
}

func restoreActionStatusReports(reports []actionStatusReport) {
	if len(reports) == 0 {
		return
	}
	actionStatusReportsMu.Lock()
	defer actionStatusReportsMu.Unlock()
	toRestore := make([]string, 0, len(reports))
	for index := len(reports) - 1; index >= 0; index-- {
		report := reports[index]
		if _, newerExists := actionStatusReports[report.key]; newerExists {
			continue
		}
		actionStatusReports[report.key] = report
		toRestore = append(toRestore, report.key)
	}
	for i, j := 0, len(toRestore)-1; i < j; i, j = i+1, j-1 {
		toRestore[i], toRestore[j] = toRestore[j], toRestore[i]
	}
	if len(toRestore) > 0 {
		actionStatusReportOrder = append(toRestore, actionStatusReportOrder...)
	}
}

func requeueActionStatusReports(reports []queuedActionStatusReport) {
	restoreActionStatusReports(reports)
}

func startActionStatusReporter() {
	actionStatusReporterOnce.Do(func() {
		go actionStatusReporterLoop()
	})
}

func actionStatusReporterLoop() {
	retryDelay := actionStatusRetryMinDelay
	for {
		<-actionStatusReporterWake
		time.Sleep(actionStatusFlushInterval)
		for {
			reports := takeActionStatusReports(actionStatusBatchSize)
			if len(reports) == 0 {
				break
			}
			if err := sendActionStatusReports(reports); err != nil {
				restoreActionStatusReports(reports)
				if shouldLogAgentReport("action-status-batch-failed", agentReportLogInterval) {
					logf("action status batch failed count=%d pending=%d retry=%s: %v", len(reports), pendingActionStatusReportCount(), retryDelay, err)
				}
				time.Sleep(retryDelay)
				if retryDelay < actionStatusRetryMaxDelay {
					retryDelay *= 2
					if retryDelay > actionStatusRetryMaxDelay {
						retryDelay = actionStatusRetryMaxDelay
					}
				}
				wakeActionStatusReporter()
				break
			}
			retryDelay = actionStatusRetryMinDelay
			if agentVerboseLogs {
				logf("action status batch reported count=%d pending=%d", len(reports), pendingActionStatusReportCount())
			}
		}
	}
}

func sendActionStatusReports(reports []queuedActionStatusReport) error {
	if len(reports) == 0 {
		return nil
	}
	type reportGroup struct {
		cfg     Config
		reports []queuedActionStatusReport
	}
	groupsByKey := map[string]*reportGroup{}
	groupOrder := make([]string, 0, 2)
	for _, report := range reports {
		key := strings.TrimSpace(report.cfg.PanelURL) + "\x00" + report.cfg.Token
		group := groupsByKey[key]
		if group == nil {
			group = &reportGroup{cfg: report.cfg}
			groupsByKey[key] = group
			groupOrder = append(groupOrder, key)
		}
		group.reports = append(group.reports, report)
	}
	for _, key := range groupOrder {
		group := groupsByKey[key]
		statuses := make([]actionStatusPayload, 0, len(group.reports))
		for _, report := range group.reports {
			statuses = append(statuses, report.payload)
		}
		var out map[string]any
		err := post(group.cfg, "/api/agent/rule-status-batch", map[string]any{"statuses": statuses}, &out)
		if err == nil {
			continue
		}
		if !actionStatusBatchUnsupported(err) {
			return err
		}
		for _, report := range group.reports {
			var singleOut map[string]any
			if singleErr := post(report.cfg, "/api/agent/rule-status", report.payload, &singleOut); singleErr != nil {
				return singleErr
			}
		}
	}
	return nil
}

func actionStatusBatchUnsupported(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "404") ||
		strings.Contains(message, "405") ||
		strings.Contains(message, "not found") ||
		strings.Contains(message, "invalid encrypted request")
}
