package main

import (
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

const selfTestWorkerConcurrency = 8
const selfTestQueueCapacity = 256

type selfTestJob struct {
	cfg  Config
	test selfTest
}

var selfTestQueue = make(chan selfTestJob, selfTestQueueCapacity)
var selfTestWorkersOnce sync.Once

func selfTestPoller(cfg Config) {
	activeUntil := time.Time{}
	for {
		var resp selfTestResp
		if err := post(cfg, "/api/agent/selftest-pull", map[string]any{}, &resp); err != nil {
			logAgentCommError("selftest-pull", err)
		} else {
			if len(resp.SelfTests) > 0 {
				activeUntil = time.Now().Add(selfTestActiveWindow)
			}
			for _, t := range resp.SelfTests {
				enqueueSelfTest(cfg, t)
			}
		}
		interval := selfTestIdlePollInterval
		if time.Now().Before(activeUntil) {
			interval = selfTestActivePollInterval
		}
		time.Sleep(interval)
	}
}

func enqueueSelfTest(cfg Config, t selfTest) {
	selfTestWorkersOnce.Do(startSelfTestWorkers)
	select {
	case selfTestQueue <- selfTestJob{cfg: cfg, test: t}:
	default:
		if shouldLogAgentReport("selftest-queue-full", agentReportLogInterval) {
			logf("selftest queue full; dropping test=%d target=%s", t.TestID, t.TargetIP)
		}
	}
}

func startSelfTestWorkers() {
	for i := 0; i < selfTestWorkerConcurrency; i++ {
		go func() {
			for job := range selfTestQueue {
				handleSelfTest(job.cfg, job.test)
			}
		}()
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
			logSelfTestReportError(t.TestID, t.TargetIP, err)
		}
		return
	}

	latency, reachable, resolvedTarget := 0, false, ""
	if t.WireGuardPeerID != "" && t.TunnelID > 0 {
		latency, reachable = wireGuardTCPLatency(t.TunnelID, t.WireGuardPeerID, t.TargetPort, 3*time.Second)
	} else {
		latency, reachable, resolvedTarget = tcpLatencyResolved(t.TargetIP, t.TargetPort, 3*time.Second)
	}
	target := net.JoinHostPort(t.TargetIP, strconv.Itoa(t.TargetPort))
	msg := ""
	if reachable {
		msg = fmt.Sprintf("目标 %s TCP可达，延迟 %dms", target, latency)
		if resolvedTarget != "" && resolvedTarget != normalizeNetworkTargetHost(t.TargetIP) {
			msg = fmt.Sprintf("%s，解析到 %s", msg, resolvedTarget)
		}
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
	if resolvedTarget != "" {
		payload["resolvedTargetIp"] = resolvedTarget
	}
	if err := post(cfg, "/api/agent/selftest-result", payload, &map[string]any{}); err != nil {
		logSelfTestReportError(t.TestID, target, err)
	}
}

func logSelfTestReportError(testID int, target string, err error) {
	if isTransientAgentCommError(err) {
		logAgentCommError("selftest-result", err)
		return
	}
	if shouldLogAgentReport("selftest-report-failed", agentReportLogInterval) {
		logf("selftest report failed test=%d target=%s: %v", testID, target, err)
	}
}
