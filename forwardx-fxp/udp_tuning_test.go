package main

import (
	"bytes"
	"net"
	"testing"
)

func TestFXPUDPQueueEnforcesPacketAndByteLimits(t *testing.T) {
	queue := newFXPUDPQueue(3, 10)
	if dropped := queue.enqueue([]byte("aaaa")); dropped {
		t.Fatal("first packet was unexpectedly dropped")
	}
	if dropped := queue.enqueue([]byte("bbbb")); dropped {
		t.Fatal("second packet was unexpectedly dropped")
	}
	if dropped := queue.enqueue([]byte("cccc")); !dropped {
		t.Fatal("byte budget did not evict the oldest packet")
	}
	if got := queue.pending(); got != 2 {
		t.Fatalf("pending packets = %d, want 2", got)
	}
	if got := queue.bytes(); got != 8 {
		t.Fatalf("queued bytes = %d, want 8", got)
	}

	done := make(chan struct{})
	packet, ok := queue.next(done)
	if !ok || !bytes.Equal(packet.payload, []byte("bbbb")) {
		t.Fatalf("oldest retained packet = %q, ok=%v, want bbbb", packet.payload, ok)
	}
	packet, ok = queue.next(done)
	if !ok || !bytes.Equal(packet.payload, []byte("cccc")) {
		t.Fatalf("newest retained packet = %q, ok=%v, want cccc", packet.payload, ok)
	}
	if got := queue.bytes(); got != 0 {
		t.Fatalf("queued bytes after drain = %d, want 0", got)
	}
}

func TestFXPUDPQueueRejectsOversizedPacketWithoutDiscardingQueue(t *testing.T) {
	queue := newFXPUDPQueue(2, 4)
	if dropped := queue.enqueue([]byte("keep")); dropped {
		t.Fatal("initial packet was unexpectedly dropped")
	}
	if dropped := queue.enqueue([]byte("oversized")); !dropped {
		t.Fatal("oversized packet was unexpectedly accepted")
	}
	if got := queue.pending(); got != 1 {
		t.Fatalf("pending packets = %d, want 1", got)
	}
	if got := queue.bytes(); got != 4 {
		t.Fatalf("queued bytes = %d, want 4", got)
	}
}

func TestFXPUDPSessionLimitsRespectConfiguredAndHardLimits(t *testing.T) {
	maxSessions, maxPerIP := fxpUDPSessionLimits(config{MaxConnections: 200, MaxIPs: 12})
	if maxSessions != 200 || maxPerIP != 12 {
		t.Fatalf("configured limits = %d/%d, want 200/12", maxSessions, maxPerIP)
	}

	maxSessions, maxPerIP = fxpUDPSessionLimits(config{MaxConnections: fxpUDPMaxSessions + 1, MaxIPs: fxpUDPMaxSessionsPerIP + 1})
	if maxSessions != fxpUDPMaxSessions || maxPerIP != fxpUDPMaxSessionsPerIP {
		t.Fatalf("hard limits = %d/%d, want %d/%d", maxSessions, maxPerIP, fxpUDPMaxSessions, fxpUDPMaxSessionsPerIP)
	}

	maxSessions, maxPerIP = fxpUDPSessionLimits(config{MaxConnections: 4, MaxIPs: 10})
	if maxSessions != 4 || maxPerIP != 4 {
		t.Fatalf("per-IP clamp = %d/%d, want 4/4", maxSessions, maxPerIP)
	}
}

func TestOldestUDPDirectEntrySessionScopesBySourceIP(t *testing.T) {
	newSession := func(key, ip string, activity int64) *udpDirectEntrySession {
		session := &udpDirectEntrySession{key: key, clientAddr: &net.UDPAddr{IP: net.ParseIP(ip)}}
		session.lastActivity.Store(activity)
		return session
	}
	sessions := map[string]*udpDirectEntrySession{
		"first":  newSession("first", "192.0.2.1", 10),
		"second": newSession("second", "192.0.2.1", 20),
		"other":  newSession("other", "192.0.2.2", 5),
	}

	oldest, count := oldestUDPDirectEntrySession(sessions, "192.0.2.1")
	if count != 2 || oldest == nil || oldest.key != "first" {
		t.Fatalf("source-scoped oldest = %v count=%d, want first/2", oldest, count)
	}
	oldest, count = oldestUDPDirectEntrySession(sessions, "")
	if count != 3 || oldest == nil || oldest.key != "other" {
		t.Fatalf("global oldest = %v count=%d, want other/3", oldest, count)
	}
}

func TestOldestUDPStreamEntrySessionScopesBySourceIP(t *testing.T) {
	newSession := func(key, ip string, activity int64) *udpEntrySession {
		session := &udpEntrySession{key: key, clientAddr: &net.UDPAddr{IP: net.ParseIP(ip)}}
		session.lastActivity.Store(activity)
		return session
	}
	sessions := map[string]*udpEntrySession{
		"first":  newSession("first", "192.0.2.10", 10),
		"second": newSession("second", "192.0.2.10", 20),
		"other":  newSession("other", "192.0.2.20", 5),
	}

	oldest, count := oldestUDPEntrySession(sessions, "192.0.2.10")
	if count != 2 || oldest == nil || oldest.key != "first" {
		t.Fatalf("source-scoped oldest = %v count=%d, want first/2", oldest, count)
	}
	oldest, count = oldestUDPEntrySession(sessions, "")
	if count != 3 || oldest == nil || oldest.key != "other" {
		t.Fatalf("global oldest = %v count=%d, want other/3", oldest, count)
	}
}
