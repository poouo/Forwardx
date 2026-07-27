package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
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

func TestAgentChallengeAuthProofMatchesPanelVector(t *testing.T) {
	const token = "forwardx-test-token"
	const body = `{"v":1}`
	const nonce = "00112233445566778899aabbccddeeff"
	challenge := strings.Repeat("A", 86)

	if !validAgentAuthChallenge(challenge) {
		t.Fatal("test vector challenge must be valid base64url")
	}
	if got := signAgentChallengeAuthProof(token, "post", "/api/sync", []byte(body), challenge, nonce); got != "ac04d4c29de90e800e81675a3f4933b210cbdf4ef9db13e2ff9fa8a329dcefe3" {
		t.Fatalf("signature=%s", got)
	}
}

func TestNewAgentChallengeAuthProofUsesVersionedBearerShape(t *testing.T) {
	challenge := strings.Repeat("A", 86)
	proof, err := newAgentChallengeAuthProof("token", "POST", "/api/sync", []byte(`{}`), challenge)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(proof, ".")
	if len(parts) != 5 || parts[0] != "v2" || len(parts[1]) != 32 || parts[2] != challenge || len(parts[3]) != 32 || len(parts[4]) != 64 {
		t.Fatalf("unexpected proof shape: %s", proof)
	}

	invalidChallenges := []string{
		strings.Repeat("A", 79),
		strings.Repeat("A", 101),
		strings.Repeat("A", 85),
		strings.Repeat("A", 85) + "=",
		strings.Repeat("A", 85) + "+",
		base64.RawURLEncoding.EncodeToString(make([]byte, 63)),
		base64.RawURLEncoding.EncodeToString(make([]byte, 65)),
	}
	for _, invalid := range invalidChallenges {
		if validAgentAuthChallenge(invalid) {
			t.Errorf("accepted invalid challenge %q", invalid)
		}
	}
}

func testAgentAuthChallenges(count int, generation byte) []string {
	challenges := make([]string, count)
	for i := range challenges {
		raw := make([]byte, 64)
		raw[0] = generation
		raw[len(raw)-2] = byte(i >> 8)
		raw[len(raw)-1] = byte(i)
		challenges[i] = base64.RawURLEncoding.EncodeToString(raw)
	}
	return challenges
}

func TestPostNegotiatesChallengeAuthAndRetriesWithoutClockSync(t *testing.T) {
	resetAgentAuthChallengeCacheForTests()
	t.Cleanup(resetAgentAuthChallengeCacheForTests)
	const token = "challenge-negotiation-token"
	challenges := testAgentAuthChallenges(agentAuthChallengeBatchSize, 1)
	issued := make(map[string]bool, len(challenges))
	for _, challenge := range challenges {
		issued[challenge] = true
	}

	previousClockSyncAt := atomic.LoadInt64(&lastClockSyncAttemptAt)
	atomic.StoreInt64(&lastClockSyncAttemptAt, time.Now().Unix())
	t.Cleanup(func() { atomic.StoreInt64(&lastClockSyncAttemptAt, previousClockSyncAt) })

	var postRequests atomic.Int32
	var challengeRequests atomic.Int32
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch req.URL.Path {
		case "/api/agent/auth-challenge":
			challengeRequests.Add(1)
			if req.Method != http.MethodGet || req.URL.Query().Get("count") != "32" {
				t.Errorf("unexpected challenge request: %s %s", req.Method, req.URL.String())
			}
			if req.Header.Get("Cache-Control") != "no-store" {
				t.Errorf("challenge request cache control=%q", req.Header.Get("Cache-Control"))
			}
			w.Header().Set(agentAuthCapabilityHeader, agentAuthChallengeCapability)
			_ = json.NewEncoder(w).Encode(map[string]any{"v": 2, "challenges": challenges})
		case "/api/sync":
			body, err := io.ReadAll(req.Body)
			if err != nil {
				t.Error(err)
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			requestNumber := postRequests.Add(1)
			proof := strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
			parts := strings.Split(proof, ".")
			w.Header().Set(agentAuthCapabilityHeader, agentAuthChallengeCapability)
			if requestNumber == 1 {
				if len(parts) != 5 || parts[0] != "v1" {
					t.Errorf("first request proof=%s", proof)
				}
				http.Error(w, "Request timestamp out of window (replay protection)", http.StatusUnauthorized)
				return
			}
			if len(parts) != 5 || parts[0] != "v2" || !issued[parts[2]] || len(parts[3]) != 32 {
				t.Errorf("retry request proof=%s", proof)
				http.Error(w, "invalid proof", http.StatusUnauthorized)
				return
			}
			expected := signAgentChallengeAuthProof(token, req.Method, req.URL.Path, body, parts[2], parts[3])
			if parts[1] != agentTokenFingerprint(token) || parts[4] != expected {
				t.Error("challenge proof does not match the encrypted request body")
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
		default:
			http.NotFound(w, req)
		}
	}))
	defer panel.Close()

	var response map[string]any
	err := postWithClientToPanelURL(panel.Client(), Config{PanelURL: panel.URL, Token: token}, panel.URL+"/", "/api/agent/register", map[string]any{"hostname": "test"}, &response)
	if err != nil {
		t.Fatal(err)
	}
	if response["success"] != true || postRequests.Load() != 2 || challengeRequests.Load() != 1 {
		t.Fatalf("response=%#v posts=%d challengeRequests=%d", response, postRequests.Load(), challengeRequests.Load())
	}
}

