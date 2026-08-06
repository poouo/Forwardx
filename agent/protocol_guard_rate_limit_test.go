package main

import (
	"context"
	"errors"
	"io"
	"net"
	"strconv"
	"testing"
	"time"
)

func exhaustProtocolGuardLimiter(t *testing.T, limiter *protocolGuardSharedRateLimiter) {
	t.Helper()
	if limiter == nil {
		t.Fatal("expected a configured protocol guard limiter")
	}
	limiter.mu.Lock()
	burst := limiter.burst
	bucket := limiter.limiter
	limiter.mu.Unlock()
	if !bucket.AllowN(time.Now(), burst) {
		t.Fatal("failed to consume initial limiter burst")
	}
}

func waitForProtocolGuardReservation(t *testing.T, limiter *protocolGuardSharedRateLimiter) {
	t.Helper()
	limiter.mu.Lock()
	bucket := limiter.limiter
	limiter.mu.Unlock()
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if bucket.Tokens() < 0 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("rate limiter wait did not create a pending reservation")
}

func TestProtocolGuardRateLimitNormalizationAndBurst(t *testing.T) {
	for _, value := range []int64{-10, 0} {
		if got := normalizeProtocolGuardRateLimit(value); got != 0 {
			t.Fatalf("normalize rate %d = %d, want 0", value, got)
		}
	}
	if got := normalizeProtocolGuardRateLimit(1234); got != 1234 {
		t.Fatalf("normalize positive rate = %d, want 1234", got)
	}
	if got := normalizeProtocolGuardRateLimitScope("  User:42/Tunnel:7  ", 1, 80); got != "user:42/tunnel:7" {
		t.Fatalf("normalized scope = %q", got)
	}
	if got := normalizeProtocolGuardRateLimitScope("", 9, 8443); got != "guard:9:8443" {
		t.Fatalf("fallback scope = %q", got)
	}

	if got := protocolGuardRateBurst(1); got != protocolGuardRateBurstMin {
		t.Fatalf("low-rate burst = %d, want %d", got, protocolGuardRateBurstMin)
	}
	if protocolGuardRateBurstMin < 65535 {
		t.Fatalf("minimum burst %d cannot admit a maximum UDP datagram", protocolGuardRateBurstMin)
	}
	if got := protocolGuardRateBurst(1 << 40); got != protocolGuardRateBurstMax {
		t.Fatalf("high-rate burst = %d, want capped %d", got, protocolGuardRateBurstMax)
	}
	if got := protocolGuardRateBurst(2 * 1024 * 1024); got <= protocolGuardRateBurstMin || got >= protocolGuardRateBurstMax {
		t.Fatalf("mid-rate burst = %d, want a smooth bounded value", got)
	}
	if protocolGuardRateWaitChunk >= protocolGuardRateBurstMin {
		t.Fatalf("wait chunk %d must stay below burst %d to preserve fairness", protocolGuardRateWaitChunk, protocolGuardRateBurstMin)
	}
	if protocolGuardUDPMaxSessions <= 0 {
		t.Fatalf("UDP session limit must be positive, got %d", protocolGuardUDPMaxSessions)
	}
	if protocolGuardUDPMaxSessions > 512 {
		t.Fatalf("UDP session limit %d permits excessive per-rule memory growth", protocolGuardUDPMaxSessions)
	}
}

