package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	fxpAgentAuthCapabilityHeader    = "X-ForwardX-Agent-Auth"
	fxpAgentAuthChallengeCapability = "challenge-v2"
	fxpAgentAuthResultHeader        = "X-ForwardX-Agent-Auth-Result"
	fxpAgentAuthResultRejected      = "rejected"
	fxpAgentAuthChallengeBatchSize  = 32
	fxpAgentAuthChallengeCacheTTL   = 8 * time.Minute
	fxpAgentAuthChallengeRetryDelay = 5 * time.Second
	fxpAgentAuthUnsupportedTTL      = 10 * time.Minute
	fxpAgentAuthChallengeLimit      = 64 * 1024
)

var errFXPAgentAuthChallengeUnsupported = errors.New("agent auth challenge unsupported")

type fxpAgentAuthPanelState struct {
	advertised       bool
	challenges       []string
	expiresAt        time.Time
	retryAfter       time.Time
	unsupportedUntil time.Time
	fetchDone        chan struct{}
	generation       uint64
}

var fxpAgentAuthCache = struct {
	sync.Mutex
	panels map[string]*fxpAgentAuthPanelState
}{panels: make(map[string]*fxpAgentAuthPanelState)}

type fxpPanelRequestAuth struct {
	credential string
	version    string
	generation uint64
}

type fxpPanelResponse struct {
	StatusCode int
	Status     string
}

func normalizeFXPPanelURL(panelURL string) string {
	return strings.TrimRight(strings.TrimSpace(panelURL), "/")
}

func fxpAgentTokenFingerprint(token string) string {
	sum := sha256.Sum256([]byte(token + "|forwardx-agent-auth-id"))
	return hex.EncodeToString(sum[:])[:32]
}

func fxpAgentAuthCacheKey(panelURL, token string) string {
	panelURL = normalizeFXPPanelURL(panelURL)
	if panelURL == "" || strings.TrimSpace(token) == "" {
		return ""
	}
	return panelURL + "\x00" + fxpAgentTokenFingerprint(token)
}

func fxpAgentAuthKey(token string) [sha256.Size]byte {
	return sha256.Sum256([]byte(token + "|forwardx-agent-auth"))
}

func newFXPAgentAuthNonce() (string, error) {
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return hex.EncodeToString(nonce), nil
}

func signFXPAgentChallengeProof(token, method, path string, body []byte, challenge, nonce string) string {
	key := fxpAgentAuthKey(token)
	bodyHash := sha256.Sum256(body)
	input := strings.Join([]string{
		"v2",
		strings.ToUpper(method),
		path,
		challenge,
		nonce,
		hex.EncodeToString(bodyHash[:]),
	}, "\n")
	mac := hmac.New(sha256.New, key[:])
	_, _ = mac.Write([]byte(input))
	return hex.EncodeToString(mac.Sum(nil))
}

