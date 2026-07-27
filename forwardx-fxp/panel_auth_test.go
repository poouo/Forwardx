package main

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func fxpTestAgentAuthChallenge(marker byte) string {
	raw := make([]byte, 64)
	for index := range raw {
		raw[index] = marker + byte(index)
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func writeFXPTestChallenge(w http.ResponseWriter, challenges ...string) {
	w.Header().Set(fxpAgentAuthCapabilityHeader, fxpAgentAuthChallengeCapability)
	_ = json.NewEncoder(w).Encode(map[string]any{"v": 2, "challenges": challenges})
}

func TestFXPAgentChallengeProofMatchesPanelVector(t *testing.T) {
	const token = "forwardx-test-token"
	const nonce = "00112233445566778899aabbccddeeff"
	challenge := strings.Repeat("A", 86)
	if fingerprint := fxpAgentTokenFingerprint(token); fingerprint != "691cd7140d18ac6942ce407dc8ac1466" {
		t.Fatalf("fingerprint=%s", fingerprint)
	}
	signature := signFXPAgentChallengeProof(
		token, http.MethodPost, "/api/sync", []byte(`{"v":1}`), challenge, nonce,
	)
	if signature != "ac04d4c29de90e800e81675a3f4933b210cbdf4ef9db13e2ff9fa8a329dcefe3" {
		t.Fatalf("signature=%s", signature)
	}
}

func TestFXPPanelRequestUsesChallengeForSkewedEnvelope(t *testing.T) {
	resetFXPAgentAuthCacheForTests()
	t.Cleanup(resetFXPAgentAuthCacheForTests)
	const token = "fxp-clockless-traffic-token"
	challenge := fxpTestAgentAuthChallenge(1)
	skewedTimestamp := time.Now().Add(-10 * time.Minute).UnixMilli()
	env, err := encryptEnvelopeAt(map[string]any{"reportId": "clockless"}, token, skewedTimestamp)
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}

	var reportRequests atomic.Int32
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch req.URL.Path {
		case "/api/agent/auth-challenge":
			writeFXPTestChallenge(w, challenge)
		case "/api/agent/traffic":
			reportRequests.Add(1)
			requestBody, readErr := io.ReadAll(req.Body)
			if readErr != nil {
				t.Error(readErr)
				http.Error(w, readErr.Error(), http.StatusBadRequest)
				return
			}
			parts := strings.Split(strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer "), ".")
			if len(parts) != 5 || parts[0] != "v2" || parts[2] != challenge {
				t.Errorf("unexpected FXP auth proof: %s", req.Header.Get("Authorization"))
				http.Error(w, "invalid proof", http.StatusUnauthorized)
				return
			}
			expected := signFXPAgentChallengeProof(token, req.Method, req.URL.Path, requestBody, parts[2], parts[3])
			if parts[1] != fxpAgentTokenFingerprint(token) || parts[4] != expected {
				t.Error("FXP challenge proof does not bind the encrypted traffic envelope")
				http.Error(w, "invalid signature", http.StatusUnauthorized)
				return
			}
			var received envelope
			if decodeErr := json.Unmarshal(requestBody, &received); decodeErr != nil || received.TS != skewedTimestamp {
				t.Errorf("skewed envelope was not preserved: ts=%d error=%v", received.TS, decodeErr)
			}
			w.Header().Set(fxpAgentAuthResultHeader, "accepted")
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, req)
		}
	}))
	defer panel.Close()

	response, err := postFXPEncryptedPanelRequest(
		panel.Client(), panel.URL, token, "/api/agent/traffic", body,
	)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusNoContent || reportRequests.Load() != 1 {
		t.Fatalf("response=%+v reportRequests=%d", response, reportRequests.Load())
	}
}