func TestProtocolGuardRateLimiterSharedByScopeAndDirection(t *testing.T) {
	scope := normalizeProtocolGuardRateLimitScope(t.Name(), 0, 0)
	inA := acquireProtocolGuardRateLimiter(scope, protocolGuardRateIn, 1)
	inB := acquireProtocolGuardRateLimiter(scope, protocolGuardRateIn, 1)
	out := acquireProtocolGuardRateLimiter(scope, protocolGuardRateOut, 1000)
	defer releaseProtocolGuardRateLimiter(scope, protocolGuardRateIn, inA)
	defer releaseProtocolGuardRateLimiter(scope, protocolGuardRateIn, inB)
	defer releaseProtocolGuardRateLimiter(scope, protocolGuardRateOut, out)

	if inA == nil || inA != inB {
		t.Fatal("same scope and direction did not share one limiter")
	}
	if out == nil || out == inA {
		t.Fatal("opposite directions unexpectedly shared one limiter")
	}
	inA.mu.Lock()
	configuredRate := inA.bytesPerSecond
	inA.mu.Unlock()
	protocolGuardRateMu.Lock()
	refs := inA.refs
	protocolGuardRateMu.Unlock()
	if configuredRate != 1 {
		t.Fatalf("shared limiter rate = %d, want 1", configuredRate)
	}
	if refs != 2 {
		t.Fatalf("shared limiter refs = %d, want 2", refs)
	}
	inA.mu.Lock()
	burst := inA.burst
	limiter := inA.limiter
	inA.mu.Unlock()
	if !limiter.AllowN(time.Now(), burst) {
		t.Fatal("failed to consume shared limiter burst")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if err := inB.wait(ctx, nil, 1); err == nil {
		t.Fatal("second guard bypassed capacity consumed through the shared limiter")
	}
}

func TestProtocolGuardRateOnlyUpdateKeepsRoutingSignature(t *testing.T) {
	base := guardRule{
		RuleID: 11, TunnelID: 12, ListenPort: 13000,
		TargetIP: "127.0.0.1", TargetPort: 14000, Protocol: "both",
		LimitIn: 1000, LimitOut: 2000, RateLimitScope: "user:1",
	}
	updated := base
	updated.LimitIn = 3000
	updated.LimitOut = 4000
	updated.RateLimitScope = "user:1:tunnel:12"
	if guardRoutingSignature(base) != guardRoutingSignature(updated) {
		t.Fatal("rate-only update changed routing signature")
	}
	updated.TargetPort++
	if guardRoutingSignature(base) == guardRoutingSignature(updated) {
		t.Fatal("route update did not change routing signature")
	}
	updated = base
	updated.BindAddress = "127.0.0.1"
	if guardRoutingSignature(base) == guardRoutingSignature(updated) {
		t.Fatal("bind address update did not change routing signature")
	}
}

func TestGuardActionSignatureIncludesBackendRuntime(t *testing.T) {
	base := action{RuleID: 61, SourcePort: 26001, ForwardType: "guard", RuntimeBackendForwardType: "gost"}
	updated := base
	updated.RuntimeBackendForwardType = "nginx"
	if actionCommandSignature(base) == actionCommandSignature(updated) {
		t.Fatal("backend runtime update did not change the action signature")
	}
}

func TestSyncProtocolGuardsAfterActionsDefersRouteReplacement(t *testing.T) {
	base := guardRule{RuleID: 62, ListenPort: 26002, TargetIP: "192.0.2.1", TargetPort: 80, Protocol: "tcp"}
	server := newProtocolGuardServer(base)
	id := guardID(base)
	protocolGuardMu.Lock()
	originalGuards := protocolGuards
	protocolGuards = map[string]*protocolGuardServer{id: server}
	protocolGuardMu.Unlock()
	originalGeneration := protocolGuardSyncGeneration.Load()
	defer func() {
		server.close()
		protocolGuardSyncGeneration.Store(originalGeneration)
		protocolGuardMu.Lock()
		protocolGuards = originalGuards
		protocolGuardMu.Unlock()
	}()

	updated := base
	updated.TargetPort++
	completed := make(chan struct{})
	syncProtocolGuardsAfterActions(Config{}, []guardRule{updated}, []<-chan struct{}{completed})
	protocolGuardMu.Lock()
	current := protocolGuards[id]
	protocolGuardMu.Unlock()
	if current != server || guardRoutingSignature(current.rule) != guardRoutingSignature(base) {
		t.Fatal("guard route changed before its backend action completed")
	}
	// Invalidate this test generation so releasing the waiter does not perform
	// real listener cleanup or binding on the test host.
	protocolGuardSyncGeneration.Add(1)
	close(completed)
}

func TestProtocolGuardRuleReadinessRequiresLiveListeners(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	rule := guardRule{RuleID: 51, ListenPort: port, Protocol: "tcp"}
	server := newProtocolGuardServer(rule)
	server.tcpLn = listener
	id := guardID(rule)

	protocolGuardMu.Lock()
	originalGuards := protocolGuards
	protocolGuards = map[string]*protocolGuardServer{id: server}
	protocolGuardMu.Unlock()
	defer func() {
		server.close()
		protocolGuardMu.Lock()
		protocolGuards = originalGuards
		protocolGuardMu.Unlock()
	}()

	state := localRuleState{RuleID: rule.RuleID, Port: strconv.Itoa(port), ForwardType: "guard", Protocol: "tcp"}
	if !localRuleStateReady(state, &localRuntimeReadiness{}) {
		t.Fatal("live guard listener was reported unavailable")
	}
	server.rule.BackendPort = 25051
	server.rule.BackendForwardType = "realm"
	backendSnapshot := &runtimeListenSnapshot{tcpPorts: map[int][]string{}, udpPorts: map[int][]string{}}
	backendSnapshot.add("tcp", server.rule.BackendPort, `LISTEN users:(("realm",pid=51,fd=3))`)
	backendReadiness := &localRuntimeReadiness{listenSnapshot: backendSnapshot}
	if !localRuleStateReady(state, backendReadiness) {
		t.Fatal("guard with a live managed backend was reported unavailable")
	}
	if localRuleStateReady(state, &localRuntimeReadiness{listenSnapshot: &runtimeListenSnapshot{tcpPorts: map[int][]string{}, udpPorts: map[int][]string{}, usable: true}}) {
		t.Fatal("guard with a missing managed backend was reported ready")
	}
	server.rule.BackendPort = 0
	server.rule.BackendForwardType = ""
	state.Protocol = "both"
	if localRuleStateReady(state, &localRuntimeReadiness{}) {
		t.Fatal("guard missing its UDP listener was reported ready for both protocols")
	}
	state.Protocol = "tcp"
	server.close()
	if localRuleStateReady(state, &localRuntimeReadiness{}) {
		t.Fatal("closed guard listener was reported ready")
	}
}

func TestProtocolGuardRejectsLocalSelfTarget(t *testing.T) {
	for _, target := range []string{"127.0.0.1", "127.0.0.2", "::1", "[::1]", "0.0.0.0", "::", "localhost"} {
		if !protocolGuardTargetsOwnListener(guardRule{ListenPort: 43001, TargetIP: target, TargetPort: 43001}) {
			t.Fatalf("target %q was not recognized as a self loop", target)
		}
	}
	for _, rule := range []guardRule{
		{ListenPort: 43001, TargetIP: "127.0.0.1", TargetPort: 43002},
		{ListenPort: 43001, TargetIP: "192.0.2.10", TargetPort: 43001},
	} {
		if protocolGuardTargetsOwnListener(rule) {
			t.Fatalf("non-looping route was rejected: %+v", rule)
		}
	}
}

func TestSyncProtocolGuardsAppliesRateOnlyUpdateInPlace(t *testing.T) {
	base := guardRule{
		RuleID: 31, ListenPort: 23001, TargetIP: "127.0.0.1", TargetPort: 23002,
		Protocol: "tcp", RateLimitScope: t.Name(), LimitIn: 1024,
	}
	server := newProtocolGuardServer(base)
	id := guardID(base)

	protocolGuardMu.Lock()
	originalGuards := protocolGuards
	protocolGuards = map[string]*protocolGuardServer{id: server}
	protocolGuardMu.Unlock()
	defer func() {
		server.close()
		protocolGuardMu.Lock()
		protocolGuards = originalGuards
		protocolGuardMu.Unlock()
	}()

	updated := base
	updated.LimitIn = 4096
	syncProtocolGuards(Config{}, []guardRule{updated})

	protocolGuardMu.Lock()
	current := protocolGuards[id]
	protocolGuardMu.Unlock()
	if current != server {
		t.Fatal("rate-only sync replaced the existing guard listener")
	}
	limiter := current.rateLimiter(protocolGuardRateIn)
	if limiter == nil {
		t.Fatal("rate-only sync removed the inbound limiter")
	}
	limiter.mu.Lock()
	configuredRate := limiter.bytesPerSecond
	limiter.mu.Unlock()
	if configuredRate != updated.LimitIn {
		t.Fatalf("rate-only sync configured %d bytes/s, want %d", configuredRate, updated.LimitIn)
	}
}

func TestProtocolGuardRateLimiterHotUpdateAndCloseCancellation(t *testing.T) {
	rule := guardRule{
		RuleID: 21, ListenPort: 22000,
		RateLimitScope: t.Name(), LimitIn: 1,
	}
	server := newProtocolGuardServer(rule)
	defer server.close()

	original := server.rateLimiter(protocolGuardRateIn)
	if original == nil {
		t.Fatal("limited guard has no inbound limiter")
	}
	updated := rule
	updated.LimitIn = 2048
	server.updateRateLimits(updated)
	if current := server.rateLimiter(protocolGuardRateIn); current != original {
		t.Fatal("same-scope hot update replaced the shared limiter")
	}
	original.mu.Lock()
	configuredRate := original.bytesPerSecond
	original.mu.Unlock()
	if configuredRate != updated.LimitIn {
		t.Fatalf("hot-updated rate = %d, want %d", configuredRate, updated.LimitIn)
	}
	updated.LimitIn = 0
	server.updateRateLimits(updated)
	if current := server.rateLimiter(protocolGuardRateIn); current != nil {
		t.Fatal("zero rate did not disable the limiter")
	}
	updated.LimitIn = 1
	server.updateRateLimits(updated)
	original = server.rateLimiter(protocolGuardRateIn)

	// Exhaust the initial burst so the next token waits. Closing the server
	// must cancel that wait immediately rather than leaving a forwarding
	// goroutine blocked until the low rate replenishes it.
	exhaustProtocolGuardLimiter(t, original)
	errCh := make(chan error, 1)
	waitCtx, cancelWait := context.WithCancel(context.Background())
	defer cancelWait()
	go func() {
		errCh <- server.waitRate(waitCtx, protocolGuardRateIn, 1)
	}()
	waitForProtocolGuardReservation(t, original)
	server.close()
	select {
	case err := <-errCh:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("rate wait error = %v, want context cancellation", err)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("server close did not cancel rate limiter wait")
	}
}

func TestProtocolGuardRateWaitRetriesAfterHotUpdate(t *testing.T) {
	rule := guardRule{
		RuleID: 41, ListenPort: 24000,
		RateLimitScope: t.Name(), LimitIn: 1,
	}
	server := newProtocolGuardServer(rule)
	defer server.close()
	limiter := server.rateLimiter(protocolGuardRateIn)
	exhaustProtocolGuardLimiter(t, limiter)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errCh := make(chan error, 1)
	go func() { errCh <- server.waitRate(ctx, protocolGuardRateIn, 1) }()
	waitForProtocolGuardReservation(t, limiter)

	updated := rule
	updated.LimitIn = 1024 * 1024
	server.updateRateLimits(updated)
	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("rate wait failed after hot update: %v", err)
		}
		if ctx.Err() != nil {
			t.Fatalf("hot update canceled the connection context: %v", ctx.Err())
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("hot update left a wait queued against the previous rate")
	}
}

