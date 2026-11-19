package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestPresenceCarriesRequestedNetworkSamplesWhileFullHeartbeatIsBlocked(t *testing.T) {
	previousPanelURL, _ := runtimePanelURL.Load().(string)
	previousRequested := presenceNetworkMetricsRequested.Load()
	previousSupported := agentPresenceSupported.Load()
	previousSuperseded := agentSuperseded.Swap(false)
	runtimePanelURL.Store("")
	presenceNetworkMetricsRequested.Store(false)
	t.Cleanup(func() {
		runtimePanelURL.Store(previousPanelURL)
		presenceNetworkMetricsRequested.Store(previousRequested)
		agentPresenceSupported.Store(previousSupported)
		agentSuperseded.Store(previousSuperseded)
		heartbeatMetricsWake.Store(false)
		for len(heartbeatWakeCh) > 0 {
			<-heartbeatWakeCh
		}
	})
	const token = "network-presence-test-token"
	var payloads []map[string]any
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/api/sync" {
			http.NotFound(w, req)
			return
		}
		var input envelope
		if err := json.NewDecoder(req.Body).Decode(&input); err != nil {
			t.Error(err)
			return
		}
		plain, err := decrypt(input, token)
		if err != nil {
			t.Error(err)
			return
		}
		var value map[string]any
		if err := json.Unmarshal(plain, &value); err != nil {
			t.Error(err)
			return
		}
		if value["path"] != "/api/agent/presence" {
			t.Errorf("unexpected logical path: %v", value["path"])
		}
		payloads = append(payloads, value["payload"].(map[string]any))
		response, err := encrypt(map[string]any{"presence": true, "presenceSupported": true, "refreshMetrics": len(payloads) == 1, "nextPresenceInterval": 5}, token)
		if err != nil {
			t.Error(err)
			return
		}
		_ = json.NewEncoder(w).Encode(response)
	}))
	defer panel.Close()
	finish, ok := heartbeatRequests.tryStart(heartbeatRequestLaneFull)
	if !ok {
		t.Fatal("could not hold full heartbeat lane")
	}
	defer finish(false)
	for i := 0; i < 3; i++ {
		if _, _, err := heartbeatPresence(Config{PanelURL: panel.URL, Token: token}); err != nil {
			t.Fatal(err)
		}
	}
	if len(payloads) != 3 {
		t.Fatalf("presence requests=%d", len(payloads))
	}
	if payloads[0]["networkSample"] != nil || payloads[2]["networkSample"] != nil {
		t.Fatal("idle presence must omit network samples")
	}
	if _, ok := payloads[1]["networkSample"].(map[string]any); !ok {
		t.Fatal("live viewer did not receive a network sample while full lane was blocked")
	}
	if payloads[1]["localState"] != nil || payloads[1]["connectionStats"] != nil {
		t.Fatal("presence must not collect expensive runtime state")
	}
}

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
