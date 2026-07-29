package main

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	goruntime "runtime"
	"strconv"
	"strings"
	"sync"
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

func TestWireGuardDeviceUpdateConfigRebindsChangedListenPort(t *testing.T) {
	previous := wireGuardSpec{ListenPort: 51820}
	next := wireGuardSpec{ListenPort: 51821}
	config := wireGuardDeviceUpdateConfig(previous, next, nil)
	if !strings.HasPrefix(config, "listen_port=51821\n") {
		t.Fatalf("listen-port update config=%q", config)
	}
	if unchanged := wireGuardDeviceUpdateConfig(next, next, nil); strings.Contains(unchanged, "listen_port=") {
		t.Fatalf("unchanged listen port was unnecessarily rebound: %q", unchanged)
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

func TestWireGuardFXPProxiesReadyDetectsDependencyDrift(t *testing.T) {
	const tunnelID = 98509
	runtime := &wireGuardRuntime{
		spec: wireGuardSpec{TunnelID: tunnelID},
		peers: map[string]wireGuardPeerSpec{
			"exit-a": {ID: "exit-a", Address: "100.119.0.2"},
		},
		outbound: map[string]*wireGuardOutboundProxy{},
		inbound:  map[string]*wireGuardInboundProxy{},
		refs:     map[string]int{},
	}
	setTestWireGuardRuntime(t, tunnelID, runtime)
	t.Cleanup(runtime.close)

	entry := testV2EntrySpec(tunnelID, 3391, 45901, "exit-a")
	entry.ExitPort = 25901
	entry.UDPExitPort = 25902
	const entryRef = "dependency-drift-entry"
	if wireGuardFXPProxiesMatchConfig(entry, entry, entryRef) {
		t.Fatal("V2 entry was ready without its outbound proxy")
	}
	preparedEntry, err := prepareFXPWireGuard(entry, entryRef)
	if err != nil {
		t.Fatal(err)
	}
	if !wireGuardFXPProxiesMatchConfig(entry, preparedEntry, entryRef) {
		t.Fatal("V2 entry did not recognize its live outbound proxy and prepared port")
	}
	if wireGuardFXPProxiesMatchConfig(entry, preparedEntry, "unrelated-process") {
		t.Fatal("V2 entry accepted a proxy owned only by another process")
	}
	activeGroup, ok := buildSharedFXPEntryGroup([]fxpSpec{preparedEntry}, entry.TunnelID, entry.TransportVersion)
	if !ok || !wireGuardFXPProxiesMatchConfig(entry, activeGroup, entryRef) {
		t.Fatal("V2 entry member did not recognize its proxy in an active shared config")
	}
	wrongPreparedEntry := preparedEntry
	wrongPreparedEntry.ExitPort++
	wrongPreparedEntry.UDPExitPort++
	if wireGuardFXPProxiesMatchConfig(entry, wrongPreparedEntry, entryRef) {
		t.Fatal("V2 entry accepted a runtime config pointing at a stale local proxy port")
	}
	key := wireGuardOutboundProxyKey(entry.ExitPeerID, entry.ExitPort, entry.UDPExitPort)
	runtime.mu.RLock()
	entryProxy := runtime.outbound[key]
	runtime.mu.RUnlock()
	if err := entryProxy.tcpLn.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entryProxy.done:
	case <-time.After(time.Second):
		t.Fatal("outbound proxy loop exit did not mark the proxy closed")
	}
	if wireGuardFXPProxiesMatchConfig(entry, preparedEntry, entryRef) {
		t.Fatal("V2 entry accepted an outbound proxy whose serve loop exited")
	}
	_, rebuiltTCPPort, rebuiltUDPPort, err := runtime.ensureOutboundProxy(entryRef, entry.ExitPeerID, entry.ExitPort, entry.UDPExitPort)
	if err != nil {
		t.Fatalf("rebuild closed outbound proxy: %v", err)
	}
	preparedEntry.ExitPort = rebuiltTCPPort
	preparedEntry.UDPExitPort = rebuiltUDPPort
	if !wireGuardFXPProxiesMatchConfig(entry, preparedEntry, entryRef) {
		t.Fatal("V2 entry did not accept its rebuilt outbound proxy")
	}
	runtime.mu.Lock()
	delete(runtime.peers, entry.ExitPeerID)
	runtime.mu.Unlock()
	if wireGuardFXPProxiesMatchConfig(entry, preparedEntry, entryRef) {
		t.Fatal("V2 entry accepted an outbound proxy whose peer disappeared")
	}
	runtime.mu.Lock()
	runtime.peers[entry.ExitPeerID] = wireGuardPeerSpec{ID: entry.ExitPeerID, Address: "100.119.0.2"}
	runtime.mu.Unlock()

	exit := fxpSpec{
		Role:             "exit",
		TransportVersion: forwardXWireGuardVersion,
		TunnelID:         tunnelID,
		ListenPort:       26901,
		UDPListenPort:    26902,
	}
	activeExit := exit
	activeExit.ListenHost = "127.0.0.1"
	const exitRef = "dependency-drift-exit"
	if wireGuardFXPProxiesMatchConfig(exit, activeExit, exitRef) {
		t.Fatal("V2 exit was ready without its inbound proxy")
	}
	tcpLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	udpConn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		_ = tcpLn.Close()
		t.Fatal(err)
	}
	exit.ListenPort = tcpLn.Addr().(*net.TCPAddr).Port
	exit.UDPListenPort = udpConn.LocalAddr().(*net.UDPAddr).Port
	activeExit = exit
	activeExit.ListenHost = "127.0.0.1"
	inboundKey := fmt.Sprintf("%d:%d", exit.ListenPort, exit.UDPListenPort)
	inboundProxy := &wireGuardInboundProxy{
		key: inboundKey, tcpPort: exit.ListenPort, udpPort: exit.UDPListenPort,
		backendHost: "127.0.0.1", backendTCP: exit.ListenPort, backendUDP: exit.UDPListenPort,
		tcpLn: tcpLn, udpConn: udpConn, done: make(chan struct{}), sessions: map[string]*wireGuardUDPProxySession{},
	}
	runtime.mu.Lock()
	runtime.refs[exitRef] = 1
	runtime.inbound[inboundKey] = inboundProxy
	runtime.inboundRefs = map[string]int{inboundKey: 1}
	runtime.refInbound = map[string]map[string]struct{}{
		exitRef: {inboundKey: {}},
	}
	runtime.mu.Unlock()
	if !wireGuardFXPProxiesMatchConfig(exit, activeExit, exitRef) {
		t.Fatal("V2 exit did not recognize its inbound proxy")
	}
	if wireGuardFXPProxiesMatchConfig(exit, activeExit, "unrelated-process") {
		t.Fatal("V2 exit accepted an inbound proxy owned only by another process")
	}
	go runtime.serveInboundTCP(inboundProxy)
	if err := inboundProxy.tcpLn.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-inboundProxy.done:
	case <-time.After(time.Second):
		t.Fatal("inbound proxy loop exit did not mark the proxy closed")
	}
	if wireGuardFXPProxiesMatchConfig(exit, activeExit, exitRef) {
		t.Fatal("V2 exit accepted an inbound proxy whose serve loop exited")
	}

	setTestWireGuardRuntime(t, tunnelID, nil)
	if wireGuardFXPProxiesMatchConfig(entry, preparedEntry, entryRef) {
		t.Fatal("V2 entry was ready after its WireGuard runtime disappeared")
	}
	v1 := entry
	v1.TransportVersion = "v1"
	if !wireGuardFXPProxiesReady(v1) {
		t.Fatal("V1 FXP incorrectly depends on WireGuard proxies")
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

func newTestIsolatedWireGuardRuntime(t *testing.T, tunnelID int, address string) *wireGuardRuntime {
	t.Helper()
	privateKey, publicKey := testWireGuardKeyPair(t)
	runtime, err := newWireGuardRuntime(wireGuardSpec{
		TunnelID: tunnelID, PrivateKey: privateKey, PublicKey: publicKey,
		Address: address, MTU: 1380,
	})
	if err != nil {
		t.Fatal(err)
	}
	return runtime
}

func TestWireGuardClosedRuntimeRejectsNewReference(t *testing.T) {
	runtime := &wireGuardRuntime{
		closed: true,
		refs:   map[string]int{}, inbound: map[string]*wireGuardInboundProxy{},
	}
	if err := runtime.addRef("late-reference"); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("closed runtime addRef error=%v, want net.ErrClosed", err)
	}
	if err := runtime.ensureInboundProxy("late-reference", 30001, 30001); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("closed runtime inbound preparation error=%v, want net.ErrClosed", err)
	}
	if len(runtime.refs) != 0 || len(runtime.inbound) != 0 {
		t.Fatalf("closed runtime retained refs=%d inbound=%d", len(runtime.refs), len(runtime.inbound))
	}
}