func TestProtocolGuardTCPPeerExitCancelsOtherDirectionWait(t *testing.T) {
	backend, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen backend: %v", err)
	}
	defer backend.Close()
	backendAddr := backend.Addr().(*net.TCPAddr)
	rule := guardRule{
		RuleID: 42, ListenPort: 24001, TargetIP: "127.0.0.1", TargetPort: backendAddr.Port,
		Protocol: "tcp", RateLimitScope: t.Name(), LimitOut: 1,
	}
	server := newProtocolGuardServer(rule)
	defer server.close()
	limiter := server.rateLimiter(protocolGuardRateOut)
	exhaustProtocolGuardLimiter(t, limiter)

	backendClosed := make(chan struct{})
	go func() {
		conn, acceptErr := backend.Accept()
		if acceptErr != nil {
			close(backendClosed)
			return
		}
		defer conn.Close()
		_, _ = conn.Write([]byte{1})
		_, _ = io.Copy(io.Discard, conn)
		close(backendClosed)
	}()

	guardClient, peerClient := net.Pipe()
	defer peerClient.Close()
	handleDone := make(chan struct{})
	go func() {
		server.handleConn(Config{}, guardClient)
		close(handleDone)
	}()
	waitForProtocolGuardReservation(t, limiter)
	_ = peerClient.Close()

	select {
	case <-handleDone:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("TCP handler did not reap both copy directions after peer exit")
	}
	select {
	case <-backendClosed:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("TCP handler did not close the backend connection")
	}
	limiter.mu.Lock()
	bucket := limiter.limiter
	limiter.mu.Unlock()
	if tokens := bucket.Tokens(); tokens < -0.5 {
		t.Fatalf("peer exit left a stale rate reservation: tokens=%f", tokens)
	}
}

