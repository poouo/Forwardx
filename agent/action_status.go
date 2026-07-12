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
	// 仅拷贝剩余部分，释放旧 slice 的前段内存。
	remaining := actionStatusReportOrder[limit:]
	newOrder := make([]string, len(remaining))
	copy(newOrder, remaining)
	actionStatusReportOrder = newOrder
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
	// 收集需要恢复的 key（去重），从后往前迭代维持原始优先级顺序。
	toRestore := make([]string, 0, len(reports))
	for index := len(reports) - 1; index >= 0; index-- {
		report := reports[index]
		if _, exists := actionStatusReports[report.key]; exists {
			continue
		}
		actionStatusReports[report.key] = report
		toRestore = append(toRestore, report.key)
	}
	if len(toRestore) == 0 {
		return
	}
	// toRestore 是倒序的，反转后得到原始顺序，一次性前插到队列头部，O(N)。
	for i, j := 0, len(toRestore)-1; i < j; i, j = i+1, j-1 {
		toRestore[i], toRestore[j] = toRestore[j], toRestore[i]
	}
	actionStatusReportOrder = append(toRestore, actionStatusReportOrder...)
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
