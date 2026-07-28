package main

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestWireGuardDeviceUpdateConfigPreservesExistingPeers(t *testing.T) {
	previous := wireGuardSpec{Peers: []wireGuardPeerSpec{
		{ID: "keep", PublicKey: strings.Repeat("1", 64), Address: "100.64.0.2", EndpointHost: "old.example", EndpointPort: 30001, PersistentKeepalive: 25},
		{ID: "remove", PublicKey: strings.Repeat("2", 64), Address: "100.64.0.3"},
	}}
	next := wireGuardSpec{Peers: []wireGuardPeerSpec{
		{ID: "keep", PublicKey: strings.Repeat("1", 64), Address: "100.64.0.2", EndpointHost: "new.example", EndpointPort: 30001, PersistentKeepalive: 25},
		{ID: "add", PublicKey: strings.Repeat("3", 64), Address: "100.64.0.4"},
	}}
	added, removed, updated, removedKeys := wireGuardPeerUpdateSummary(previous, next)
	if added != 1 || removed != 1 || updated != 1 {
		t.Fatalf("unexpected update summary added=%d removed=%d updated=%d", added, removed, updated)
	}
	config := wireGuardDeviceConfig(next, false, removedKeys)
	if strings.Contains(config, "replace_peers=true") {
		t.Fatal("incremental update still replaces every WireGuard peer")
	}
	if strings.Contains(config, "private_key=") || strings.Contains(config, "listen_port=") {
		t.Fatal("incremental update still reconfigures the WireGuard device socket")
	}
	if !strings.Contains(config, "public_key="+strings.Repeat("2", 64)+"\nremove=true") {
		t.Fatal("removed peer was not explicitly deleted")
	}
	if !strings.Contains(config, "replace_allowed_ips=true") {
		t.Fatal("incremental update does not replace stale allowed IPs")
	}
	if !strings.Contains(config, "persistent_keepalive_interval=0") {
		t.Fatal("incremental update cannot clear stale keepalive settings")
	}
}

func TestWireGuardDNSRefreshDoesNotRemovePeers(t *testing.T) {
	peer := wireGuardPeerSpec{ID: "peer", PublicKey: strings.Repeat("4", 64), Address: "100.64.0.2", EndpointHost: "ddns.example", EndpointPort: 30001, PersistentKeepalive: 25}
	previous := wireGuardSpec{Generation: 1, Peers: []wireGuardPeerSpec{peer}}
	next := wireGuardSpec{Generation: 2, Peers: []wireGuardPeerSpec{peer}}
	added, removed, updated, removedKeys := wireGuardPeerUpdateSummary(previous, next)
	if added != 0 || removed != 0 || updated != 0 || len(removedKeys) != 0 {
		t.Fatalf("DNS refresh changed peer topology added=%d removed=%d updated=%d keys=%v", added, removed, updated, removedKeys)
	}
	config := wireGuardDeviceConfig(next, false, removedKeys)
	if strings.Contains(config, "remove=true") || strings.Contains(config, "replace_peers=true") {
		t.Fatal("DNS refresh resets an existing WireGuard peer")
	}
}

func setTestWireGuardRuntime(t *testing.T, tunnelID int, runtime *wireGuardRuntime) {
	t.Helper()
	wireGuardRuntimesMu.Lock()
	previous := wireGuardRuntimes[tunnelID]
	if runtime == nil {
		delete(wireGuardRuntimes, tunnelID)
	} else {
		wireGuardRuntimes[tunnelID] = runtime
	}
	wireGuardRuntimesMu.Unlock()
	t.Cleanup(func() {
		wireGuardRuntimesMu.Lock()
		if previous == nil {
			delete(wireGuardRuntimes, tunnelID)
		} else {
			wireGuardRuntimes[tunnelID] = previous
		}
		wireGuardRuntimesMu.Unlock()
	})
}

