package main

import (
	"net"
	"strconv"
	"testing"
	"time"
)

func TestUnauthenticatedHandshakeDoesNotPopulateReplayCache(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	cfg := config{TunnelID: 99123, RuleID: 17, ListenPort: 45678, Key: "invalid-replay-cache-handshake"}
	salt := make([]byte, fxpSaltSize)
	for index := range salt {
		salt[index] = byte(index + 31)
	}
	key := replayKey(cfg, salt)
	errCh := make(chan error, 1)
	go func() {
		_, err := newServerSecureConn(server, cfg)
		errCh <- err
	}()
	if _, err := writeFull(client, salt); err != nil {
		t.Fatal(err)
	}
	if _, err := writeFull(client, make([]byte, 4+16)); err != nil {
		t.Fatal(err)
	}
	if err := <-errCh; err == nil {
		t.Fatal("unauthenticated handshake was accepted")
	}
	fxpReplaySeen.mu.Lock()
	_, retained := fxpReplaySeen.seen[key]
	fxpReplaySeen.mu.Unlock()
	if retained {
		t.Fatal("unauthenticated salt populated the replay cache")
	}
}

func TestReplayCacheRejectsDuplicatesAndExpiresEntries(t *testing.T) {
	cache := newReplayCache(time.Minute, 10)
	now := time.Unix(1000, 0)

	if !cache.addAt("key", now) {
		t.Fatal("first key was rejected")
	}
	if cache.addAt("key", now.Add(time.Minute-time.Nanosecond)) {
		t.Fatal("duplicate key was accepted before expiry")
	}
	if !cache.addAt("key", now.Add(time.Minute)) {
		t.Fatal("key was not accepted at its expiry boundary")
	}
	if len(cache.seen) != 1 || len(cache.expiry) != 1 {
		t.Fatalf("expired entry was not removed: seen=%d expiry=%d", len(cache.seen), len(cache.expiry))
	}
}

func TestReplayCacheEvictsOldestAtCapacity(t *testing.T) {
	cache := newReplayCache(time.Minute, 3)
	now := time.Unix(1000, 0)
	for index, key := range []string{"a", "b", "c", "d"} {
		if !cache.addAt(key, now.Add(time.Duration(index))) {
			t.Fatalf("key %q was rejected", key)
		}
	}

	if len(cache.seen) != 3 || len(cache.expiry) != 3 {
		t.Fatalf("cache exceeded its bound: seen=%d expiry=%d", len(cache.seen), len(cache.expiry))
	}
	if _, ok := cache.seen["a"]; ok {
		t.Fatal("oldest entry was not evicted")
	}
	for _, key := range []string{"b", "c", "d"} {
		if cache.addAt(key, now.Add(10*time.Nanosecond)) {
			t.Fatalf("retained key %q was accepted as new", key)
		}
	}
}

func TestReplayCacheWithZeroCapacityDoesNotRetainEntries(t *testing.T) {
	cache := newReplayCache(time.Minute, 0)
	now := time.Unix(1000, 0)
	if !cache.addAt("key", now) || !cache.addAt("key", now) {
		t.Fatal("zero-capacity cache should accept keys without retaining them")
	}
	if len(cache.seen) != 0 || len(cache.expiry) != 0 {
		t.Fatalf("zero-capacity cache retained entries: seen=%d expiry=%d", len(cache.seen), len(cache.expiry))
	}
}

func BenchmarkReplayCacheAtCapacity(b *testing.B) {
	const capacity = 100000
	cache := newReplayCache(time.Hour, capacity)
	now := time.Unix(1000, 0)
	for index := 0; index < capacity; index++ {
		cache.addAt(strconv.Itoa(index), now.Add(time.Duration(index)))
	}

	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		cache.addAt(strconv.Itoa(capacity+index), now.Add(time.Duration(capacity+index)))
	}
}
