package main

import (
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestDecryptForPanelUsesAuthenticatedServerClock(t *testing.T) {
	resetEncryptedResponseStateForTests()
	const token = "response-clock-token"
	const panel = "https://panel.example.test/"
	serverNow := time.Now().Add(10 * time.Minute)
	env, err := encryptAt(map[string]any{"ok": true}, token, serverNow.UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decrypt(env, token); err == nil || !strings.Contains(err.Error(), "timestamp") {
		t.Fatalf("expected local clock rejection, got %v", err)
	}
	resetEncryptedResponseStateForTests()
	plain, err := decryptForPanel(env, token, panel, stringHeader(serverNow))
	if err != nil {
		t.Fatalf("server clock should authorize response: %v", err)
	}
	if string(plain) != `{"ok":true}` {
		t.Fatalf("unexpected plaintext: %s", plain)
	}
}

func TestDecryptForPanelRejectsReplayAndBadClockHeader(t *testing.T) {
	resetEncryptedResponseStateForTests()
	const token = "response-replay-token"
	env, err := encrypt(map[string]any{"ok": true}, token)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decryptForPanel(env, token, "https://panel.example.test", "not-a-time"); err != nil {
		t.Fatal(err)
	}
	if _, err := decryptForPanel(env, token, "https://panel.example.test", ""); err == nil || !strings.Contains(err.Error(), "replay") {
		t.Fatalf("expected replay rejection, got %v", err)
	}
	if got := len(encryptedResponseClock); got != 0 {
		t.Fatalf("invalid clock header polluted clock state: %d", got)
	}
}

func TestDecryptForPanelBadMACDoesNotPolluteClock(t *testing.T) {
	resetEncryptedResponseStateForTests()
	const token = "response-mac-token"
	env, err := encrypt(map[string]any{"ok": true}, token)
	if err != nil {
		t.Fatal(err)
	}
	env.MAC = strings.Repeat("0", len(env.MAC))
	serverNow := time.Now().Add(10 * time.Minute)
	if _, err := decryptForPanel(env, token, "https://panel.example.test", stringHeader(serverNow)); err == nil || !strings.Contains(err.Error(), "mac") {
		t.Fatalf("expected MAC rejection, got %v", err)
	}
	if got := len(encryptedResponseClock); got != 0 {
		t.Fatalf("bad MAC polluted clock state: %d", got)
	}
}

func TestEventStreamClockHintKeepsItsOffsetAsTheStreamAges(t *testing.T) {
	connectionTime := time.Date(2026, time.August, 14, 12, 0, 0, 0, time.UTC)
	serverTime := connectionTime.Add(10 * time.Minute)
	offset, ok := parseEncryptedResponseClockOffsetAt(stringHeader(serverTime), connectionTime)
	if !ok {
		t.Fatal("expected a valid stream clock offset")
	}

	twoHoursLater := connectionTime.Add(2 * time.Hour)
	refreshedHeader := encryptedResponseClockHeaderAt(offset, twoHoursLater)
	refreshedOffset, ok := parseEncryptedResponseClockOffsetAt(refreshedHeader, twoHoursLater)
	if !ok {
		t.Fatal("expected the refreshed stream clock hint to stay valid")
	}
	if delta := absDuration(refreshedOffset - 10*time.Minute); delta > time.Millisecond {
		t.Fatalf("stream clock offset drifted by %s", delta)
	}
}

func TestEncryptedResponseReplayCacheBounded(t *testing.T) {
	resetEncryptedResponseStateForTests()
	const token = "response-cache-token"
	for i := 0; i < encryptedResponseReplayCacheLimit+128; i++ {
		env, err := encrypt(map[string]any{"i": i}, token)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := decrypt(env, token); err != nil {
			t.Fatal(err)
		}
	}
	if got := len(encryptedResponseReplay); got > encryptedResponseReplayCacheLimit {
		t.Fatalf("replay cache exceeded limit: %d", got)
	}
}

func stringHeader(value time.Time) string {
	return strconv.FormatInt(value.UnixMilli(), 10)
}