func TestWireGuardInstanceReleaseDoesNotAffectReplacementRuntime(t *testing.T) {
	const tunnelID = 98508
	oldRuntime := &wireGuardRuntime{spec: wireGuardSpec{TunnelID: tunnelID}}
	if err := oldRuntime.addRef("old-process"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(oldRuntime.close)
	replacement := &wireGuardRuntime{
		spec: wireGuardSpec{TunnelID: tunnelID}, refs: map[string]int{},
	}
	setTestWireGuardRuntime(t, tunnelID, replacement)
	t.Cleanup(replacement.close)

	releaseWireGuardRuntimeInstanceRef(oldRuntime, tunnelID, "old-process")
	oldRuntime.mu.RLock()
	oldRefCount := len(oldRuntime.refs)
	oldRuntime.mu.RUnlock()
	replacement.mu.RLock()
	replacementTimer := replacement.releaseTimer
	replacementRefCount := len(replacement.refs)
	replacement.mu.RUnlock()
	if oldRefCount != 0 || replacementRefCount != 0 || replacementTimer != nil {
		t.Fatalf("instance release left oldRefs=%d or changed replacement refs=%d timer=%v", oldRefCount, replacementRefCount, replacementTimer != nil)
	}

	// A delayed process exit referring to the old instance must also be a no-op
	// against the replacement selected by tunnel ID.
	releaseWireGuardRuntimeRef(tunnelID, "old-process")
	replacement.mu.RLock()
	replacementTimer = replacement.releaseTimer
	replacement.mu.RUnlock()
	if replacementTimer != nil {
		t.Fatal("unknown old reference scheduled cleanup of the replacement runtime")
	}
}

func TestWireGuardIdentityReplacementFailureRestoresPreviousRuntime(t *testing.T) {
	usePersistentRuntimeTestDirs(t)
	const tunnelID = 98513
	privateKey, publicKey := testWireGuardKeyPair(t)
	oldSpec := wireGuardSpec{
		TunnelID: tunnelID, PrivateKey: privateKey, PublicKey: publicKey,
		Address: "100.122.0.1", ListenPort: 0, MTU: 1380,
	}
	oldRuntime, err := newWireGuardRuntime(oldSpec)
	if err != nil {
		t.Fatal(err)
	}
	setTestWireGuardRuntime(t, tunnelID, oldRuntime)
	t.Cleanup(func() {
		wireGuardRuntimesMu.RLock()
		current := wireGuardRuntimes[tunnelID]
		wireGuardRuntimesMu.RUnlock()
		if current != nil {
			current.close()
		}
	})

	occupied, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero, Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	replacementPrivateKey, replacementPublicKey := testWireGuardKeyPair(t)
	replacement := oldSpec
	replacement.PrivateKey = replacementPrivateKey
	replacement.PublicKey = replacementPublicKey
	replacement.ListenPort = occupied.LocalAddr().(*net.UDPAddr).Port
	if err := applyWireGuardRuntime(replacement); err == nil || !strings.Contains(err.Error(), "previous runtime restored") {
		t.Fatalf("replacement error=%v, want a restored previous runtime", err)
	}

	wireGuardRuntimesMu.RLock()
	restored := wireGuardRuntimes[tunnelID]
	wireGuardRuntimesMu.RUnlock()
	if restored == nil || restored == oldRuntime {
		t.Fatalf("restored runtime=%p old=%p", restored, oldRuntime)
	}
	if !wireGuardRuntimeReady(tunnelID, &oldSpec) {
		t.Fatal("previous WireGuard runtime was not healthy after replacement rollback")
	}
	if wireGuardRuntimeReady(tunnelID, &replacement) {
		t.Fatal("failed replacement was reported as the active WireGuard runtime")
	}
}

func newTestWireGuardRuntimeState(tunnelID int) *wireGuardRuntime {
	return &wireGuardRuntime{
		spec:         wireGuardSpec{TunnelID: tunnelID},
		peers:        map[string]wireGuardPeerSpec{},
		outbound:     map[string]*wireGuardOutboundProxy{},
		outboundRefs: map[string]int{},
		refOutbound:  map[string]map[string]struct{}{},
		inbound:      map[string]*wireGuardInboundProxy{},
		inboundRefs:  map[string]int{},
		refInbound:   map[string]map[string]struct{}{},
		refs:         map[string]int{},
	}
}

func armTestWireGuardReleaseTimer(runtime *wireGuardRuntime) uint64 {
	runtime.mu.Lock()
	runtime.releaseGeneration++
	generation := runtime.releaseGeneration
	runtime.releaseTimer = time.AfterFunc(time.Hour, func() {})
	runtime.mu.Unlock()
	return generation
}

func TestWireGuardStaleIdleReleaseDoesNotCloseReplacementRuntime(t *testing.T) {
	const tunnelID = 98510
	oldRuntime := newTestWireGuardRuntimeState(tunnelID)
	replacement := newTestWireGuardRuntimeState(tunnelID)
	setTestWireGuardRuntime(t, tunnelID, oldRuntime)
	t.Cleanup(oldRuntime.close)
	t.Cleanup(replacement.close)
	oldGeneration := armTestWireGuardReleaseTimer(oldRuntime)

	wireGuardRuntimesMu.Lock()
	wireGuardRuntimes[tunnelID] = replacement
	wireGuardRuntimesMu.Unlock()
	if stopWireGuardRuntimeInstanceIfUnused(tunnelID, oldRuntime, oldGeneration) {
		t.Fatal("stale idle callback closed an unrelated replacement runtime")
	}

	wireGuardRuntimesMu.RLock()
	current := wireGuardRuntimes[tunnelID]
	wireGuardRuntimesMu.RUnlock()
	replacement.mu.RLock()
	replacementClosed := replacement.closed
	replacement.mu.RUnlock()
	if current != replacement || replacementClosed {
		t.Fatalf("replacement runtime current=%v closed=%v", current == replacement, replacementClosed)
	}
}

func TestWireGuardReacquireInvalidatesRunningIdleRelease(t *testing.T) {
	const tunnelID = 98511
	runtime := newTestWireGuardRuntimeState(tunnelID)
	setTestWireGuardRuntime(t, tunnelID, runtime)
	t.Cleanup(runtime.close)
	staleGeneration := armTestWireGuardReleaseTimer(runtime)

	acquired, ok, err := tryAcquireWireGuardRuntimeRef(tunnelID, "reacquired-process")
	if err != nil || !ok || acquired != runtime {
		t.Fatalf("runtime reacquire acquired=%v current=%v err=%v", ok, acquired == runtime, err)
	}
	if stopWireGuardRuntimeInstanceIfUnused(tunnelID, runtime, staleGeneration) {
		t.Fatal("stale idle callback closed a reacquired runtime")
	}
	runtime.mu.RLock()
	refCount := runtime.refs["reacquired-process"]
	closed := runtime.closed
	runtime.mu.RUnlock()
	if refCount != 1 || closed {
		t.Fatalf("reacquired runtime refs=%d closed=%v", refCount, closed)
	}
}

func TestWireGuardAcquireAndIdleReleaseAreAtomic(t *testing.T) {
	const tunnelID = 98512
	wireGuardRuntimesMu.Lock()
	previous := wireGuardRuntimes[tunnelID]
	delete(wireGuardRuntimes, tunnelID)
	wireGuardRuntimesMu.Unlock()
	t.Cleanup(func() {
		wireGuardRuntimesMu.Lock()
		if previous != nil {
			wireGuardRuntimes[tunnelID] = previous
		} else {
			delete(wireGuardRuntimes, tunnelID)
		}
		wireGuardRuntimesMu.Unlock()
	})

	for iteration := 0; iteration < 256; iteration++ {
		runtime := newTestWireGuardRuntimeState(tunnelID)
		wireGuardRuntimesMu.Lock()
		wireGuardRuntimes[tunnelID] = runtime
		wireGuardRuntimesMu.Unlock()
		generation := armTestWireGuardReleaseTimer(runtime)

		start := make(chan struct{})
		var workers sync.WaitGroup
		var acquired bool
		var stopped bool
		var acquireErr error
		workers.Add(2)
		go func() {
			defer workers.Done()
			<-start
			_, acquired, acquireErr = tryAcquireWireGuardRuntimeRef(tunnelID, "concurrent-process")
		}()
		go func() {
			defer workers.Done()
			<-start
			stopped = stopWireGuardRuntimeInstanceIfUnused(tunnelID, runtime, generation)
		}()
		close(start)
		workers.Wait()
		if acquireErr != nil {
			t.Fatalf("iteration %d acquire failed: %v", iteration, acquireErr)
		}
		if acquired == stopped {
			t.Fatalf("iteration %d acquired=%v stopped=%v, want exactly one winner", iteration, acquired, stopped)
		}

		wireGuardRuntimesMu.RLock()
		current := wireGuardRuntimes[tunnelID]
		wireGuardRuntimesMu.RUnlock()
		runtime.mu.RLock()
		closed := runtime.closed
		refs := runtime.refs["concurrent-process"]
		runtime.mu.RUnlock()
		if acquired && (current != runtime || closed || refs != 1) {
			t.Fatalf("iteration %d acquired runtime current=%v closed=%v refs=%d", iteration, current == runtime, closed, refs)
		}
		if stopped && (current == runtime || !closed || refs != 0) {
			t.Fatalf("iteration %d stopped runtime current=%v closed=%v refs=%d", iteration, current == runtime, closed, refs)
		}

		wireGuardRuntimesMu.Lock()
		if wireGuardRuntimes[tunnelID] == runtime {
			delete(wireGuardRuntimes, tunnelID)
		}
		wireGuardRuntimesMu.Unlock()
		runtime.close()
	}
}

func TestV2WireGuardPreparationFailureReclaimsInboundProxy(t *testing.T) {
	const tunnelID = 98506
	runtime := newTestIsolatedWireGuardRuntime(t, tunnelID, "100.113.0.1")
	setTestWireGuardRuntime(t, tunnelID, runtime)
	t.Cleanup(runtime.close)

	servicePort := testUDPPort(t)
	spec := fxpSpec{
		TunnelID: tunnelID, TransportVersion: forwardXWireGuardVersion, Role: "relay",
		ListenPort: servicePort, UDPListenPort: servicePort,
		RelayPeerID: "missing-relay", RelayExitPort: 29001, UDPRelayExitPort: 29002,
	}
	if _, err := prepareFXPWireGuard(spec, "inbound-failure-test"); err == nil {
		t.Fatal("V2 relay preparation unexpectedly succeeded without its relay peer")
	}

	runtime.mu.RLock()
	inboundCount := len(runtime.inbound)
	inboundRefCount := len(runtime.inboundRefs)
	refInboundCount := len(runtime.refInbound)
	refCount := len(runtime.refs)
	runtime.mu.RUnlock()
	if inboundCount != 0 || inboundRefCount != 0 || refInboundCount != 0 || refCount != 0 {
		t.Fatalf("failed V2 relay preparation leaked inbound=%d inboundRefs=%d refInbound=%d refs=%d", inboundCount, inboundRefCount, refInboundCount, refCount)
	}

	// Binding the same virtual address again proves the failed preparation
	// closed both netstack listeners rather than only removing their map entry.
	const rebindRef = "inbound-failure-test:rebind"
	runtime.addRef(rebindRef)
	if err := runtime.ensureInboundProxy(rebindRef, servicePort, servicePort); err != nil {
		t.Fatalf("failed preparation retained its inbound listeners: %v", err)
	}
	releaseWireGuardRuntimeRef(tunnelID, rebindRef)
}

func newTestWireGuardInboundProxy(t *testing.T, key string) *wireGuardInboundProxy {
	t.Helper()
	tcpListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	udpConn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		_ = tcpListener.Close()
		t.Fatal(err)
	}
	return &wireGuardInboundProxy{
		key: key, tcpLn: tcpListener, udpConn: udpConn,
		done: make(chan struct{}), sessions: map[string]*wireGuardUDPProxySession{},
	}
}