func TestProtocolGuardCloseReapsIdleTCPConnection(t *testing.T) {
	backend, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen backend: %v", err)
	}
	defer backend.Close()
	backendAddr := backend.Addr().(*net.TCPAddr)
	server := newProtocolGuardServer(guardRule{
		RuleID: 43, ListenPort: 24002, TargetIP: "127.0.0.1", TargetPort: backendAddr.Port,
		Protocol: "tcp", RateLimitScope: t.Name(), LimitIn: 1,
	})

	accepted := make(chan struct{})
	backendClosed := make(chan struct{})
	go func() {
		conn, acceptErr := backend.Accept()
		if acceptErr != nil {
			close(accepted)
			close(backendClosed)
			return
		}
		close(accepted)
		defer conn.Close()
		_, _ = io.Copy(io.Discard, conn)
		close(backendClosed)
	}()

	guardClient, peerClient := net.Pipe()
	defer peerClient.Close()
	handleDone := make(chan struct{})
	go func() {
		server.handleConn(Config{}, guardClient)
		close(handleDone)
	}()
	select {
	case <-accepted:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("guard did not establish the backend connection")
	}
	server.close()
	select {
	case <-handleDone:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("server close did not reap an idle TCP handler")
	}
	select {
	case <-backendClosed:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("server close did not close the idle backend connection")
	}
}
