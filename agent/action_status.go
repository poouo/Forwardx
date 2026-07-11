package main

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

const actionStatusBatchSize = 100
const actionStatusFlushInterval = 250 * time.Millisecond

type actionStatusPayload struct {
	RuleID      int    `json:"ruleId"`
	TunnelID    int    `json:"tunnelId"`
	StatusType  string `json:"statusType"`
	IsRunning   bool   `json:"isRunning"`
	Message     string `json:"message,omitempty"`
	ForwardType string `json:"forwardType,omitempty"`
}

type actionStatusReport struct {
	key     string
	cfg     Config
	payload actionStatusPayload
}

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
	return fmt.Sprintf("%s:%d:%d:%s", statusType, payload.RuleID, payload.TunnelID, strings.TrimSpace(payload.ForwardType))
}

func enqueueActionStatusReport(cfg Config, a action, running bool, message string) {
	payload := actionStatusPayload{
		RuleID:      a.RuleID,
		TunnelID:    a.TunnelID,
		StatusType:  strings.TrimSpace(a.StatusType),
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
	actionStatusReportsMu.Unlock()
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
	for _, key := range actionStatusReportOrder[:limit] {
		if report, exists := actionStatusReports[key]; exists {
			reports = append(reports, report)
			delete(actionStatusReports, key)
		}
	}
	actionStatusReportOrder = append([]string(nil), actionStatusReportOrder[limit:]...)
	return reports
}

func pendingActionStatusReportCount() int {
	actionStatusReportsMu.Lock()
	defer actionStatusReportsMu.Unlock()
	return len(actionStatusReports)
}

func resetActionStatusReportsForTest() {
	actionStatusReportsMu.Lock()
	actionStatusReports = map[string]actionStatusReport{}
	actionStatusReportOrder = nil
	actionStatusReportsMu.Unlock()
}

func restoreActionStatusReports(reports []actionStatusReport) {
	if len(reports) == 0 {
		return
	}
	actionStatusReportsMu.Lock()
	defer actionStatusReportsMu.Unlock()
	for index := len(reports) - 1; index >= 0; index-- {
		report := reports[index]
		if _, exists := actionStatusReports[report.key]; exists {
			continue
		}
		actionStatusReports[report.key] = report
		actionStatusReportOrder = append([]string{report.key}, actionStatusReportOrder...)
	}
}

func startActionStatusReporter() {
	actionStatusReporterOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(actionStatusFlushInterval)
			defer ticker.Stop()
			for {
				select {
				case <-actionStatusReporterWake:
				case <-ticker.C:
				}
				flushActionStatusReports()
			}
		}()
	})
}

func flushActionStatusReports() {
	for {
		reports := takeActionStatusReports(actionStatusBatchSize)
		if len(reports) == 0 {
			return
		}
		cfg := reports[0].cfg
		batch := make([]actionStatusPayload, 0, len(reports))
		remaining := make([]actionStatusReport, 0)
		for _, report := range reports {
			if strings.TrimSpace(report.cfg.PanelURL) != strings.TrimSpace(cfg.PanelURL) || report.cfg.Token != cfg.Token {
				remaining = append(remaining, report)
				continue
			}
			batch = append(batch, report.payload)
		}
		if len(remaining) > 0 {
			restoreActionStatusReports(remaining)
		}
		if len(batch) == 0 {
			return
		}
		if err := post(cfg, "/api/agent/rule-status-batch", map[string]any{"statuses": batch}, &map[string]any{}); err != nil {
			if isTransientAgentCommError(err) {
				logAgentCommError("rule-status-batch", err)
			} else {
				logf("rule status batch report failed count=%d: %v", len(batch), err)
			}
			failed := make([]actionStatusReport, 0, len(batch))
			for _, report := range reports {
				if strings.TrimSpace(report.cfg.PanelURL) == strings.TrimSpace(cfg.PanelURL) && report.cfg.Token == cfg.Token {
					failed = append(failed, report)
				}
			}
			restoreActionStatusReports(failed)
			return
		}
	}
}