func TestPostRefreshesCachedChallengesAfterPanelRestart(t *testing.T) {
	resetAgentAuthChallengeCacheForTests()
	t.Cleanup(resetAgentAuthChallengeCacheForTests)
	const token = "challenge-panel-restart-token"
	oldChallenges := testAgentAuthChallenges(agentAuthChallengeBatchSize, 3)
	newChallenges := testAgentAuthChallenges(agentAuthChallengeBatchSize, 4)
	newChallengeSet := make(map[string]bool, len(newChallenges))
	for _, challenge := range newChallenges {
		newChallengeSet[challenge] = true
	}

	var challengeRequests atomic.Int32
	var syncRequests atomic.Int32
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set(agentAuthCapabilityHeader, agentAuthChallengeCapability)
		switch req.URL.Path {
		case "/api/agent/auth-challenge":
			requestNumber := challengeRequests.Add(1)
			batch := oldChallenges
			if requestNumber > 1 {
				batch = newChallenges
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"v": 2, "challenges": batch})
		case "/api/sync":
			syncRequests.Add(1)
			body, err := io.ReadAll(req.Body)
			if err != nil {
				t.Error(err)
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			proof := strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
			parts := strings.Split(proof, ".")
			if len(parts) != 5 || parts[0] != "v2" {
				t.Errorf("restart proof=%s", proof)
				http.Error(w, "invalid proof", http.StatusUnauthorized)
				return
			}
			if !newChallengeSet[parts[2]] {
				w.Header().Set(agentAuthResultHeader, agentAuthResultRejected)
				http.Error(w, "stale challenge", http.StatusUnauthorized)
				return
			}
			expected := signAgentChallengeAuthProof(token, req.Method, req.URL.Path, body, parts[2], parts[3])
			if parts[4] != expected {
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
		default:
			http.NotFound(w, req)
		}
	}))
	defer panel.Close()

	observeAgentAuthCapability(panel.URL, agentAuthChallengeCapability)
	seedProof, err := newAgentRequestAuthProof(
		context.Background(), panel.Client(), panel.URL, token, http.MethodPost, "/api/sync", []byte("seed"),
	)
	if err != nil || !strings.HasPrefix(seedProof, "v2.") {
		t.Fatalf("seed challenge proof=%q error=%v", seedProof, err)
	}

	var response map[string]any
	err = postWithClientToPanelURL(
		panel.Client(), Config{PanelURL: panel.URL, Token: token}, panel.URL,
		"/api/agent/register", map[string]any{"hostname": "restart-test"}, &response,
	)
	if err != nil {
		t.Fatal(err)
	}
	if response["success"] != true || syncRequests.Load() != 2 || challengeRequests.Load() != 2 {
		t.Fatalf(
			"response=%#v syncRequests=%d challengeRequests=%d",
			response, syncRequests.Load(), challengeRequests.Load(),
		)
	}
	if agentAuthChallengeRefreshNeeded(panel.URL) {
		t.Fatal("fresh challenge batch remained marked for refresh")
	}
}