func TestV2EntryGroupWireGuardPreparationAndHandoffReferences(t *testing.T) {
	const tunnelID = 98501
	runtime := &wireGuardRuntime{
		spec: wireGuardSpec{TunnelID: tunnelID},
		peers: map[string]wireGuardPeerSpec{
			"exit-a": {ID: "exit-a", Address: "100.110.0.2"},
			"exit-b": {ID: "exit-b", Address: "100.110.0.3"},
		},
		outbound: map[string]*wireGuardOutboundProxy{},
		inbound:  map[string]*wireGuardInboundProxy{},
		refs:     map[string]int{},
	}
	setTestWireGuardRuntime(t, tunnelID, runtime)
	t.Cleanup(runtime.close)

	first := testV2EntrySpec(tunnelID, 3301, 45301, "exit-a")
	first.ExitPort = 25001
	first.UDPExitPort = 25002
	second := testV2EntrySpec(tunnelID, 3302, 45302, "exit-b")
	second.ExitPort = 26001
	second.UDPExitPort = 26002
	group, ok := buildSharedFXPEntryGroup([]fxpSpec{first, second}, tunnelID, forwardXWireGuardVersion)
	if !ok {
		t.Fatal("V2 entry group is invalid")
	}

	const firstRef = "v2-entry-group-test:first"
	prepared, err := prepareFXPWireGuard(group, firstRef)
	if err != nil {
		t.Fatal(err)
	}
	if len(prepared.Entries) != 2 {
		t.Fatalf("prepared V2 group entries=%d, want 2", len(prepared.Entries))
	}
	for _, entry := range prepared.Entries {
		if entry.ExitHost != "127.0.0.1" || entry.ExitPort <= 0 || entry.UDPExitPort != entry.ExitPort {
			t.Fatalf("rule %d has invalid local WireGuard endpoint: %#v", entry.RuleID, entry)
		}
	}
	if prepared.Entries[0].ExitPort == prepared.Entries[1].ExitPort {
		t.Fatalf("independent V2 exits share one local proxy port: %d", prepared.Entries[0].ExitPort)
	}

	runtime.mu.RLock()
	proxyCount := len(runtime.outbound)
	initialRefs := runtime.refs[firstRef]
	proxyKeys := make([]string, 0, len(runtime.refOutbound[firstRef]))
	for key := range runtime.refOutbound[firstRef] {
		proxyKeys = append(proxyKeys, key)
	}
	runtime.mu.RUnlock()
	if proxyCount != 2 {
		t.Fatalf("WireGuard outbound proxies=%d, want one per V2 exit", proxyCount)
	}
	if initialRefs != 1 {
		t.Fatalf("V2 group WireGuard references=%d, want one process reference", initialRefs)
	}

	// A replacement process acquires the same group identity before the old
	// process exits. Releasing the old process must not drop the new reference.
	const replacementRef = "v2-entry-group-test:replacement"
	runtime.addRef(replacementRef, proxyKeys...)
	releaseWireGuardRuntimeRef(tunnelID, firstRef)
	runtime.mu.RLock()
	handoffRefs := runtime.refs[replacementRef]
	handoffTimer := runtime.releaseTimer
	handoffProxyCount := len(runtime.outbound)
	runtime.mu.RUnlock()
	if handoffRefs != 1 || handoffTimer != nil || handoffProxyCount != 2 {
		t.Fatalf("old V2 process release refs=%d timer=%v proxies=%d, want one live reference, no timer, and two proxies", handoffRefs, handoffTimer != nil, handoffProxyCount)
	}

	releaseWireGuardRuntimeRef(tunnelID, replacementRef)
	runtime.mu.RLock()
	_, retained := runtime.refs[replacementRef]
	releaseScheduled := runtime.releaseTimer != nil
	remainingProxies := len(runtime.outbound)
	runtime.mu.RUnlock()
	if retained || !releaseScheduled || remainingProxies != 0 {
		t.Fatalf("final V2 process release retained=%v scheduled=%v proxies=%d", retained, releaseScheduled, remainingProxies)
	}

	const reacquiredRef = "v2-entry-group-test:reacquired"
	runtime.addRef(reacquiredRef)
	runtime.mu.RLock()
	reacquiredRefs := runtime.refs[reacquiredRef]
	releaseTimer := runtime.releaseTimer
	runtime.mu.RUnlock()
	if reacquiredRefs != 1 || releaseTimer != nil {
		t.Fatalf("V2 reference reacquire refs=%d timer=%v", reacquiredRefs, releaseTimer != nil)
	}
}

