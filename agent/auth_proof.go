package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"
)

const agentAuthKeySalt = "forwardx-agent-auth"
const agentAuthIDSalt = "forwardx-agent-auth-id"

func agentTokenFingerprint(token string) string {
	sum := sha256.Sum256([]byte(token + "|" + agentAuthIDSalt))
	return hex.EncodeToString(sum[:])[:32]
}

func agentAuthKey(token string) [sha256.Size]byte {
	return sha256.Sum256([]byte(token + "|" + agentAuthKeySalt))
}

func signAgentAuthProof(token, method, path string, body []byte, timestamp int64, nonce string) string {
	key := agentAuthKey(token)
	bodyHash := sha256.Sum256(body)
	input := strings.Join([]string{
		"v1",
		strings.ToUpper(method),
		path,
		strconv.FormatInt(timestamp, 10),
		nonce,
		hex.EncodeToString(bodyHash[:]),
	}, "\n")
	mac := hmac.New(sha256.New, key[:])
	_, _ = mac.Write([]byte(input))
	return hex.EncodeToString(mac.Sum(nil))
}

func signAgentChallengeAuthProof(token, method, path string, body []byte, challenge, nonce string) string {
	key := agentAuthKey(token)
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

func newAgentAuthNonce() (string, error) {
	nonceBytes := make([]byte, 16)
	if _, err := rand.Read(nonceBytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(nonceBytes), nil
}

func newAgentAuthProof(token, method, path string, body []byte) (string, error) {
	nonce, err := newAgentAuthNonce()
	if err != nil {
		return "", err
	}
	timestamp := time.Now().UnixMilli()
	signature := signAgentAuthProof(token, method, path, body, timestamp, nonce)
	return fmt.Sprintf("v1.%s.%d.%s.%s", agentTokenFingerprint(token), timestamp, nonce, signature), nil
}

func newAgentChallengeAuthProof(token, method, path string, body []byte, challenge string) (string, error) {
	nonce, err := newAgentAuthNonce()
	if err != nil {
		return "", err
	}
	signature := signAgentChallengeAuthProof(token, method, path, body, challenge, nonce)
	return fmt.Sprintf("v2.%s.%s.%s.%s", agentTokenFingerprint(token), challenge, nonce, signature), nil
}
