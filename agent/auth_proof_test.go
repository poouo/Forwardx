package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestAgentAuthProofMatchesPanelVector(t *testing.T) {
	const token = "forwardx-test-token"
	const body = `{"v":1,"iv":"00","ct":"11","mac":"22","ts":1784700000000}`
	const timestamp = int64(1784700000123)
	const nonce = "00112233445566778899aabbccddeeff"

	if got := agentTokenFingerprint(token); got != "691cd7140d18ac6942ce407dc8ac1466" {
		t.Fatalf("fingerprint=%s", got)
	}
	if got := signAgentAuthProof(token, "POST", "/api/sync", []byte(body), timestamp, nonce); got != "ee96cf825e315eb1e39b82e3a24a7e259d8c2b96a9f20cdbdf82879f1f35c3c9" {
		t.Fatalf("signature=%s", got)
	}
}

func TestNewAgentAuthProofUsesVersionedBearerShape(t *testing.T) {
	proof, err := newAgentAuthProof("token", "POST", "/api/sync", []byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(proof, ".")
	if len(parts) != 5 || parts[0] != "v1" || len(parts[1]) != 32 || len(parts[3]) != 32 || len(parts[4]) != 64 {
		t.Fatalf("unexpected proof shape: %s", proof)
	}
}

func TestPostOnceSendsBodyBoundAgentAuthProof(t *testing.T) {
	const token = "request-proof-token"
	previousPanelURL, _ := runtimePanelURL.Load().(string)
	runtimePanelURL.Store("")
	t.Cleanup(func() { runtimePanelURL.Store(previousPanelURL) })
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, err := io.ReadAll(req.Body)
		if err != nil {
			t.Error(err)
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		proof := strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
		parts := strings.Split(proof, ".")
		if len(parts) != 5 {
			t.Errorf("invalid Authorization proof: %s", proof)
			http.Error(w, "invalid proof", http.StatusUnauthorized)
			return
		}
		timestamp, err := strconv.ParseInt(parts[2], 10, 64)
		if err != nil {
			t.Error(err)
			http.Error(w, "invalid timestamp", http.StatusUnauthorized)
			return
		}
		expected := signAgentAuthProof(token, req.Method, req.URL.Path, body, timestamp, parts[3])
		if parts[1] != agentTokenFingerprint(token) || parts[4] != expected {
			t.Error("Authorization proof does not match the encrypted request body")
			http.Error(w, "invalid signature", http.StatusUnauthorized)
			return
		}
		response, err := encrypt(map[string]any{"success": true}, token)
		if err != nil {
			t.Error(err)
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(response)
	}))
	defer panel.Close()

	var response map[string]any
	if err := postOnce(Config{PanelURL: panel.URL, Token: token}, "/api/agent/traffic", map[string]any{"s": []any{}}, &response); err != nil {
		t.Fatal(err)
	}
	if response["success"] != true {
		t.Fatalf("unexpected response: %#v", response)
	}
}

func TestAgentEventStreamSendsRequestAuthProof(t *testing.T) {
	const token = "stream-proof-token"
	previousPanelURL, _ := runtimePanelURL.Load().(string)
	runtimePanelURL.Store("")
	t.Cleanup(func() { runtimePanelURL.Store(previousPanelURL) })

	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		proof := strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
		parts := strings.Split(proof, ".")
		if len(parts) != 5 {
			t.Errorf("invalid Authorization proof: %s", proof)
			http.Error(w, "invalid proof", http.StatusUnauthorized)
			return
		}
		timestamp, err := strconv.ParseInt(parts[2], 10, 64)
		if err != nil {
			t.Error(err)
			http.Error(w, "invalid timestamp", http.StatusUnauthorized)
			return
		}
		expected := signAgentAuthProof(token, req.Method, req.URL.Path, nil, timestamp, parts[3])
		if req.URL.Path != "/api/stream" || parts[1] != agentTokenFingerprint(token) || parts[4] != expected {
			t.Error("Authorization proof does not match the event stream request")
			http.Error(w, "invalid signature", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
	}))
	defer panel.Close()

	if err := runAgentEventStream(Config{PanelURL: panel.URL, Token: token}); err != io.EOF {
		t.Fatalf("runAgentEventStream error=%v", err)
	}
}