func TestV2EntryGroupWireGuardReplacementReclaimsRemovedEndpoint(t *testing.T) {
	const tunnelID = 98502
	runtime := &wireGuardRuntime{
		spec: wireGuardSpec{TunnelID: tunnelID},
		peers: map[string]wireGuardPeerSpec{
			"exit-a": {ID: "exit-a", Address: "100.111.0.2"},
			"exit-b": {ID: "exit-b", Address: "100.111.0.3"},
		},
		outbound: map[string]*wireGuardOutboundProxy{},
		inbound:  map[string]*wireGuardInboundProxy{},
		refs:     map[string]int{},
	}
	setTestWireGuardRuntime(t, tunnelID, runtime)
	t.Cleanup(runtime.close)

	removed := testV2EntrySpec(tunnelID, 3401, 45401, "exit-a")
	removed.ExitPort, removed.UDPExitPort = 27001, 27002
	retained := testV2EntrySpec(tunnelID, 3402, 45402, "exit-b")
	retained.ExitPort, retained.UDPExitPort = 28001, 28002
	oldGroup, ok := buildSharedFXPEntryGroup([]fxpSpec{removed, retained}, tunnelID, forwardXWireGuardVersion)
	if !ok {
		t.Fatal("old V2 entry group is invalid")
	}
	newGroup, ok := buildSharedFXPEntryGroup([]fxpSpec{retained}, tunnelID, forwardXWireGuardVersion)
	if !ok {
		t.Fatal("replacement V2 entry group is invalid")
	}

	if _, err := prepareFXPWireGuard(oldGroup, "replacement-test:old"); err != nil {
		t.Fatal(err)
	}
	if _, err := prepareFXPWireGuard(newGroup, "replacement-test:new"); err != nil {
		t.Fatal(err)
	}
	releaseWireGuardRuntimeRef(tunnelID, "replacement-test:old")

	removedKey := wireGuardOutboundProxyKey(removed.ExitPeerID, removed.ExitPort, removed.UDPExitPort)
	retainedKey := wireGuardOutboundProxyKey(retained.ExitPeerID, retained.ExitPort, retained.UDPExitPort)
	runtime.mu.RLock()
	_, removedExists := runtime.outbound[removedKey]
	_, retainedExists := runtime.outbound[retainedKey]
	proxyCount := len(runtime.outbound)
	runtime.mu.RUnlock()
	if removedExists || !retainedExists || proxyCount != 1 {
		t.Fatalf("replacement proxy reconciliation removed=%v retained=%v count=%d", removedExists, retainedExists, proxyCount)
	}

	releaseWireGuardRuntimeRef(tunnelID, "replacement-test:new")
	runtime.mu.RLock()
	proxyCount = len(runtime.outbound)
	runtime.mu.RUnlock()
	if proxyCount != 0 {
		t.Fatalf("final V2 reference retained %d outbound proxies", proxyCount)
	}
}

func TestV2EntryGroupWireGuardPreparationFailureReclaimsCreatedProxies(t *testing.T) {
	const tunnelID = 98503
	runtime := &wireGuardRuntime{
		spec: wireGuardSpec{TunnelID: tunnelID},
		peers: map[string]wireGuardPeerSpec{
			"valid-exit": {ID: "valid-exit", Address: "100.112.0.2"},
		},
		outbound: map[string]*wireGuardOutboundProxy{},
		inbound:  map[string]*wireGuardInboundProxy{},
		refs:     map[string]int{},
	}
	setTestWireGuardRuntime(t, tunnelID, runtime)
	t.Cleanup(runtime.close)

	valid := testV2EntrySpec(tunnelID, 3501, 45501, "valid-exit")
	invalid := testV2EntrySpec(tunnelID, 3502, 45502, "missing-exit")
	group, ok := buildSharedFXPEntryGroup([]fxpSpec{valid, invalid}, tunnelID, forwardXWireGuardVersion)
	if !ok {
		t.Fatal("V2 entry group is invalid")
	}
	if _, err := prepareFXPWireGuard(group, "failure-test"); err == nil {
		t.Fatal("V2 WireGuard preparation unexpectedly succeeded")
	}
	runtime.mu.RLock()
	proxyCount := len(runtime.outbound)
	refCount := len(runtime.refs)
	runtime.mu.RUnlock()
	if proxyCount != 0 || refCount != 0 {
		t.Fatalf("failed V2 preparation leaked proxies=%d refs=%d", proxyCount, refCount)
	}
}

