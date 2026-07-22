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
		if string(packet) != "outgoing-activity" {
			t.Fatalf("unexpected queued packet %q", packet)
		}
	default:
		t.Fatal("outgoing UDP packet was not queued")
	}

	session.close()
	if session.enqueue([]byte("after-close")) {
		t.Fatal("closed UDP proxy session accepted a packet")
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

	_, localTCPPort, localUDPPort, err := left.ensureOutboundProxy("2", servicePort, servicePort)
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
