package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

const agentAuthCapabilityHeader = "X-ForwardX-Agent-Auth"
const agentAuthChallengeCapability = "challenge-v2"
const agentAuthResultHeader = "X-ForwardX-Agent-Auth-Result"
const agentAuthResultAccepted = "accepted"
const agentAuthResultRejected = "rejected"
const agentAuthChallengeBatchSize = 32
const agentAuthChallengeCacheTTL = 8 * time.Minute
const agentAuthChallengeFetchTimeout = 8 * time.Second
const agentAuthChallengeRetryDelay = 5 * time.Second
const agentAuthChallengeResponseLimit = 64 * 1024

type agentAuthChallengePanelState struct {
	advertised    bool
	challenges    []string
	expiresAt     time.Time
	retryAfter    time.Time
	fetchDone     chan struct{}
	refreshNeeded bool
	generation    uint64
}

var agentAuthChallengeCache = struct {
	sync.Mutex
	panels map[string]*agentAuthChallengePanelState
}{panels: make(map[string]*agentAuthChallengePanelState)}

type agentRequestAuth struct {
	proof                 string
	version               string
	challengeGeneration   uint64
	challengeKnownAtStart bool
}

type agentRequestAttemptError struct {
	err                   error
	auth                  agentRequestAuth
	authResult            string
	responseAuthenticated bool
}

func (e *agentRequestAttemptError) Error() string {
	return e.err.Error()
}

func (e *agentRequestAttemptError) Unwrap() error {
	return e.err
}

func wrapAgentRequestAttemptError(err error, auth agentRequestAuth, authResult string, responseAuthenticated bool) error {
	if err == nil {
		return nil
	}
	normalizedResult := strings.ToLower(strings.TrimSpace(authResult))
	if normalizedResult == agentAuthResultAccepted {
		responseAuthenticated = true
	}
	return &agentRequestAttemptError{
		err:                   err,
		auth:                  auth,
		authResult:            normalizedResult,
		responseAuthenticated: responseAuthenticated,
	}
}

func agentRequestAttemptFromError(err error) (*agentRequestAttemptError, bool) {
	var attempt *agentRequestAttemptError
	if !errors.As(err, &attempt) || attempt == nil {
		return nil, false
	}
	return attempt, true
}

func agentRequestResponseAuthenticated(err error) bool {
	attempt, ok := agentRequestAttemptFromError(err)
	return ok && attempt.responseAuthenticated
}

func agentRequestAuthRejected(err error) bool {
	attempt, ok := agentRequestAttemptFromError(err)
	return ok && !attempt.responseAuthenticated && attempt.authResult == agentAuthResultRejected
}

func normalizedAgentAuthPanelURL(panelURL string) string {
	return normalizePanelURL(panelURL)
}

func responseAdvertisesAgentAuthChallengeV2(headerValue string) bool {
	for _, capability := range strings.Split(headerValue, ",") {
		if strings.EqualFold(strings.TrimSpace(capability), agentAuthChallengeCapability) {
			return true
		}
	}
	return false
}

func observeAgentAuthCapability(panelURL, headerValue string) {
	if !responseAdvertisesAgentAuthChallengeV2(headerValue) {
		return
	}
	key := normalizedAgentAuthPanelURL(panelURL)
	if key == "" {
		return
	}
	agentAuthChallengeCache.Lock()
	state := agentAuthChallengeCache.panels[key]
	if state == nil {
		state = &agentAuthChallengePanelState{}
		agentAuthChallengeCache.panels[key] = state
	}
	state.advertised = true
	agentAuthChallengeCache.Unlock()
}

func clearAgentAuthCapability(panelURL string) {
	key := normalizedAgentAuthPanelURL(panelURL)
	if key == "" {
		return
	}
	agentAuthChallengeCache.Lock()
	state := agentAuthChallengeCache.panels[key]
	if state != nil {
		state.advertised = false
		state.challenges = nil
		state.expiresAt = time.Time{}
		state.retryAfter = time.Time{}
		state.refreshNeeded = false
		state.generation++
	}
	agentAuthChallengeCache.Unlock()
}