func TestWireGuardProbeTreatsMissingRuntimeOrPeerAsNotReady(t *testing.T) {
	const tunnelID = 98001
	setTestWireGuardRuntime(t, tunnelID, nil)
	if _, status := wireGuardTCPLatencyDetailed(tunnelID, "peer", 443, 20*time.Millisecond); status != wireGuardProbeNotReady {
		t.Fatalf("missing runtime status=%v, want not-ready", status)
	}

	runtime := &wireGuardRuntime{peers: map[string]wireGuardPeerSpec{}}
	setTestWireGuardRuntime(t, tunnelID, runtime)
	if _, status := wireGuardTCPLatencyDetailed(tunnelID, "peer", 443, 20*time.Millisecond); status != wireGuardProbeNotReady {
		t.Fatalf("missing peer status=%v, want not-ready", status)
	}
}

func TestWireGuardProbeReportsTimeoutAfterPeerIsReady(t *testing.T) {
	const tunnelID = 98002
	runtime := &wireGuardRuntime{peers: map[string]wireGuardPeerSpec{
		"peer": {ID: "peer", Address: "100.64.0.2"},
	}}
	setTestWireGuardRuntime(t, tunnelID, runtime)
	dialCalls := 0
	_, status := wireGuardTCPLatencyWithDial(
		tunnelID,
		"peer",
		443,
		20*time.Millisecond,
		func(context.Context, *wireGuardRuntime, string, int) (net.Conn, error) {
			dialCalls++
			return nil, fmt.Errorf("expected dial failure")
		},
	)
	if status != wireGuardProbeTimeout {
		t.Fatalf("ready peer dial failure status=%v, want timeout", status)
	}
	if dialCalls == 0 {
		t.Fatal("ready peer was never dialed")
	}
}

func testWireGuardKeyPair(t *testing.T) (string, string) {
	t.Helper()
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		t.Fatal(err)
	}
	raw[0] &= 248
	raw[31] &= 127
	raw[31] |= 64
	privateKey, err := ecdh.X25519().NewPrivateKey(raw)
	if err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(raw), hex.EncodeToString(privateKey.PublicKey().Bytes())
}

func testUDPPort(t *testing.T) int {
	t.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	port := conn.LocalAddr().(*net.UDPAddr).Port
	_ = conn.Close()
	return port
}

func TestWireGuardUDPProxySessionOutgoingActivityPreventsExpiry(t *testing.T) {
	connection, peer := net.Pipe()
	defer peer.Close()
	session := newWireGuardUDPProxySession(connection)
	defer session.close()

	session.lastActivity.Store(time.Now().Add(-wireGuardUDPSessionIdleTimeout - time.Second).UnixNano())
	if !session.idleExpired(time.Now()) {
		t.Fatal("stale UDP proxy session should be expired")
	}
	if !session.enqueue([]byte("outgoing-activity")) {
		t.Fatal("active UDP proxy session rejected a packet")
	}
	if session.idleExpired(time.Now()) {
		t.Fatal("outgoing UDP traffic did not refresh session activity")
	}
	select {
	case packet := <-session.send:
		if string(packet.payload) != "outgoing-activity" {
			t.Fatalf("unexpected queued packet %q", packet.payload)
		}
	default:
		t.Fatal("outgoing UDP packet was not queued")
	}

	session.close()
	if session.enqueue([]byte("after-close")) {
		t.Fatal("closed UDP proxy session accepted a packet")
	}
}

func TestWireGuardUDPProxyQueueDropsExpiredPackets(t *testing.T) {
	connection, peer := net.Pipe()
	defer peer.Close()
	session := newWireGuardUDPProxySession(connection)
	defer session.close()

	session.send <- wireGuardUDPProxyPacket{
		payload:  []byte("stale"),
		queuedAt: time.Now().Add(-wireGuardUDPProxyMaxQueueDelay),
	}
	if !session.enqueue([]byte("fresh")) {
		t.Fatal("fresh packet was not queued")
	}
	go session.writeLoop()

	_ = peer.SetReadDeadline(time.Now().Add(time.Second))
	buf := make([]byte, 16)
	n, err := peer.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(buf[:n]); got != "fresh" {
		t.Fatalf("stale packet was written before fresh packet: %q", got)
	}
}