func validFXPAgentAuthChallenge(challenge string) bool {
	if len(challenge) < 80 || len(challenge) > 100 {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(challenge)
	return err == nil && len(decoded) == 64 && base64.RawURLEncoding.EncodeToString(decoded) == challenge
}

func fxpResponseAdvertisesChallenge(headerValue string) bool {
	for _, value := range strings.Split(headerValue, ",") {
		if strings.EqualFold(strings.TrimSpace(value), fxpAgentAuthChallengeCapability) {
			return true
		}
	}
	return false
}

func observeFXPAgentAuthCapability(panelURL, token, headerValue string) {
	if !fxpResponseAdvertisesChallenge(headerValue) {
		return
	}
	key := fxpAgentAuthCacheKey(panelURL, token)
	if key == "" {
		return
	}
	fxpAgentAuthCache.Lock()
	state := fxpAgentAuthCache.panels[key]
	if state == nil {
		state = &fxpAgentAuthPanelState{}
		fxpAgentAuthCache.panels[key] = state
	}
	state.advertised = true
	state.unsupportedUntil = time.Time{}
	state.retryAfter = time.Time{}
	fxpAgentAuthCache.Unlock()
}

func fxpAgentAuthChallengeKnown(panelURL, token string) bool {
	key := fxpAgentAuthCacheKey(panelURL, token)
	if key == "" {
		return false
	}
	fxpAgentAuthCache.Lock()
	state := fxpAgentAuthCache.panels[key]
	known := state != nil && state.advertised
	fxpAgentAuthCache.Unlock()
	return known
}

func invalidateFXPAgentAuthChallenges(panelURL, token string, generation uint64) bool {
	key := fxpAgentAuthCacheKey(panelURL, token)
	if key == "" || generation == 0 {
		return false
	}
	fxpAgentAuthCache.Lock()
	state := fxpAgentAuthCache.panels[key]
	invalidated := state != nil && state.generation == generation
	if invalidated {
		state.challenges = nil
		state.expiresAt = time.Time{}
		state.retryAfter = time.Time{}
		state.unsupportedUntil = time.Time{}
		state.advertised = true
		state.generation++
	}
	fxpAgentAuthCache.Unlock()
	return invalidated
}

func fetchFXPAgentAuthChallenges(
	ctx context.Context,
	client *http.Client,
	panelURL string,
) ([]string, error) {
	nonce, err := newFXPAgentAuthNonce()
	if err != nil {
		return nil, err
	}
	endpoint := fmt.Sprintf(
		"%s/api/agent/auth-challenge?count=%d&nonce=%s",
		normalizeFXPPanelURL(panelURL),
		fxpAgentAuthChallengeBatchSize,
		url.QueryEscape(nonce),
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
	capabilityAdvertised := fxpResponseAdvertisesChallenge(res.Header.Get(fxpAgentAuthCapabilityHeader))
	if res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusMethodNotAllowed ||
		(res.StatusCode >= 200 && res.StatusCode < 300 && !capabilityAdvertised) {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 2048))
		return nil, errFXPAgentAuthChallengeUnsupported
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 2048))
		return nil, fmt.Errorf("agent auth challenge status: %s", res.Status)
	}
	if !capabilityAdvertised {
		return nil, errFXPAgentAuthChallengeUnsupported
	}
	var response struct {
		V          int      `json:"v"`
		Challenges []string `json:"challenges"`
	}
	decoder := json.NewDecoder(io.LimitReader(res.Body, fxpAgentAuthChallengeLimit))
	if err := decoder.Decode(&response); err != nil {
		return nil, fmt.Errorf("decode agent auth challenges: %w", err)
	}
	if response.V != 2 || len(response.Challenges) == 0 || len(response.Challenges) > fxpAgentAuthChallengeBatchSize {
		return nil, fmt.Errorf("invalid agent auth challenge batch")
	}
	seen := make(map[string]struct{}, len(response.Challenges))
	for _, challenge := range response.Challenges {
		if !validFXPAgentAuthChallenge(challenge) {
			return nil, fmt.Errorf("invalid agent auth challenge")
		}
		if _, exists := seen[challenge]; exists {
			return nil, fmt.Errorf("duplicate agent auth challenge")
		}
		seen[challenge] = struct{}{}
	}
	return response.Challenges, nil
}

func takeFXPAgentAuthChallenge(
	ctx context.Context,
	client *http.Client,
	panelURL, token string,
) (string, uint64, bool) {
	key := fxpAgentAuthCacheKey(panelURL, token)
	if key == "" || client == nil {
		return "", 0, false
	}
	for {
		now := time.Now()
		fxpAgentAuthCache.Lock()
		state := fxpAgentAuthCache.panels[key]
		if state == nil {
			state = &fxpAgentAuthPanelState{}
			fxpAgentAuthCache.panels[key] = state
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
			fxpAgentAuthCache.Unlock()
			return challenge, generation, true
		}
		if now.Before(state.unsupportedUntil) || now.Before(state.retryAfter) {
			fxpAgentAuthCache.Unlock()
			return "", 0, false
		}
		if state.fetchDone != nil {
			done := state.fetchDone
			fxpAgentAuthCache.Unlock()
			select {
			case <-done:
				continue
			case <-ctx.Done():
				return "", 0, false
			}
		}
		state.fetchDone = make(chan struct{})
		done := state.fetchDone
		fxpAgentAuthCache.Unlock()

		challenges, err := fetchFXPAgentAuthChallenges(ctx, client, panelURL)
		now = time.Now()
		fxpAgentAuthCache.Lock()
		state = fxpAgentAuthCache.panels[key]
		if state != nil && state.fetchDone == done {
			switch {
			case err == nil:
				state.advertised = true
				state.unsupportedUntil = time.Time{}
				state.retryAfter = time.Time{}
				state.generation++
				if state.generation == 0 {
					state.generation = 1
				}
				state.challenges = append(state.challenges[:0], challenges...)
				state.expiresAt = now.Add(fxpAgentAuthChallengeCacheTTL)
			case errors.Is(err, errFXPAgentAuthChallengeUnsupported):
				state.advertised = false
				state.challenges = nil
				state.expiresAt = time.Time{}
				state.retryAfter = time.Time{}
				state.unsupportedUntil = now.Add(fxpAgentAuthUnsupportedTTL)
				state.generation++
			default:
				state.retryAfter = now.Add(fxpAgentAuthChallengeRetryDelay)
			}
			state.fetchDone = nil
			close(done)
		}
		fxpAgentAuthCache.Unlock()
		if err != nil {
			return "", 0, false
		}
	}
}