func TestChallengeCapabilityDoesNotRetryOrdinaryServerErrors(t *testing.T) {
	resetAgentAuthChallengeCacheForTests()
	t.Cleanup(resetAgentAuthChallengeCacheForTests)
	const token = "challenge-no-server-error-retry-token"
	challenges := testAgentAuthChallenges(agentAuthChallengeBatchSize, 5)
	var syncRequests atomic.Int32
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set(agentAuthCapabilityHeader, agentAuthChallengeCapability)
		if req.URL.Path == "/api/agent/auth-challenge" {
			_ = json.NewEncoder(w).Encode(map[string]any{"v": 2, "challenges": challenges})
			return
		}
		if req.URL.Path == "/api/sync" {
			syncRequests.Add(1)
			http.Error(w, "temporary server error", http.StatusInternalServerError)
			return
		}
		http.NotFound(w, req)
	}))
	defer panel.Close()
	observeAgentAuthCapability(panel.URL, agentAuthChallengeCapability)

	var response map[string]any
	err := postWithClientToPanelURL(
		panel.Client(), Config{PanelURL: panel.URL, Token: token}, panel.URL,
		"/api/agent/traffic", map[string]any{"sequence": 1}, &response,
	)
	if err == nil || !strings.Contains(err.Error(), "500 Internal Server Error") {
		t.Fatalf("unexpected error: %v", err)
	}
	if syncRequests.Load() != 1 {
		t.Fatalf("ordinary server error retried %d requests", syncRequests.Load())
	}
}

func TestAuthenticatedBusinessErrorsAreNeverRetried(t *testing.T) {
	previousSync := syncSystemTimeForAgentRequestError
	defer func() { syncSystemTimeForAgentRequestError = previousSync }()

	for _, statusCode := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		t.Run(strconv.Itoa(statusCode), func(t *testing.T) {
			resetAgentAuthChallengeCacheForTests()
			t.Cleanup(resetAgentAuthChallengeCacheForTests)
			const token = "authenticated-business-error-token"
			challenges := testAgentAuthChallenges(agentAuthChallengeBatchSize, byte(statusCode))
			var syncRequests atomic.Int32
			var clockSyncCalls atomic.Int32
			syncSystemTimeForAgentRequestError = func(error) bool {
				clockSyncCalls.Add(1)
				return true
			}

			panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				w.Header().Set(agentAuthCapabilityHeader, agentAuthChallengeCapability)
				if req.URL.Path == "/api/agent/auth-challenge" {
					_ = json.NewEncoder(w).Encode(map[string]any{"v": 2, "challenges": challenges})
					return
				}
				if req.URL.Path != "/api/sync" {
					http.NotFound(w, req)
					return
				}
				syncRequests.Add(1)
				proof := strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
				if !strings.HasPrefix(proof, "v2.") {
					t.Errorf("business request proof=%s", proof)
				}
				response, err := encrypt(map[string]any{
					"error":   "forbidden",
					"message": "Request timestamp out of window (business detail)",
				}, token)
				if err != nil {
					t.Error(err)
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				if statusCode == http.StatusForbidden {
					w.Header().Set(agentAuthResultHeader, agentAuthResultAccepted)
				}
				w.WriteHeader(statusCode)
				_ = json.NewEncoder(w).Encode(response)
			}))
			defer panel.Close()
			observeAgentAuthCapability(panel.URL, agentAuthChallengeCapability)

			var response map[string]any
			err := postWithClientToPanelURL(
				panel.Client(), Config{PanelURL: panel.URL, Token: token}, panel.URL,
				"/api/agent/protocol-block", map[string]any{"ruleId": 7}, &response,
			)
			if err == nil || !strings.Contains(err.Error(), strconv.Itoa(statusCode)) {
				t.Fatalf("unexpected error: %v", err)
			}
			if syncRequests.Load() != 1 || clockSyncCalls.Load() != 0 {
				t.Fatalf("syncRequests=%d clockSyncCalls=%d", syncRequests.Load(), clockSyncCalls.Load())
			}
		})
	}
}