func TestWireGuardUDPProxyQueueKeepsLastExpiredPacket(t *testing.T) {
	packet := wireGuardUDPProxyPacket{
		payload:  []byte("last"),
		queuedAt: time.Now().Add(-wireGuardUDPProxyMaxQueueDelay),
	}
	if packet.superseded(time.Now(), 0) {
		t.Fatal("last queued UDP packet was discarded without a replacement")
	}
	if !packet.superseded(time.Now(), 1) {
		t.Fatal("stale UDP packet was retained ahead of a newer packet")
	}
}

func TestWireGuardUDPProxyQueueKeepsNewestPacketWhenFull(t *testing.T) {
	connection, peer := net.Pipe()
	defer peer.Close()
	session := &wireGuardUDPProxySession{
		conn: connection,
		send: make(chan wireGuardUDPProxyPacket, 2),
		done: make(chan struct{}),
	}
	defer session.close()

	if !session.enqueue([]byte("oldest")) || !session.enqueue([]byte("older")) {
		t.Fatal("failed to fill UDP proxy queue")
	}
	if session.enqueue([]byte("newest")) {
		t.Fatal("full queue did not report a displaced packet")
	}
	first := <-session.send
	second := <-session.send
	if string(first.payload) != "older" || string(second.payload) != "newest" {
		t.Fatalf("unexpected retained packets %q, %q", first.payload, second.payload)
	}
}

func TestWireGuardUDPProxySessionsWriteIndependently(t *testing.T) {
	blockedConnection, blockedPeer := net.Pipe()
	fastConnection, fastPeer := net.Pipe()
	defer blockedPeer.Close()
	defer fastPeer.Close()

	blocked := newWireGuardUDPProxySession(blockedConnection)
	fast := newWireGuardUDPProxySession(fastConnection)
	defer blocked.close()
	defer fast.close()
	go blocked.writeLoop()
	go fast.writeLoop()

	if !blocked.enqueue([]byte("blocked")) {
		t.Fatal("failed to queue blocked session packet")
	}
	if !fast.enqueue([]byte("fast")) {
		t.Fatal("failed to queue fast session packet")
	}
	_ = fastPeer.SetReadDeadline(time.Now().Add(time.Second))
	buf := make([]byte, 16)
	n, err := fastPeer.Read(buf)
	if err != nil {
		t.Fatalf("independent UDP session was blocked: %v", err)
	}
	if string(buf[:n]) != "fast" {
		t.Fatalf("unexpected independent session payload %q", buf[:n])
	}
}

func TestWaitForWireGuardProbePeerWaitsForExactPeer(t *testing.T) {
	const tunnelID = 99001
	setTestWireGuardRuntime(t, tunnelID, nil)
	runtime := &wireGuardRuntime{peers: map[string]wireGuardPeerSpec{}}
	updated := make(chan struct{})
	go func() {
		time.Sleep(40 * time.Millisecond)
		wireGuardRuntimesMu.Lock()
		wireGuardRuntimes[tunnelID] = runtime
		wireGuardRuntimesMu.Unlock()
		time.Sleep(40 * time.Millisecond)
		runtime.mu.Lock()
		runtime.peers["entry-b"] = wireGuardPeerSpec{ID: "entry-b", Address: "100.100.0.2"}
		runtime.mu.Unlock()
		close(updated)
	}()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	started := time.Now()
	got, err := waitForWireGuardProbePeer(ctx, tunnelID, "entry-b")
	if err != nil {
		t.Fatal(err)
	}
	<-updated
	if got != runtime {
		t.Fatal("probe returned a different WireGuard runtime")
	}
	if elapsed := time.Since(started); elapsed < 70*time.Millisecond {
		t.Fatalf("probe did not wait for the requested peer: %s", elapsed)
	}
}

func TestWaitForWireGuardProbePeerHonorsTimeout(t *testing.T) {
	const tunnelID = 99002
	setTestWireGuardRuntime(t, tunnelID, &wireGuardRuntime{peers: map[string]wireGuardPeerSpec{}})
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	started := time.Now()
	if _, err := waitForWireGuardProbePeer(ctx, tunnelID, "missing-entry"); err == nil {
		t.Fatal("missing WireGuard peer unexpectedly became ready")
	}
	if elapsed := time.Since(started); elapsed < 60*time.Millisecond || elapsed > 300*time.Millisecond {
		t.Fatalf("unexpected peer wait duration: %s", elapsed)
	}
}

