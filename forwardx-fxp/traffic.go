package main

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

const trafficBatchInterval = 10 * time.Second

type trafficBatchKey struct {
	panelURL string
	token    string
}

type trafficBatchValue struct {
	bytesIn  uint64
	bytesOut uint64
}

var trafficBatchMu sync.Mutex
var trafficBatchFlushMu sync.Mutex
var trafficBatchWorkerOnce sync.Once
var trafficBatches = map[trafficBatchKey]map[int]trafficBatchValue{}
var trafficHTTPClient = &http.Client{Timeout: 10 * time.Second}

func enqueueTraffic(cfg config, bytesIn, bytesOut uint64) {
	panelURL := strings.TrimRight(strings.TrimSpace(cfg.PanelURL), "/")
	token := strings.TrimSpace(cfg.Token)
	if panelURL == "" || token == "" || cfg.RuleID <= 0 || (bytesIn == 0 && bytesOut == 0) {
		return
	}
	key := trafficBatchKey{panelURL: panelURL, token: token}
	trafficBatchMu.Lock()
	byRule := trafficBatches[key]
	if byRule == nil {
		byRule = map[int]trafficBatchValue{}
		trafficBatches[key] = byRule
	}
	current := byRule[cfg.RuleID]
	current.bytesIn += bytesIn
	current.bytesOut += bytesOut
	byRule[cfg.RuleID] = current
	trafficBatchMu.Unlock()
	startTrafficBatchWorker()
}

func startTrafficBatchWorker() {
	trafficBatchWorkerOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(trafficBatchInterval)
			defer ticker.Stop()
			for range ticker.C {
				flushTrafficBatches()
			}
		}()
	})
}

func trafficBatchSnapshot() map[trafficBatchKey]map[int]trafficBatchValue {
	trafficBatchMu.Lock()
	defer trafficBatchMu.Unlock()
	snapshot := make(map[trafficBatchKey]map[int]trafficBatchValue, len(trafficBatches))
	for key, byRule := range trafficBatches {
		copied := make(map[int]trafficBatchValue, len(byRule))
		for ruleID, value := range byRule {
			if value.bytesIn > 0 || value.bytesOut > 0 {
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
		if current.bytesIn == 0 && current.bytesOut == 0 {
			delete(byRule, ruleID)
		} else {
			byRule[ruleID] = current
		}
	}
	if len(byRule) == 0 {
		delete(trafficBatches, key)
	}
}

func postTrafficBatch(key trafficBatchKey, byRule map[int]trafficBatchValue) bool {
	ruleIDs := make([]int, 0, len(byRule))
	for ruleID := range byRule {
		ruleIDs = append(ruleIDs, ruleID)
	}
	sort.Ints(ruleIDs)
	stats := make([]map[string]any, 0, len(ruleIDs))
	for _, ruleID := range ruleIDs {
		value := byRule[ruleID]
		stats = append(stats, map[string]any{
			"ruleId": ruleID, "bytesIn": value.bytesIn, "bytesOut": value.bytesOut, "connections": 0,
		})
	}
	env, err := encryptEnvelope(map[string]any{"stats": stats}, key.token)
	if err != nil {
		log.Printf("traffic batch encrypt failed rules=%d: %v", len(stats), err)
		return false
	}
	body, _ := json.Marshal(env)
	req, err := http.NewRequest("POST", key.panelURL+"/api/agent/traffic", bytes.NewReader(body))
	if err != nil {
		log.Printf("traffic batch request failed rules=%d: %v", len(stats), err)
		return false
	}
	req.Header.Set("Authorization", "Bearer "+key.token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Agent-Encrypted", "1")
	resp, err := trafficHTTPClient.Do(req)
	if err != nil {
		log.Printf("traffic batch report failed rules=%d: %v", len(stats), err)
		return false
	}
	_ = resp.Body.Close()
	if resp.StatusCode >= 300 {
		log.Printf("traffic batch report status rules=%d status=%s", len(stats), resp.Status)
		return false
	}
	return true

}

func flushTrafficBatches() {
	trafficBatchFlushMu.Lock()
	defer trafficBatchFlushMu.Unlock()
	for key, byRule := range trafficBatchSnapshot() {
		if postTrafficBatch(key, byRule) {
			acknowledgeTrafficBatch(key, byRule)
		}
	}
}

func startTrafficReporter(cfg config, counter *trafficCounter) func() {
	done := make(chan struct{})
	var reportMu sync.Mutex
	var lastIn, lastOut uint64
	reportDelta := func() {
		reportMu.Lock()
		defer reportMu.Unlock()
		curIn := counter.in.Load()
		curOut := counter.out.Load()
		deltaIn := curIn - lastIn
		deltaOut := curOut - lastOut
		if deltaIn > 0 || deltaOut > 0 {
			enqueueTraffic(cfg, deltaIn, deltaOut)
			lastIn = curIn
			lastOut = curOut
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
		})
	}
}