func TestFXPPanelRequestRefreshesChallengeAfterExplicitRejection(t *testing.T) {
	resetFXPAgentAuthCacheForTests()
	t.Cleanup(resetFXPAgentAuthCacheForTests)
	const token = "fxp-challenge-refresh-token"
	var challengeRequests atomic.Int32
	var reportRequests atomic.Int32
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch req.URL.Path {
		case "/api/agent/auth-challenge":
			requestNumber := challengeRequests.Add(1)
			writeFXPTestChallenge(w, fxpTestAgentAuthChallenge(byte(requestNumber)))
		case "/api/agent/protocol-block":
			requestNumber := reportRequests.Add(1)
			parts := strings.Split(strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer "), ".")
			if len(parts) != 5 || parts[0] != "v2" {
				t.Errorf("request %d did not use challenge auth: %s", requestNumber, req.Header.Get("Authorization"))
			}
			w.Header().Set(fxpAgentAuthCapabilityHeader, fxpAgentAuthChallengeCapability)
			if requestNumber == 1 {
				w.Header().Set(fxpAgentAuthResultHeader, fxpAgentAuthResultRejected)
				http.Error(w, "stale challenge", http.StatusUnauthorized)
				return
			}
			w.Header().Set(fxpAgentAuthResultHeader, "accepted")
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, req)
		}
	}))
	defer panel.Close()

	response, err := postFXPEncryptedPanelRequest(
		panel.Client(), panel.URL, token, "/api/agent/protocol-block", []byte(`{"v":1}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusNoContent || challengeRequests.Load() != 2 || reportRequests.Load() != 2 {
		t.Fatalf(
			"response=%+v challengeRequests=%d reportRequests=%d",
			response, challengeRequests.Load(), reportRequests.Load(),
		)
	}
}

func TestFXPConcurrentStaleChallengeRejectionsEachRetryOnce(t *testing.T) {
	resetFXPAgentAuthCacheForTests()
	t.Cleanup(resetFXPAgentAuthCacheForTests)
	const token = "fxp-concurrent-challenge-refresh-token"
	oldChallenges := map[string]bool{
		fxpTestAgentAuthChallenge(1): true,
		fxpTestAgentAuthChallenge(2): true,
	}
	var challengeRequests atomic.Int32
	var oldReports atomic.Int32
	var freshReports atomic.Int32
	bothOldReports := make(chan struct{})
	refreshRequested := make(chan struct{})
	var bothOldOnce sync.Once
	var refreshOnce sync.Once
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch req.URL.Path {
		case "/api/agent/auth-challenge":
			requestNumber := challengeRequests.Add(1)
			if requestNumber == 1 {
				writeFXPTestChallenge(w, fxpTestAgentAuthChallenge(1), fxpTestAgentAuthChallenge(2))
				return
			}
			refreshOnce.Do(func() { close(refreshRequested) })
			writeFXPTestChallenge(w, fxpTestAgentAuthChallenge(10), fxpTestAgentAuthChallenge(11))
		case "/api/agent/protocol-block":
			parts := strings.Split(strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer "), ".")
			if len(parts) != 5 || parts[0] != "v2" {
				t.Errorf("request did not use challenge auth: %s", req.Header.Get("Authorization"))
				http.Error(w, "invalid proof", http.StatusUnauthorized)
				return
			}
			if oldChallenges[parts[2]] {
				requestNumber := oldReports.Add(1)
				if requestNumber == 2 {
					bothOldOnce.Do(func() { close(bothOldReports) })
				}
				<-bothOldReports
				if requestNumber == 2 {
					<-refreshRequested
				}
				w.Header().Set(fxpAgentAuthCapabilityHeader, fxpAgentAuthChallengeCapability)
				w.Header().Set(fxpAgentAuthResultHeader, fxpAgentAuthResultRejected)
				http.Error(w, "stale challenge", http.StatusUnauthorized)
				return
			}
			freshReports.Add(1)
			w.Header().Set(fxpAgentAuthResultHeader, "accepted")
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, req)
		}
	}))
	defer panel.Close()

	responses := make(chan fxpPanelResponse, 2)
	errors := make(chan error, 2)
	for index := 0; index < 2; index++ {
		go func() {
			response, err := postFXPEncryptedPanelRequest(
				panel.Client(), panel.URL, token, "/api/agent/protocol-block", []byte(`{"v":1}`),
			)
			responses <- response
			errors <- err
		}()
	}
	for index := 0; index < 2; index++ {
		if err := <-errors; err != nil {
			t.Fatal(err)
		}
		if response := <-responses; response.StatusCode != http.StatusNoContent {
			t.Fatalf("response=%+v", response)
		}
	}
	if challengeRequests.Load() != 2 || oldReports.Load() != 2 || freshReports.Load() != 2 {
		t.Fatalf(
			"challengeRequests=%d oldReports=%d freshReports=%d",
			challengeRequests.Load(), oldReports.Load(), freshReports.Load(),
		)
	}
}

func TestFXPPanelRequestDoesNotRetryAuthenticatedBusinessError(t *testing.T) {
	resetFXPAgentAuthCacheForTests()
	t.Cleanup(resetFXPAgentAuthCacheForTests)
	const token = "fxp-business-error-token"
	challenge := fxpTestAgentAuthChallenge(7)
	var reportRequests atomic.Int32
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path == "/api/agent/auth-challenge" {
			writeFXPTestChallenge(w, challenge)
			return
		}
		reportRequests.Add(1)
		w.Header().Set(fxpAgentAuthResultHeader, "accepted")
		http.Error(w, "business policy rejected", http.StatusForbidden)
	}))
	defer panel.Close()

	response, err := postFXPEncryptedPanelRequest(
		panel.Client(), panel.URL, token, "/api/agent/traffic", []byte(`{"v":1}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusForbidden || reportRequests.Load() != 1 {
		t.Fatalf("response=%+v reportRequests=%d", response, reportRequests.Load())
	}
}

func TestFXPPanelRequestFallsBackToRawTokenForOlderPanel(t *testing.T) {
	resetFXPAgentAuthCacheForTests()
	t.Cleanup(resetFXPAgentAuthCacheForTests)
	const token = "fxp-legacy-panel-token"
	var challengeRequests atomic.Int32
	var reportRequests atomic.Int32
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path == "/api/agent/auth-challenge" {
			challengeRequests.Add(1)
			http.NotFound(w, req)
			return
		}
		reportRequests.Add(1)
		if req.Header.Get("Authorization") != "Bearer "+token {
			t.Errorf("legacy panel credential=%q", req.Header.Get("Authorization"))
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer panel.Close()

	response, err := postFXPEncryptedPanelRequest(
		panel.Client(), panel.URL, token, "/api/agent/traffic", []byte(`{"v":1}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusNoContent || challengeRequests.Load() != 1 || reportRequests.Load() != 1 {
		t.Fatalf(
			"response=%+v challengeRequests=%d reportRequests=%d",
			response, challengeRequests.Load(), reportRequests.Load(),
		)
	}
}