func agentAuthChallengeV2Known(panelURL string) bool {
	key := normalizedAgentAuthPanelURL(panelURL)
	if key == "" {
		return false
	}
	agentAuthChallengeCache.Lock()
	state := agentAuthChallengeCache.panels[key]
	known := state != nil && state.advertised
	agentAuthChallengeCache.Unlock()
	return known
}

func invalidateAgentAuthChallenges(panelURL string, generation uint64) bool {
	key := normalizedAgentAuthPanelURL(panelURL)
	if key == "" || generation == 0 {
		return false
	}
	agentAuthChallengeCache.Lock()
	state := agentAuthChallengeCache.panels[key]
	invalidated := state != nil && state.generation == generation
	if invalidated {
		state.challenges = nil
		state.expiresAt = time.Time{}
		state.retryAfter = time.Time{}
		state.refreshNeeded = true
		state.generation++
	}
	agentAuthChallengeCache.Unlock()
	return invalidated
}

func agentAuthChallengeRefreshNeeded(panelURL string) bool {
	key := normalizedAgentAuthPanelURL(panelURL)
	if key == "" {
		return false
	}
	agentAuthChallengeCache.Lock()
	state := agentAuthChallengeCache.panels[key]
	needed := state != nil && state.refreshNeeded
	agentAuthChallengeCache.Unlock()
	return needed
}

func validAgentAuthChallenge(challenge string) bool {
	if len(challenge) < 80 || len(challenge) > 100 {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(challenge)
	return err == nil && len(decoded) == 64 && base64.RawURLEncoding.EncodeToString(decoded) == challenge
}

func fetchAgentAuthChallenges(ctx context.Context, client *http.Client, panelURL string) ([]string, error) {
	if client == nil {
		return nil, fmt.Errorf("agent auth challenge HTTP client is nil")
	}
	ctx, cancel := context.WithTimeout(ctx, agentAuthChallengeFetchTimeout)
	defer cancel()
	cacheNonce, err := newAgentAuthNonce()
	if err != nil {
		return nil, err
	}
	endpoint := fmt.Sprintf(
		"%s/api/agent/auth-challenge?count=%d&nonce=%s",
		normalizedAgentAuthPanelURL(panelURL), agentAuthChallengeBatchSize, cacheNonce,
	)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Cache-Control", "no-store")
	req.Header.Set("Pragma", "no-cache")
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	capabilityAdvertised := responseAdvertisesAgentAuthChallengeV2(res.Header.Get(agentAuthCapabilityHeader))
	if res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusMethodNotAllowed ||
		(res.StatusCode >= 200 && res.StatusCode < 300 && !capabilityAdvertised) {
		clearAgentAuthCapability(panelURL)
	} else if capabilityAdvertised {
		observeAgentAuthCapability(panelURL, res.Header.Get(agentAuthCapabilityHeader))
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 2048))
		return nil, fmt.Errorf("agent auth challenge status: %s", res.Status)
	}
	if !capabilityAdvertised {
		return nil, fmt.Errorf("agent auth challenge capability missing")
	}
	var response struct {
		V          int      `json:"v"`
		Challenges []string `json:"challenges"`
	}
	decoder := json.NewDecoder(io.LimitReader(res.Body, agentAuthChallengeResponseLimit))
	if err := decoder.Decode(&response); err != nil {
		return nil, fmt.Errorf("decode agent auth challenges: %w", err)
	}
	if response.V != 2 || len(response.Challenges) == 0 || len(response.Challenges) > agentAuthChallengeBatchSize {
		return nil, fmt.Errorf("invalid agent auth challenge batch")
	}
	seen := make(map[string]struct{}, len(response.Challenges))
	for _, challenge := range response.Challenges {
		if !validAgentAuthChallenge(challenge) {
			return nil, fmt.Errorf("invalid agent auth challenge")
		}
		if _, exists := seen[challenge]; exists {
			return nil, fmt.Errorf("duplicate agent auth challenge")
		}
		seen[challenge] = struct{}{}
	}
	return response.Challenges, nil
}