func newFXPPanelRequestAuth(
	ctx context.Context,
	client *http.Client,
	panelURL, token, method, path string,
	body []byte,
) (fxpPanelRequestAuth, error) {
	challenge, generation, ok := takeFXPAgentAuthChallenge(ctx, client, panelURL, token)
	if !ok {
		return fxpPanelRequestAuth{credential: token, version: "raw"}, nil
	}
	nonce, err := newFXPAgentAuthNonce()
	if err != nil {
		return fxpPanelRequestAuth{}, err
	}
	signature := signFXPAgentChallengeProof(token, method, path, body, challenge, nonce)
	credential := fmt.Sprintf(
		"v2.%s.%s.%s.%s",
		fxpAgentTokenFingerprint(token), challenge, nonce, signature,
	)
	return fxpPanelRequestAuth{credential: credential, version: "v2", generation: generation}, nil
}

func postFXPEncryptedPanelRequest(
	client *http.Client,
	panelURL, token, path string,
	body []byte,
) (fxpPanelResponse, error) {
	panelURL = normalizeFXPPanelURL(panelURL)
	if client == nil || panelURL == "" || strings.TrimSpace(token) == "" {
		return fxpPanelResponse{}, fmt.Errorf("invalid FXP panel request configuration")
	}
	var lastResponse fxpPanelResponse
	v2RejectionRetryUsed := false
	for attempt := 0; attempt < 3; attempt++ {
		auth, err := newFXPPanelRequestAuth(context.Background(), client, panelURL, token, http.MethodPost, path, body)
		if err != nil {
			return fxpPanelResponse{}, err
		}
		req, err := http.NewRequest(http.MethodPost, panelURL+path, bytes.NewReader(body))
		if err != nil {
			return fxpPanelResponse{}, err
		}
		req.Header.Set("Authorization", "Bearer "+auth.credential)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Agent-Encrypted", "1")
		res, err := client.Do(req)
		if err != nil {
			return fxpPanelResponse{}, err
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 2048))
		_ = res.Body.Close()
		lastResponse = fxpPanelResponse{StatusCode: res.StatusCode, Status: res.Status}
		observeFXPAgentAuthCapability(panelURL, token, res.Header.Get(fxpAgentAuthCapabilityHeader))
		if res.StatusCode < 300 {
			return lastResponse, nil
		}
		authRejected := strings.EqualFold(
			strings.TrimSpace(res.Header.Get(fxpAgentAuthResultHeader)),
			fxpAgentAuthResultRejected,
		)
		if !authRejected {
			return lastResponse, nil
		}
		if auth.version == "v2" {
			invalidateFXPAgentAuthChallenges(panelURL, token, auth.generation)
			if v2RejectionRetryUsed {
				return lastResponse, nil
			}
			v2RejectionRetryUsed = true
			continue
		}
		if !fxpAgentAuthChallengeKnown(panelURL, token) {
			return lastResponse, nil
		}
	}
	return lastResponse, nil
}

func resetFXPAgentAuthCacheForTests() {
	fxpAgentAuthCache.Lock()
	fxpAgentAuthCache.panels = make(map[string]*fxpAgentAuthPanelState)
	fxpAgentAuthCache.Unlock()
}