func TestWireGuardInboundProxyReplacementReclaimsOldPort(t *testing.T) {
	const tunnelID = 98504
	oldProxy := newTestWireGuardInboundProxy(t, "old")
	newProxy := newTestWireGuardInboundProxy(t, "new")
	runtime := &wireGuardRuntime{
		spec:         wireGuardSpec{TunnelID: tunnelID},
		outbound:     map[string]*wireGuardOutboundProxy{},
		outboundRefs: map[string]int{},
		refOutbound:  map[string]map[string]struct{}{},
		inbound: map[string]*wireGuardInboundProxy{
			"old": oldProxy,
			"new": newProxy,
		},
		inboundRefs: map[string]int{"old": 1, "new": 1},
		refInbound: map[string]map[string]struct{}{
			"old-process": {"old": {}},
			"new-process": {"new": {}},
		},
		refs: map[string]int{"old-process": 1, "new-process": 1},
	}
	setTestWireGuardRuntime(t, tunnelID, runtime)
	t.Cleanup(runtime.close)

	releaseWireGuardRuntimeRef(tunnelID, "old-process")
	runtime.mu.RLock()
	_, oldRetained := runtime.inbound["old"]
	_, newRetained := runtime.inbound["new"]
	runtime.mu.RUnlock()
	if oldRetained || !newRetained {
		t.Fatalf("inbound replacement retained old=%v new=%v", oldRetained, newRetained)
	}
	select {
	case <-oldProxy.done:
	default:
		t.Fatal("removed inbound proxy was not closed")
	}
	select {
	case <-newProxy.done:
		t.Fatal("replacement inbound proxy was closed with old process")
	default:
	}
}