func TestAcceptedEnvelopeReplayIsNeverRetried(t *testing.T) {
	resetAgentAuthChallengeCacheForTests()
	t.Cleanup(resetAgentAuthChallengeCacheForTests)
	previousSync := syncSystemTimeForAgentRequestError
	defer func() { syncSystemTimeForAgentRequestError = previousSync }()
	const token = "accepted-envelope-replay-token"
	challenges := testAgentAuthChallenges(agentAuthChallengeBatchSize, 12)
	var syncRequests atomic.Int32
	var clockSyncCalls atomic.Int32
	syncSystemTimeForAgentRequestError = func(error) bool {
		clockSyncCalls.Add(1)
		return true
	}
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set(agentAuthCapabilityHeader, agentAuthChallengeCapability)
		if req.URL.Path == "/api/agent/auth-challenge" {
			_ = json.NewEncoder(w).Encode(map[string]any{"v": 2, "challenges": challenges})
			return
		}
		if req.URL.Path != "/api/sync" {
			http.NotFound(w, req)
			return
		}
		syncRequests.Add(1)
		w.Header().Set(agentAuthResultHeader, agentAuthResultAccepted)
		http.Error(w, "Encrypted request replay detected", http.StatusUnauthorized)
	}))
	defer panel.Close()
	observeAgentAuthCapability(panel.URL, agentAuthChallengeCapability)

	var response map[string]any
	err := postWithClientToPanelURL(
		panel.Client(), Config{PanelURL: panel.URL, Token: token}, panel.URL,
		"/api/agent/traffic", map[string]any{"sequence": 9}, &response,
	)
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "replay detected") {
		t.Fatalf("unexpected error: %v", err)
	}
	if syncRequests.Load() != 1 || clockSyncCalls.Load() != 0 {
		t.Fatalf("syncRequests=%d clockSyncCalls=%d", syncRequests.Load(), clockSyncCalls.Load())
	}
}

func TestChallengeFetchFailureFallsBackToV1(t *testing.T) {
	resetAgentAuthChallengeCacheForTests()
	t.Cleanup(resetAgentAuthChallengeCacheForTests)
	const token = "challenge-fallback-token"
	var challengeRequests atomic.Int32
	var syncRequests atomic.Int32
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path == "/api/agent/auth-challenge" {
			challengeRequests.Add(1)
			http.Error(w, "temporarily unavailable", http.StatusServiceUnavailable)
			return
		}
		if req.URL.Path != "/api/sync" {
			http.NotFound(w, req)
			return
		}
		syncRequests.Add(1)
		proof := strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
		if !strings.HasPrefix(proof, "v1.") {
			t.Errorf("fallback proof=%s", proof)
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
	observeAgentAuthCapability(panel.URL, agentAuthChallengeCapability)

	for i := 0; i < 2; i++ {
		var response map[string]any
		if err := postOnceWithClientToPanelURL(panel.Client(), Config{PanelURL: panel.URL, Token: token}, panel.URL, "/api/agent/traffic", map[string]any{"sequence": i}, &response); err != nil {
			t.Fatal(err)
		}
	}
	if challengeRequests.Load() != 1 || syncRequests.Load() != 2 {
		t.Fatalf("challengeRequests=%d syncRequests=%d", challengeRequests.Load(), syncRequests.Load())
	}
}

func TestChallengeFetchFailureRestoresV1ClockSyncFallback(t *testing.T) {
	resetAgentAuthChallengeCacheForTests()
	t.Cleanup(resetAgentAuthChallengeCacheForTests)
	previousSync := syncSystemTimeForAgentRequestError
	defer func() { syncSystemTimeForAgentRequestError = previousSync }()
	const token = "challenge-clock-fallback-token"
	var challengeRequests atomic.Int32
	var syncRequests atomic.Int32
	var clockSyncCalls atomic.Int32
	syncSystemTimeForAgentRequestError = func(error) bool {
		clockSyncCalls.Add(1)
		return true
	}

	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path == "/api/agent/auth-challenge" {
			challengeRequests.Add(1)
			http.Error(w, "temporarily unavailable", http.StatusServiceUnavailable)
			return
		}
		if req.URL.Path != "/api/sync" {
			http.NotFound(w, req)
			return
		}
		requestNumber := syncRequests.Add(1)
		w.Header().Set(agentAuthCapabilityHeader, agentAuthChallengeCapability)
		proof := strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
		if !strings.HasPrefix(proof, "v1.") {
			t.Errorf("fallback proof=%s", proof)
		}
		if requestNumber == 1 {
			w.Header().Set(agentAuthResultHeader, agentAuthResultRejected)
			http.Error(w, "Request timestamp out of window (replay protection)", http.StatusUnauthorized)
			return
		}
		response, err := encrypt(map[string]any{"success": true}, token)
		if err != nil {
			t.Error(err)
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set(agentAuthResultHeader, agentAuthResultAccepted)
		_ = json.NewEncoder(w).Encode(response)
	}))
	defer panel.Close()
	observeAgentAuthCapability(panel.URL, agentAuthChallengeCapability)

	var response map[string]any
	if err := postWithClientToPanelURL(
		panel.Client(), Config{PanelURL: panel.URL, Token: token}, panel.URL,
		"/api/agent/register", map[string]any{"hostname": "clock-fallback"}, &response,
	); err != nil {
		t.Fatal(err)
	}
	if response["success"] != true || challengeRequests.Load() != 1 || syncRequests.Load() != 2 || clockSyncCalls.Load() != 1 {
		t.Fatalf(
			"response=%#v challengeRequests=%d syncRequests=%d clockSyncCalls=%d",
			response, challengeRequests.Load(), syncRequests.Load(), clockSyncCalls.Load(),
		)
	}
}