func TestWireGuardRuntimeSupportsTwoIndependentEntries(t *testing.T) {
	entryAPrivate, entryAPublic := testWireGuardKeyPair(t)
	entryBPrivate, entryBPublic := testWireGuardKeyPair(t)
	exitPrivate, exitPublic := testWireGuardKeyPair(t)
	exitWirePort := testUDPPort(t)

	backend, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	servicePort := backend.Addr().(*net.TCPAddr).Port
	go func() {
		for {
			connection, err := backend.Accept()
			if err != nil {
				return
			}
			go func() {
				defer connection.Close()
				_, _ = io.Copy(connection, connection)
			}()
		}
	}()

	exit, err := newWireGuardRuntime(wireGuardSpec{
		TunnelID:   902,
		PrivateKey: exitPrivate,
		PublicKey:  exitPublic,
		Address:    "100.101.0.3",
		ListenPort: exitWirePort,
		MTU:        1380,
		Peers: []wireGuardPeerSpec{
			{ID: "1", HostID: 1, PublicKey: entryAPublic, Address: "100.101.0.1"},
			{ID: "2", HostID: 2, PublicKey: entryBPublic, Address: "100.101.0.2"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer exit.close()
	if err := exit.ensureInboundProxy(servicePort, servicePort); err != nil {
		t.Fatal(err)
	}

	newEntry := func(privateKey, publicKey, address string) *wireGuardRuntime {
		runtime, err := newWireGuardRuntime(wireGuardSpec{
			TunnelID:   902,
			PrivateKey: privateKey,
			PublicKey:  publicKey,
			Address:    address,
			MTU:        1380,
			Peers: []wireGuardPeerSpec{{
				ID: "3", HostID: 3, PublicKey: exitPublic, Address: "100.101.0.3",
				EndpointHost: "127.0.0.1", EndpointPort: exitWirePort, PersistentKeepalive: 25,
			}},
		})
		if err != nil {
			t.Fatal(err)
		}
		return runtime
	}
	entryA := newEntry(entryAPrivate, entryAPublic, "100.101.0.1")
	entryB := newEntry(entryBPrivate, entryBPublic, "100.101.0.2")
	defer entryA.close()
	defer entryB.close()

	results := make(chan error, 2)
	for label, runtime := range map[string]*wireGuardRuntime{"entry-a": entryA, "entry-b": entryB} {
		label, runtime := label, runtime
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			connection, err := runtime.dialPeerTCP(ctx, "3", servicePort)
			if err != nil {
				results <- fmt.Errorf("%s dial: %w", label, err)
				return
			}
			defer connection.Close()
			_ = connection.SetDeadline(time.Now().Add(10 * time.Second))
			payload := []byte(label)
			if _, err := connection.Write(payload); err != nil {
				results <- fmt.Errorf("%s write: %w", label, err)
				return
			}
			reply := make([]byte, len(payload))
			if _, err := io.ReadFull(connection, reply); err != nil {
				results <- fmt.Errorf("%s read: %w", label, err)
				return
			}
			if string(reply) != label {
				results <- fmt.Errorf("%s unexpected reply %q", label, reply)
				return
			}
			results <- nil
		}()
	}
	for range 2 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
}

func TestWireGuardRuntimeTCPAndUDPProxy(t *testing.T) {
	leftPrivate, leftPublic := testWireGuardKeyPair(t)
	rightPrivate, rightPublic := testWireGuardKeyPair(t)
	rightWirePort := testUDPPort(t)

	tcpBackend, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	servicePort := tcpBackend.Addr().(*net.TCPAddr).Port
	defer tcpBackend.Close()
	go func() {
		for {
			connection, err := tcpBackend.Accept()
			if err != nil {
				return
			}
			go func() {
				defer connection.Close()
				_, _ = io.Copy(connection, connection)
			}()
		}
	}()

	udpBackend, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: servicePort})
	if err != nil {
		t.Fatal(err)
	}
	defer udpBackend.Close()
	go func() {
		buf := make([]byte, 2048)
		for {
			n, addr, err := udpBackend.ReadFromUDP(buf)
			if err != nil {
				return
			}
			_, _ = udpBackend.WriteToUDP(buf[:n], addr)
		}
	}()

	right, err := newWireGuardRuntime(wireGuardSpec{
		TunnelID:   901,
		PrivateKey: rightPrivate,
		PublicKey:  rightPublic,
		Address:    "100.100.0.2",
		ListenPort: rightWirePort,
		MTU:        1380,
		Peers: []wireGuardPeerSpec{{
			ID: "1", HostID: 1, PublicKey: leftPublic, Address: "100.100.0.1",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer right.close()
	if err := right.ensureInboundProxy(servicePort, servicePort); err != nil {
		t.Fatal(err)
	}

	left, err := newWireGuardRuntime(wireGuardSpec{
		TunnelID:   901,
		PrivateKey: leftPrivate,
		PublicKey:  leftPublic,
		Address:    "100.100.0.1",
		MTU:        1380,
		Peers: []wireGuardPeerSpec{{
			ID: "2", HostID: 2, PublicKey: rightPublic, Address: "100.100.0.2",
			EndpointHost: "127.0.0.1", EndpointPort: rightWirePort, PersistentKeepalive: 25,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer left.close()
	setTestWireGuardRuntime(t, 901, left)
	if latency, reachable := wireGuardTCPLatency(901, "2", servicePort, 8*time.Second); !reachable || latency <= 0 {
		t.Fatalf("WireGuard TCP latency probe failed: reachable=%v latency=%d", reachable, latency)
	}

	const proxyRef = "wireguard-proxy-integration-test"
	left.addRef(proxyRef)
	defer releaseWireGuardRuntimeRef(901, proxyRef)
	_, localTCPPort, localUDPPort, err := left.ensureOutboundProxy(proxyRef, "2", servicePort, servicePort)
	if err != nil {
		t.Fatal(err)
	}

	tcpClient, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(localTCPPort)), 8*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer tcpClient.Close()
	_ = tcpClient.SetDeadline(time.Now().Add(8 * time.Second))
	if _, err := tcpClient.Write([]byte("wireguard-tcp")); err != nil {
		t.Fatal(err)
	}
	tcpReply := make([]byte, len("wireguard-tcp"))
	if _, err := io.ReadFull(tcpClient, tcpReply); err != nil {
		t.Fatal(err)
	}
	if string(tcpReply) != "wireguard-tcp" {
		t.Fatalf("unexpected tcp reply %q", tcpReply)
	}

	udpClient, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: localUDPPort})
	if err != nil {
		t.Fatal(err)
	}
	defer udpClient.Close()
	_ = udpClient.SetDeadline(time.Now().Add(8 * time.Second))
	if _, err := udpClient.Write([]byte("wireguard-udp")); err != nil {
		t.Fatal(err)
	}
	udpReply := make([]byte, 64)
	n, err := udpClient.Read(udpReply)
	if err != nil {
		t.Fatal(err)
	}
	if string(udpReply[:n]) != "wireguard-udp" {
		t.Fatalf("unexpected udp reply %q", udpReply[:n])
	}

	const burstPackets = 128
	_ = udpClient.SetDeadline(time.Now().Add(15 * time.Second))
	for i := 0; i < burstPackets; i++ {
		payload := []byte("burst-" + strconv.Itoa(i))
		if _, err := udpClient.Write(payload); err != nil {
			t.Fatalf("write UDP burst packet %d: %v", i, err)
		}
	}
	seen := make(map[string]bool, burstPackets)
	for i := 0; i < burstPackets; i++ {
		n, err := udpClient.Read(udpReply)
		if err != nil {
			t.Fatalf("read UDP burst packet %d: %v", i, err)
		}
		payload := string(udpReply[:n])
		if seen[payload] {
			t.Fatalf("duplicate UDP burst payload %q", payload)
		}
		seen[payload] = true
	}
	for i := 0; i < burstPackets; i++ {
		payload := "burst-" + strconv.Itoa(i)
		if !seen[payload] {
			t.Fatalf("missing UDP burst payload %q", payload)
		}
	}
}
