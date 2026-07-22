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

func signAgentAuthProof(token, method, path string, body []byte, timestamp int64, nonce string) string {
	key := sha256.Sum256([]byte(token + "|" + agentAuthKeySalt))
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

func newAgentAuthProof(token, method, path string, body []byte) (string, error) {
	nonceBytes := make([]byte, 16)
	if _, err := rand.Read(nonceBytes); err != nil {
		return "", err
	}
	timestamp := time.Now().UnixMilli()
	nonce := hex.EncodeToString(nonceBytes)
	signature := signAgentAuthProof(token, method, path, body, timestamp, nonce)
	return fmt.Sprintf("v1.%s.%d.%s.%s", agentTokenFingerprint(token), timestamp, nonce, signature), nil
}