func TestChallengeEndpointRollbackClearsCapability(t *testing.T) {
	for _, statusCode := range []int{http.StatusOK, http.StatusNotFound, http.StatusMethodNotAllowed} {
		t.Run(strconv.Itoa(statusCode), func(t *testing.T) {
			resetAgentAuthChallengeCacheForTests()
			t.Cleanup(resetAgentAuthChallengeCacheForTests)
			var challengeRequests atomic.Int32
			panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				challengeRequests.Add(1)
				if statusCode != http.StatusOK {
					http.Error(w, "challenge endpoint unavailable", statusCode)
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]any{
					"v":          2,
					"challenges": testAgentAuthChallenges(1, 9),
				})
			}))
			defer panel.Close()
			observeAgentAuthCapability(panel.URL, agentAuthChallengeCapability)

			for i := 0; i < 2; i++ {
				proof, err := newAgentRequestAuthProof(
					context.Background(), panel.Client(), panel.URL, "rollback-token",
					http.MethodPost, "/api/sync", []byte("body"),
				)
				if err != nil || !strings.HasPrefix(proof, "v1.") {
					t.Fatalf("proof=%q error=%v", proof, err)
				}
			}
			if agentAuthChallengeV2Known(panel.URL) || challengeRequests.Load() != 1 {
				t.Fatalf("known=%t challengeRequests=%d", agentAuthChallengeV2Known(panel.URL), challengeRequests.Load())
			}
		})
	}
}