func TestWireGuardInboundProxyHandoffRetainsSharedPort(t *testing.T) {
	const tunnelID = 98505
	proxy := newTestWireGuardInboundProxy(t, "shared")
	runtime := &wireGuardRuntime{
		spec:         wireGuardSpec{TunnelID: tunnelID},
		outbound:     map[string]*wireGuardOutboundProxy{},
		outboundRefs: map[string]int{},
		refOutbound:  map[string]map[string]struct{}{},
		inbound:      map[string]*wireGuardInboundProxy{"shared": proxy},
		inboundRefs:  map[string]int{"shared": 2},
		refInbound: map[string]map[string]struct{}{
			"old-process": {"shared": {}},
			"new-process": {"shared": {}},
		},
		refs: map[string]int{"old-process": 1, "new-process": 1},
	}
	setTestWireGuardRuntime(t, tunnelID, runtime)
	t.Cleanup(runtime.close)

	releaseWireGuardRuntimeRef(tunnelID, "old-process")
	runtime.mu.RLock()
	remainingRefs := runtime.inboundRefs["shared"]
	_, retained := runtime.inbound["shared"]
	runtime.mu.RUnlock()
	if !retained || remainingRefs != 1 {
		t.Fatalf("shared inbound handoff retained=%v refs=%d", retained, remainingRefs)
	}
	select {
	case <-proxy.done:
		t.Fatal("shared inbound proxy closed before replacement release")
	default:
	}

	releaseWireGuardRuntimeRef(tunnelID, "new-process")
	select {
	case <-proxy.done:
	default:
		t.Fatal("shared inbound proxy remained open after final release")
	}
}

