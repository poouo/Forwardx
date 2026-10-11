package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGostOnlySyntheticSameTunnelProbeMayBeReplaced(t *testing.T) {
	live := gostTestConfig(t, `{"services":[{"name":"fwx-existing","addr":":21001"},{"name":"fwx-tunnel-probe-2","addr":":22001","handler":{"type":"tcp"},"forwarder":{"nodes":[{"addr":"127.0.0.1:9"}]},"status":{"state":"ready"}}]}`)
	desired := gostTestConfig(t, `{"services":[{"name":"fwx-existing","addr":":21001"},{"name":"fwx-tunnel-exit-2-101-22001","addr":":22001"}]}`)
	filtered, probes := planGostProbeReplacements(live, desired)
	additions, reason, err := planGostAdditions(filtered, desired)
	if err != nil || reason != "" || len(probes) != 1 || len(additions) != 1 {
		t.Fatalf("reason=%s probes=%v additions=%v err=%v", reason, probes, additions, err)
	}
	if probes[0].object["status"] != nil || len(live["services"].([]any)) != 2 {
		t.Fatal("invalid probe schema or mutated live config")
	}
	for _, raw := range []string{
		`{"services":[{"name":"fwx-existing","addr":":21001"},{"name":"fwx-tunnel-exit-3-101-22001","addr":":22001"}]}`,
		`{"services":[{"name":"fwx-existing","addr":":21001"},{"name":"fwx-tunnel-exit-2-101-22002","addr":":22002"}]}`,
		`{"services":[{"name":"fwx-existing","addr":":21001"}]}`,
	} {
		_, probes = planGostProbeReplacements(live, gostTestConfig(t, raw))
		if len(probes) != 0 {
			t.Fatal("unrelated probe removal accepted", raw)
		}
	}
	business := gostTestConfig(t, `{"services":[{"name":"fwx-tunnel-probe-2","addr":":22001","handler":{"type":"tcp"},"forwarder":{"nodes":[{"addr":"203.0.113.1:443"}]}}]}`)
	if _, probes := planGostProbeReplacements(business, desired); len(probes) != 0 {
		t.Fatal("business service mistaken for synthetic probe")
	}
}

func TestGostFailedProbeReplacementRestoresOnlyProbeAndNewObjects(t *testing.T) {
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		requests = append(requests, request.Method+" "+request.URL.Path+" "+string(body))
		if request.Method == "POST" && strings.Contains(string(body), "fwx-tunnel-exit-2-") {
			w.WriteHeader(500)
			_, _ = io.WriteString(w, `{"code":40003}`)
			return
		}
		_, _ = io.WriteString(w, `{"msg":"OK"}`)
	}))
	defer server.Close()
	api := gostAPIClient{server.Client(), server.URL}
	var restore func() bool
	err := applyGostProbeReplacements(context.Background(), api,
		[]gostAddition{{"services", "fwx-tunnel-probe-2", map[string]any{"name": "fwx-tunnel-probe-2"}}},
		[]gostAddition{{"services", "fwx-tunnel-exit-2-101-22001", map[string]any{"name": "fwx-tunnel-exit-2-101-22001"}}},
		func(fn func() bool) { restore = fn })
	if err == nil || restore == nil || !restore() {
		t.Fatalf("err=%v rollback unavailable/failed", err)
	}
	if len(requests) != 4 || !strings.HasPrefix(requests[0], "DELETE /config/services/fwx-tunnel-probe-2") || !strings.HasPrefix(requests[2], "DELETE /config/services/fwx-tunnel-exit-2-") || !strings.Contains(requests[3], `"name":"fwx-tunnel-probe-2"`) {
		t.Fatalf("wrong rollback: %v", requests)
	}
}