func TestLateChallengeRejectionCannotClearFreshGeneration(t *testing.T) {
	resetAgentAuthChallengeCacheForTests()
	t.Cleanup(resetAgentAuthChallengeCacheForTests)
	const token = "challenge-generation-token"
	oldChallenges := testAgentAuthChallenges(agentAuthChallengeBatchSize, 10)
	freshChallenges := testAgentAuthChallenges(agentAuthChallengeBatchSize, 11)
	var challengeRequests atomic.Int32
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		requestNumber := challengeRequests.Add(1)
		batch := oldChallenges
		if requestNumber > 1 {
			batch = freshChallenges
		}
		w.Header().Set(agentAuthCapabilityHeader, agentAuthChallengeCapability)
		_ = json.NewEncoder(w).Encode(map[string]any{"v": 2, "challenges": batch})
	}))
	defer panel.Close()
	observeAgentAuthCapability(panel.URL, agentAuthChallengeCapability)

	oldAuth, err := newAgentRequestAuth(context.Background(), panel.Client(), panel.URL, token, http.MethodPost, "/api/sync", []byte("old"))
	if err != nil || oldAuth.version != "v2" || !invalidateAgentAuthChallenges(panel.URL, oldAuth.challengeGeneration) {
		t.Fatalf("old auth=%#v error=%v", oldAuth, err)
	}
	freshAuth, err := newAgentRequestAuth(context.Background(), panel.Client(), panel.URL, token, http.MethodPost, "/api/sync", []byte("fresh"))
	if err != nil || freshAuth.version != "v2" || freshAuth.challengeGeneration == oldAuth.challengeGeneration {
		t.Fatalf("fresh auth=%#v error=%v", freshAuth, err)
	}
	if invalidateAgentAuthChallenges(panel.URL, oldAuth.challengeGeneration) {
		t.Fatal("late rejection invalidated a newer challenge generation")
	}
	nextAuth, err := newAgentRequestAuth(context.Background(), panel.Client(), panel.URL, token, http.MethodPost, "/api/sync", []byte("next"))
	if err != nil || nextAuth.version != "v2" || nextAuth.challengeGeneration != freshAuth.challengeGeneration {
		t.Fatalf("next auth=%#v error=%v", nextAuth, err)
	}
	if challengeRequests.Load() != 2 {
		t.Fatalf("challengeRequests=%d", challengeRequests.Load())
	}
}

func TestChallengeBatchIsSharedAcrossConcurrentRequests(t *testing.T) {
	resetAgentAuthChallengeCacheForTests()
	t.Cleanup(resetAgentAuthChallengeCacheForTests)
	const token = "challenge-concurrency-token"
	challenges := testAgentAuthChallenges(agentAuthChallengeBatchSize, 2)
	var challengeRequests atomic.Int32
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		challengeRequests.Add(1)
		w.Header().Set(agentAuthCapabilityHeader, agentAuthChallengeCapability)
		_ = json.NewEncoder(w).Encode(map[string]any{"v": 2, "challenges": challenges})
	}))
	defer panel.Close()
	observeAgentAuthCapability(panel.URL+"/", "legacy, challenge-v2")

	proofs := make(chan string, agentAuthChallengeBatchSize)
	errs := make(chan error, agentAuthChallengeBatchSize)
	var wg sync.WaitGroup
	for i := 0; i < agentAuthChallengeBatchSize; i++ {
		wg.Add(1)
		go func(sequence int) {
			defer wg.Done()
			proof, err := newAgentRequestAuthProof(context.Background(), panel.Client(), panel.URL, token, http.MethodPost, "/api/sync", []byte(fmt.Sprintf("body-%d", sequence)))
			if err != nil {
				errs <- err
				return
			}
			proofs <- proof
		}(i)
	}
	wg.Wait()
	close(errs)
	close(proofs)
	for err := range errs {
		t.Error(err)
	}
	used := make(map[string]bool, agentAuthChallengeBatchSize)
	for proof := range proofs {
		parts := strings.Split(proof, ".")
		if len(parts) != 5 || parts[0] != "v2" {
			t.Errorf("proof=%s", proof)
			continue
		}
		if used[parts[2]] {
			t.Errorf("challenge consumed more than once: %s", parts[2])
		}
		used[parts[2]] = true
	}
	if len(used) != agentAuthChallengeBatchSize || challengeRequests.Load() != 1 {
		t.Fatalf("uniqueChallenges=%d challengeRequests=%d", len(used), challengeRequests.Load())
	}

	key := normalizedAgentAuthPanelURL(panel.URL)
	agentAuthChallengeCache.Lock()
	expiresAt := agentAuthChallengeCache.panels[key].expiresAt
	agentAuthChallengeCache.Unlock()
	remaining := time.Until(expiresAt)
	if remaining <= 0 || remaining > agentAuthChallengeCacheTTL {
		t.Fatalf("cache lifetime=%s", remaining)
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

func TestPostToPanelURLUsesTheTrafficIdentitySnapshot(t *testing.T) {
	const token = "traffic-panel-snapshot-token"
	previousPanelURL, _ := runtimePanelURL.Load().(string)
	t.Cleanup(func() { runtimePanelURL.Store(previousPanelURL) })

	var snapshotRequests atomic.Int32
	snapshotPanel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		snapshotRequests.Add(1)
		response, err := encrypt(map[string]any{"success": true}, token)
		if err != nil {
			t.Error(err)
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(response)
	}))
	defer snapshotPanel.Close()

	var runtimeRequests atomic.Int32
	runtimePanel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		runtimeRequests.Add(1)
		http.Error(w, "traffic report used the changed runtime panel", http.StatusConflict)
	}))
	defer runtimePanel.Close()
	runtimePanelURL.Store(runtimePanel.URL)

	var response map[string]any
	err := postToPanelURL(
		Config{PanelURL: snapshotPanel.URL, Token: token},
		snapshotPanel.URL,
		"/api/agent/traffic",
		map[string]any{"reportId": "snapshot-report", "s": []any{}},
		&response,
	)
	if err != nil {
		t.Fatalf("post traffic report to panel snapshot: %v", err)
	}
	if snapshotRequests.Load() != 1 || runtimeRequests.Load() != 0 {
		t.Fatalf("traffic report routing snapshot=%d runtime=%d", snapshotRequests.Load(), runtimeRequests.Load())
	}
}

