package main

import (
	"encoding/json"
	"testing"
	"time"
)

func TestPresenceMetricsRefreshWithoutSSE(t *testing.T) {
	heartbeatMetricsWake.Store(false)
	lastMetricsHeartbeatAt.Store(0)
	for len(heartbeatWakeCh) > 0 {
		<-heartbeatWakeCh
	}
	t.Cleanup(func() {
		heartbeatMetricsWake.Store(false)
		lastMetricsHeartbeatAt.Store(0)
		for len(heartbeatWakeCh) > 0 {
			<-heartbeatWakeCh
		}
	})
	now := time.Now()
	var response heartbeatResp
	if err := json.Unmarshal([]byte(`{"presence":true,"refreshMetrics":true}`), &response); err != nil {
		t.Fatal(err)
	}
	requestMetricsHeartbeat(false, now)
	if heartbeatMetricsWake.Load() || len(heartbeatWakeCh) != 0 {
		t.Fatal("presence without live viewers must not request metric collection")
	}
	lastMetricsHeartbeatAt.Store(now.Add(-time.Second).UnixMilli())
	requestMetricsHeartbeat(response.RefreshMetrics, now)
	if heartbeatMetricsWake.Load() || len(heartbeatWakeCh) != 0 {
		t.Fatal("a recent sample must not cause an extra metrics request")
	}
	lastMetricsHeartbeatAt.Store(now.Add(-3 * time.Second).UnixMilli())
	requestMetricsHeartbeat(response.RefreshMetrics, now)
	requestMetricsHeartbeat(response.RefreshMetrics, now)
	if !heartbeatMetricsWake.Load() || len(heartbeatWakeCh) != 1 {
		t.Fatal("presence must coalesce refresh requests and wake the heartbeat loop without SSE")
	}
	metricsWake := heartbeatMetricsWake.Swap(false)
	lastFull := now.Add(-time.Minute)
	if !shouldUseMetricsOnlyHeartbeat(metricsWake, false, false, false, 0, lastFull, now) {
		t.Fatal("a presence refresh should use the lightweight metrics path, not a runtime audit")
	}
	if shouldUseMetricsOnlyHeartbeat(metricsWake, false, false, true, 0, lastFull, now) {
		t.Fatal("configuration changes must retain priority over a metrics refresh")
	}
	if shouldUseMetricsOnlyHeartbeat(metricsWake, false, false, false, 0, now.Add(-agentFullHeartbeatInterval), now) {
		t.Fatal("metrics refresh must not suppress the periodic full audit")
	}
}
