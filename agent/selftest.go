package main

import (
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"
)

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
	if normalizeRuntimeProtocol(method) == "udp" {
		method = "ping"
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