func takeAgentAuthChallenge(ctx context.Context, client *http.Client, panelURL string) (string, uint64, bool) {
	key := normalizedAgentAuthPanelURL(panelURL)
	if key == "" {
		return "", 0, false
	}
	if ctx == nil {
		ctx = context.Background()
	}
	for {
		now := time.Now()
		agentAuthChallengeCache.Lock()
		state := agentAuthChallengeCache.panels[key]
		if state == nil || !state.advertised {
			agentAuthChallengeCache.Unlock()
			return "", 0, false
		}
		if !state.expiresAt.IsZero() && !now.Before(state.expiresAt) {
			state.challenges = nil
			state.expiresAt = time.Time{}
		}
		if len(state.challenges) > 0 {
			last := len(state.challenges) - 1
			challenge := state.challenges[last]
			state.challenges = state.challenges[:last]
			generation := state.generation
			agentAuthChallengeCache.Unlock()
			return challenge, generation, true
		}
		if now.Before(state.retryAfter) {
			agentAuthChallengeCache.Unlock()
			return "", 0, false
		}
		if state.fetchDone != nil {
			done := state.fetchDone
			agentAuthChallengeCache.Unlock()
			select {
			case <-done:
				continue
			case <-ctx.Done():
				return "", 0, false
			}
		}
		state.fetchDone = make(chan struct{})
		done := state.fetchDone
		agentAuthChallengeCache.Unlock()

		challenges, err := fetchAgentAuthChallenges(ctx, client, key)
		now = time.Now()
		agentAuthChallengeCache.Lock()
		state = agentAuthChallengeCache.panels[key]
		if state != nil && state.fetchDone == done {
			if err == nil {
				state.generation++
				if state.generation == 0 {
					state.generation = 1
				}
				state.challenges = append(state.challenges[:0], challenges...)
				state.expiresAt = now.Add(agentAuthChallengeCacheTTL)
				state.retryAfter = time.Time{}
				state.refreshNeeded = false
			} else {
				state.retryAfter = now.Add(agentAuthChallengeRetryDelay)
			}
			state.fetchDone = nil
			close(done)
		}
		agentAuthChallengeCache.Unlock()
		if err != nil {
			return "", 0, false
		}
	}
}

func newAgentRequestAuthProof(ctx context.Context, client *http.Client, panelURL, token, method, path string, body []byte) (string, error) {
	auth, err := newAgentRequestAuth(ctx, client, panelURL, token, method, path, body)
	return auth.proof, err
}

func newAgentRequestAuth(ctx context.Context, client *http.Client, panelURL, token, method, path string, body []byte) (agentRequestAuth, error) {
	return newAgentRequestAuthWithBodies(ctx, client, panelURL, token, method, path, body, body)
}

func newAgentRequestAuthWithBodies(
	ctx context.Context,
	client *http.Client,
	panelURL, token, method, path string,
	legacyBody, challengeBody []byte,
) (agentRequestAuth, error) {
	knownAtStart := agentAuthChallengeV2Known(panelURL)
	if challenge, generation, ok := takeAgentAuthChallenge(ctx, client, panelURL); ok {
		proof, err := newAgentChallengeAuthProof(token, method, path, challengeBody, challenge)
		return agentRequestAuth{
			proof:                 proof,
			version:               "v2",
			challengeGeneration:   generation,
			challengeKnownAtStart: knownAtStart,
		}, err
	}
	proof, err := newAgentAuthProof(token, method, path, legacyBody)
	return agentRequestAuth{
		proof:                 proof,
		version:               "v1",
		challengeKnownAtStart: knownAtStart,
	}, err
}

func resetAgentAuthChallengeCacheForTests() {
	agentAuthChallengeCache.Lock()
	agentAuthChallengeCache.panels = make(map[string]*agentAuthChallengePanelState)
	agentAuthChallengeCache.Unlock()
}