func TestAgentEventStreamSendsRequestAuthProof(t *testing.T) {
	resetAgentAuthChallengeCacheForTests()
	t.Cleanup(resetAgentAuthChallengeCacheForTests)
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
		w.Header().Set(agentAuthCapabilityHeader, agentAuthChallengeCapability)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
	}))
	defer panel.Close()

	if err := runAgentEventStream(Config{PanelURL: panel.URL, Token: token}); err != io.EOF {
		t.Fatalf("runAgentEventStream error=%v", err)
	}
	if !agentAuthChallengeV2Known(panel.URL) {
		t.Fatal("event stream response capability was not observed")
	}
}

func TestAgentEventStreamUsesChallengeAuthAfterNegotiation(t *testing.T) {
	resetAgentAuthChallengeCacheForTests()
	t.Cleanup(resetAgentAuthChallengeCacheForTests)
	const token = "stream-challenge-token"
	challenge := testAgentAuthChallenges(1, 3)[0]
	previousPanelURL, _ := runtimePanelURL.Load().(string)
	runtimePanelURL.Store("")
	t.Cleanup(func() { runtimePanelURL.Store(previousPanelURL) })

	var challengeRequests atomic.Int32
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch req.URL.Path {
		case "/api/agent/auth-challenge":
			challengeRequests.Add(1)
			w.Header().Set(agentAuthCapabilityHeader, agentAuthChallengeCapability)
			_ = json.NewEncoder(w).Encode(map[string]any{"v": 2, "challenges": []string{challenge}})
		case "/api/stream":
			proof := strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
			parts := strings.Split(proof, ".")
			if len(parts) != 5 || parts[0] != "v2" || parts[2] != challenge {
				t.Errorf("event stream proof=%s", proof)
				http.Error(w, "invalid proof", http.StatusUnauthorized)
				return
			}
			expected := signAgentChallengeAuthProof(token, req.Method, req.URL.Path, []byte(req.URL.Query().Get("e")), parts[2], parts[3])
			if parts[1] != agentTokenFingerprint(token) || parts[4] != expected {
				t.Error("event stream challenge proof signature mismatch")
				http.Error(w, "invalid signature", http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
		default:
			http.NotFound(w, req)
		}
	}))
	defer panel.Close()
	observeAgentAuthCapability(panel.URL, agentAuthChallengeCapability)

	if err := runAgentEventStream(Config{PanelURL: panel.URL, Token: token}); err != io.EOF {
		t.Fatalf("runAgentEventStream error=%v", err)
	}
	if challengeRequests.Load() != 1 {
		t.Fatalf("challengeRequests=%d", challengeRequests.Load())
	}
}
