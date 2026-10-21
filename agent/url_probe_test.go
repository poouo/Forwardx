package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestURLConnectionProbeFreshConnectionAndTaskReport(t *testing.T) {
	var connections atomic.Int32
	var calls atomic.Int32
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != "GET" || !r.Close {
			t.Error("probe must use a fresh GET")
		}
		time.Sleep(20 * time.Millisecond)
		w.WriteHeader(204)
	}))
	server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			connections.Add(1)
		}
	}
	server.Start()
	defer server.Close()
	key := urlProbeKey(9, server.URL, 5, 204)
	for i := 0; i < 2; i++ {
		result := executeTCPingTask(tcpingTask{Kind: "service", ServiceID: 9, Method: "url", TargetURL: server.URL, TargetIP: "127.0.0.1", TimeoutSeconds: 5, ExpectedStatus: 204, ProbeKey: key})
		if result.Kind != "service" || result.Payload["method"] != "url" || result.Payload["isTimeout"] != false || result.Payload["probeSuccesses"] != 1 || result.Payload["probeKey"] != key {
			t.Fatalf("invalid report: %#v", result)
		}
		if latency, _ := result.Payload["latencyMs"].(int); latency < 15 {
			t.Fatalf("must include response wait: %d", latency)
		}
	}
	if connections.Load() != 2 || calls.Load() != 2 {
		t.Fatalf("connections=%d calls=%d", connections.Load(), calls.Load())
	}
}

func TestURLConnectionProbeDoesNotFollowRedirects(t *testing.T) {
	var followed atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/next" {
			followed.Add(1)
			w.WriteHeader(204)
			return
		}
		w.Header().Set("Location", "/next")
		w.WriteHeader(302)
	}))
	defer server.Close()
	if urlConnectionProbe(server.URL, 5, 204).Reachable {
		t.Fatal("redirect is not the expected 204")
	}
	if !urlConnectionProbe(server.URL, 5, 302).Reachable {
		t.Fatal("explicit expected redirect status must match")
	}
	if followed.Load() != 0 {
		t.Fatal("must not follow redirects")
	}
}

func TestURLConnectionProbeDoesNotWaitForResponseBody(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer server.Close()
	defer close(release)
	started := time.Now()
	result := urlConnectionProbe(server.URL, 1, 200)
	if !result.Reachable || time.Since(started) >= 900*time.Millisecond {
		t.Fatalf("must stop at response headers: %#v", result)
	}
}

func TestURLConnectionProbeTimeoutAndTLSValidation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer server.Close()
	started := time.Now()
	if result := urlConnectionProbe(server.URL, 1, 200); result.Reachable || result.ProbeSuccesses != 0 {
		t.Fatal("timeout must fail")
	}
	if time.Since(started) > 2*time.Second {
		t.Fatal("timeout was not bounded")
	}
	tlsServer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) }))
	defer tlsServer.Close()
	if urlConnectionProbe(tlsServer.URL, 5, 204).Reachable {
		t.Fatal("untrusted TLS certificate must not pass")
	}
}

func TestURLConnectionProbeInvalidSettings(t *testing.T) {
	if got := urlProbeKey(1, "https://example.com/a?x=1&y=2", 5, 204); got != "service:1:url:35990647f4c4d05089482e350fa9510d3a924b5349f99194080a0382bde3960c" {
		t.Fatalf("probe identity must match the panel: %s", got)
	}
	for _, target := range []string{"", "ftp://example.com", "file:///etc/passwd", "http://user:pass@example.com", "https://example.com/#fragment", "http://example.com\r\nX: y", "https:\\example.com"} {
		if urlConnectionProbe(target, 5, 200).Reachable {
			t.Fatalf("invalid target passed")
		}
	}
	for _, settings := range [][2]int{{0, 200}, {31, 200}, {5, 0}, {5, 600}} {
		if urlConnectionProbe("http://example.com", settings[0], settings[1]).Reachable {
			t.Fatal("invalid settings passed")
		}
	}
	if urlProbeKey(1, "https://example.com/a?x=1&y=2", 5, 204) == urlProbeKey(1, "https://example.com/a?x=1&y=2", 5, 200) {
		t.Fatal("settings must change identity")
	}
}
