package main

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

func reportTraffic(cfg config, bytesIn, bytesOut uint64) {
	if cfg.PanelURL == "" || cfg.Token == "" || cfg.RuleID <= 0 || (bytesIn == 0 && bytesOut == 0) {
		return
	}
	payload := map[string]any{
		"stats": []map[string]any{{
			"ruleId":      cfg.RuleID,
			"bytesIn":     bytesIn,
			"bytesOut":    bytesOut,
			"connections": 0,
		}},
	}
	env, err := encryptEnvelope(payload, cfg.Token)
	if err != nil {
		log.Printf("traffic encrypt failed rule=%d: %v", cfg.RuleID, err)
		return
	}
	body, _ := json.Marshal(env)
	req, err := http.NewRequest("POST", strings.TrimRight(cfg.PanelURL, "/")+"/api/agent/traffic", bytes.NewReader(body))
	if err != nil {
		log.Printf("traffic request failed rule=%d: %v", cfg.RuleID, err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Agent-Encrypted", "1")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("traffic report failed rule=%d in=%d out=%d: %v", cfg.RuleID, bytesIn, bytesOut, err)
		return
	}
	_ = resp.Body.Close()
	if resp.StatusCode >= 300 {
		log.Printf("traffic report status rule=%d in=%d out=%d status=%s", cfg.RuleID, bytesIn, bytesOut, resp.Status)
	}
}

func startTrafficReporter(cfg config, counter *trafficCounter) func() {
	done := make(chan struct{})
	var lastIn, lastOut uint64
	reportDelta := func() {
		curIn := counter.in.Load()
		curOut := counter.out.Load()
		deltaIn := curIn - lastIn
		deltaOut := curOut - lastOut
		if deltaIn > 0 || deltaOut > 0 {
			reportTraffic(cfg, deltaIn, deltaOut)
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