func TestWireGuardInboundProxyRepeatedReplacementReclaimsResources(t *testing.T) {
	baselineGoroutines := goruntime.NumGoroutine()
	const tunnelID = 98507
	runtime := newTestIsolatedWireGuardRuntime(t, tunnelID, "100.114.0.1")
	setTestWireGuardRuntime(t, tunnelID, runtime)
	t.Cleanup(runtime.close)

	servicePort := testUDPPort(t)
	const replacements = 24
	for replacement := 0; replacement < replacements; replacement++ {
		refID := fmt.Sprintf("inbound-replacement:%d", replacement)
		runtime.addRef(refID)
		if err := runtime.ensureInboundProxy(refID, servicePort, servicePort); err != nil {
			t.Fatalf("replacement %d could not reuse inbound port: %v", replacement, err)
		}

		key := fmt.Sprintf("%d:%d", servicePort, servicePort)
		runtime.mu.RLock()
		proxy := runtime.inbound[key]
		runtime.mu.RUnlock()
		if proxy == nil {
			t.Fatalf("replacement %d did not register its inbound proxy", replacement)
		}

		releaseWireGuardRuntimeRef(tunnelID, refID)
		select {
		case <-proxy.done:
		default:
			t.Fatalf("replacement %d did not close its inbound proxy", replacement)
		}
		runtime.mu.RLock()
		inboundCount := len(runtime.inbound)
		inboundRefCount := len(runtime.inboundRefs)
		refInboundCount := len(runtime.refInbound)
		refCount := len(runtime.refs)
		runtime.mu.RUnlock()
		if inboundCount != 0 || inboundRefCount != 0 || refInboundCount != 0 || refCount != 0 {
			t.Fatalf("replacement %d leaked inbound=%d inboundRefs=%d refInbound=%d refs=%d", replacement, inboundCount, inboundRefCount, refInboundCount, refCount)
		}
	}

	runtime.close()
	deadline := time.Now().Add(3 * time.Second)
	for goruntime.NumGoroutine() > baselineGoroutines+8 && time.Now().Before(deadline) {
		goruntime.Gosched()
		time.Sleep(10 * time.Millisecond)
	}
	if remaining := goruntime.NumGoroutine(); remaining > baselineGoroutines+8 {
		t.Fatalf("WireGuard replacements did not converge goroutines: baseline=%d remaining=%d", baselineGoroutines, remaining)
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

func TestWireGuardUDPProxyQueueEnforcesByteBudget(t *testing.T) {
	connection, peer := net.Pipe()
	defer peer.Close()
	session := newWireGuardUDPProxySession(connection)
	defer session.close()

	const packetBytes = 60 * 1024
	packetsWithinBudget := wireGuardUDPProxyQueueBytes / packetBytes
	for index := 0; index < packetsWithinBudget; index++ {
		payload := make([]byte, packetBytes)
		payload[0] = byte(index)
		if !session.enqueue(payload) {
			t.Fatalf("packet %d unexpectedly exceeded the byte budget", index)
		}
	}
	newest := make([]byte, packetBytes)
	newest[0] = byte(packetsWithinBudget)
	if session.enqueue(newest) {
		t.Fatal("byte-budget eviction did not report a displaced packet")
	}
	if session.queuedBytes > wireGuardUDPProxyQueueBytes {
		t.Fatalf("queued bytes=%d exceeds budget=%d", session.queuedBytes, wireGuardUDPProxyQueueBytes)
	}
	if len(session.send) != packetsWithinBudget {
		t.Fatalf("queue retained %d packets, want %d after byte-budget eviction", len(session.send), packetsWithinBudget)
	}
	first := <-session.send
	session.markDequeued(first)
	if first.payload[0] != 1 {
		t.Fatalf("byte-budget eviction retained oldest packet marker=%d", first.payload[0])
	}
	for len(session.send) > 0 {
		packet := <-session.send
		session.markDequeued(packet)
		newest = packet.payload
	}
	if newest[0] != byte(packetsWithinBudget) {
		t.Fatalf("byte-budget eviction lost newest packet marker=%d", newest[0])
	}
	if session.queuedBytes != 0 {
		t.Fatalf("drained queue retained %d accounted bytes", session.queuedBytes)
	}
}

func TestWireGuardUDPProxySessionCloseReleasesQueuedPayloads(t *testing.T) {
	connection, peer := net.Pipe()
	defer peer.Close()
	session := newWireGuardUDPProxySession(connection)
	for index := 0; index < 4; index++ {
		if !session.enqueue(make([]byte, 32*1024)) {
			t.Fatalf("packet %d unexpectedly congested the queue", index)
		}
	}
	session.close()
	if got := len(session.send); got != 0 {
		t.Fatalf("closed session retained %d queued packets", got)
	}
	if session.queuedBytes != 0 {
		t.Fatalf("closed session retained %d queued bytes", session.queuedBytes)
	}
}

func TestWireGuardUDPProxySessionLimitEvictsLeastRecentlyActive(t *testing.T) {
	sessions := make(map[string]*wireGuardUDPProxySession, wireGuardUDPProxyMaxSessions)
	for index := 0; index < wireGuardUDPProxyMaxSessions; index++ {
		session := &wireGuardUDPProxySession{}
		session.lastActivity.Store(int64(index + 1))
		sessions[strconv.Itoa(index)] = session
	}

	evicted := evictOldestWireGuardUDPProxySession(sessions, wireGuardUDPProxyMaxSessions)
	if evicted == nil || evicted.lastActivity.Load() != 1 {
		t.Fatalf("session limit evicted activity=%v, want oldest activity=1", func() any {
			if evicted == nil {
				return nil
			}
			return evicted.lastActivity.Load()
		}())
	}
	if _, retained := sessions["0"]; retained {
		t.Fatal("least recently active session remained in the map")
	}
	sessions["new"] = &wireGuardUDPProxySession{}
	if len(sessions) != wireGuardUDPProxyMaxSessions {
		t.Fatalf("session map size=%d, want hard limit=%d", len(sessions), wireGuardUDPProxyMaxSessions)
	}
	if evicted := evictOldestWireGuardUDPProxySession(sessions, wireGuardUDPProxyMaxSessions+1); evicted != nil {
		t.Fatal("session was evicted below the configured limit")
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
	const exitInboundRef = "two-entry-exit"
	exit.addRef(exitInboundRef)
	if err := exit.ensureInboundProxy(exitInboundRef, servicePort, servicePort); err != nil {
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
	const oldRightInboundRef = "tcp-udp-proxy-exit:old"
	if err := right.addRef(oldRightInboundRef); err != nil {
		t.Fatal(err)
	}
	if err := right.ensureInboundProxy(oldRightInboundRef, servicePort, servicePort); err != nil {
		t.Fatal(err)
	}
	const replacementRightInboundRef = "tcp-udp-proxy-exit:replacement"
	if err := right.addRef(replacementRightInboundRef); err != nil {
		t.Fatal(err)
	}
	if err := right.ensureInboundProxy(replacementRightInboundRef, servicePort, servicePort); err != nil {
		t.Fatal(err)
	}
	defer releaseWireGuardRuntimeInstanceRef(right, 901, replacementRightInboundRef)
	releaseWireGuardRuntimeInstanceRef(right, 901, oldRightInboundRef)

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

	const oldProxyRef = "wireguard-proxy-integration-test:old"
	if err := left.addRef(oldProxyRef); err != nil {
		t.Fatal(err)
	}
	_, localTCPPort, localUDPPort, err := left.ensureOutboundProxy(oldProxyRef, "2", servicePort, servicePort)
	if err != nil {
		t.Fatal(err)
	}

	// Model an FXP replacement: the new process acquires the existing local
	// proxy before the old process exits. Traffic through the returned endpoint
	// must remain usable after the old process releases its reference.
	const replacementProxyRef = "wireguard-proxy-integration-test:replacement"
	if err := left.addRef(replacementProxyRef); err != nil {
		t.Fatal(err)
	}
	_, replacementTCPPort, replacementUDPPort, err := left.ensureOutboundProxy(replacementProxyRef, "2", servicePort, servicePort)
	if err != nil {
		t.Fatal(err)
	}
	defer releaseWireGuardRuntimeRef(901, replacementProxyRef)
	if replacementTCPPort != localTCPPort || replacementUDPPort != localUDPPort {
		t.Fatalf("replacement allocated a different proxy endpoint tcp=%d/%d udp=%d/%d", localTCPPort, replacementTCPPort, localUDPPort, replacementUDPPort)
	}
	releaseWireGuardRuntimeRef(901, oldProxyRef)

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

	// Stay below the real-time proxy queue limit. Queue saturation and dropping
	// stale datagrams is covered separately and is intentional backpressure.
	const burstPackets = wireGuardUDPProxyQueueSize / 2
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
