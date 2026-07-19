package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strconv"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func TestFallbackDialTimeoutIsShorterThanNormalDial(t *testing.T) {
	fallback := config{ExitStrategy: "fallback"}
	normal := config{ExitStrategy: "round_robin"}

	if timeout := secureDialTimeout(fallback); timeout != 3*time.Second {
		t.Fatalf("unexpected fallback dial timeout %s", timeout)
	}
	if timeout := secureDialTimeout(normal); timeout != 10*time.Second {
		t.Fatalf("unexpected normal dial timeout %s", timeout)
	}
}

func TestFallbackSelectorUsesPriorityAndRetriesPrimaryAfterCooldown(t *testing.T) {
	selector := newExitEndpointSelector([]exitEndpoint{
		{Host: "127.0.0.2", Port: 10002},
	}, exitEndpoint{Host: "127.0.0.1", Port: 10001}, "fallback")

	first, firstIndex, ok := selector.pick(nil)
	if !ok || firstIndex != 0 || first.Port != 10001 {
		t.Fatalf("expected primary first, index=%d endpoint=%+v ok=%v", firstIndex, first, ok)
	}
	selector.markFailure(firstIndex, errors.New("test failure"))
	backup, backupIndex, ok := selector.pick(nil)
	if !ok || backupIndex != 1 || backup.Port != 10002 {
		t.Fatalf("expected backup during cooldown, index=%d endpoint=%+v ok=%v", backupIndex, backup, ok)
	}

	selector.mu.Lock()
	selector.retryAfter[0] = time.Now().Add(-time.Millisecond)
	selector.mu.Unlock()
	retried, retriedIndex, ok := selector.pick(nil)
	if !ok || retriedIndex != 0 || retried.Port != 10001 {
		t.Fatalf("expected primary retry after cooldown, index=%d endpoint=%+v ok=%v", retriedIndex, retried, ok)
	}
}

func TestExitSelectorStrategies(t *testing.T) {
	endpoints := []exitEndpoint{
		{Host: "127.0.0.2", Port: 10002},
		{Host: "127.0.0.3", Port: 10003},
	}
	ipHash := newExitEndpointSelector(endpoints, exitEndpoint{Host: "127.0.0.1", Port: 10001}, "ip_hash")
	first, firstIndex, ok := ipHash.pick(nil, "203.0.113.9")
	if !ok {
		t.Fatal("expected ip hash endpoint")
	}
	for i := 0; i < 10; i++ {
		next, nextIndex, nextOK := ipHash.pick(nil, "203.0.113.9")
		if !nextOK || nextIndex != firstIndex || next != first {
			t.Fatalf("ip hash selection changed: first=%+v/%d next=%+v/%d", first, firstIndex, next, nextIndex)
		}
	}

	roundRobin := newExitEndpointSelector(endpoints, exitEndpoint{Host: "127.0.0.1", Port: 10001}, "round_robin")
	seen := map[int]bool{}
	for i := 0; i < 3; i++ {
		_, index, selected := roundRobin.pick(nil)
		if !selected {
			t.Fatal("expected round robin endpoint")
		}
		seen[index] = true
	}
	if len(seen) != 3 {
		t.Fatalf("round robin did not visit every endpoint: %v", seen)
	}

	if got := normalizeExitStrategy("random"); got != "random" {
		t.Fatalf("random strategy normalized to %q", got)
	}
	if got := normalizeExitStrategy("none"); got != "round_robin" {
		t.Fatalf("none strategy should use the single-endpoint default, got %q", got)
	}
}

func TestForwardXFallbackUsesBackupForTCPAndUDP(t *testing.T) {
	targetPort := freeTCPUDPPort(t)
	targetTCP, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(targetPort)))
	if err != nil {
		t.Fatal(err)
	}
	defer targetTCP.Close()
	targetUDP, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: targetPort})
	if err != nil {
		t.Fatal(err)
	}
	defer targetUDP.Close()
	go func() {
		for {
			conn, acceptErr := targetTCP.Accept()
			if acceptErr != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()
	go func() {
		buf := make([]byte, 65535)
		for {
			n, addr, readErr := targetUDP.ReadFromUDP(buf)
			if readErr != nil {
				return
			}
			_, _ = targetUDP.WriteToUDP(buf[:n], addr)
		}
	}()

	key := "fallback-both-key"
	unavailablePort := freeTCPUDPPort(t)
	backupPort := freeTCPUDPPort(t)
	entryPort := freeTCPUDPPort(t)
	exitDone := make(chan struct{})
	entryDone := make(chan struct{})
	defer close(exitDone)
	defer close(entryDone)
	go func() {
		_ = runExit(exitDone, config{
			Role:       "exit",
			TunnelID:   71,
			ListenPort: backupPort,
			Protocol:   "both",
			Key:        key,
			UDPTargets: []udpTarget{{RuleID: 72, TargetIP: "127.0.0.1", TargetPort: targetPort}},
		})
	}()
	waitForTCP(t, backupPort)
	go func() {
		_ = runEntry(entryDone, config{
			Role:         "entry",
			TunnelID:     71,
			RuleID:       72,
			ListenPort:   entryPort,
			Protocol:     "both",
			ExitHost:     "127.0.0.1",
			ExitPort:     unavailablePort,
			ExitStrategy: "fallback",
			Exits:        []exitEndpoint{{Host: "127.0.0.1", Port: backupPort, Key: key}},
			TargetIP:     "127.0.0.1",
			TargetPort:   targetPort,
			Key:          key,
		})
	}()
	waitForTCP(t, entryPort)

	tcpClient, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort)), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer tcpClient.Close()
	if _, err := tcpClient.Write([]byte("fallback-tcp")); err != nil {
		t.Fatal(err)
	}
	tcpReply := make([]byte, len("fallback-tcp"))
	if _, err := io.ReadFull(tcpClient, tcpReply); err != nil {
		t.Fatal(err)
	}
	if string(tcpReply) != "fallback-tcp" {
		t.Fatalf("unexpected tcp reply %q", tcpReply)
	}

	udpClient, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: entryPort})
	if err != nil {
		t.Fatal(err)
	}
	defer udpClient.Close()
	if reply := udpRoundTrip(t, udpClient, []byte("fallback-udp")); string(reply) != "fallback-udp" {
		t.Fatalf("unexpected udp reply %q", reply)
	}
}

func TestForwardXTCPRoundTrip(t *testing.T) {
	targetLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer targetLn.Close()
	go func() {
		for {
			conn, err := targetLn.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()

	key := "test-key"
	targetPort := targetLn.Addr().(*net.TCPAddr).Port
	exitPort := freeTCPPort(t)
	entryPort := freeTCPPort(t)
	exitDone := make(chan struct{})
	entryDone := make(chan struct{})
	defer close(exitDone)
	defer close(entryDone)

	go func() {
		_ = runExit(exitDone, config{
			Role:       "exit",
			TunnelID:   1,
			ListenPort: exitPort,
			Protocol:   "tcp",
			Key:        key,
		})
	}()
	waitForTCP(t, exitPort)

	go func() {
		_ = runEntry(entryDone, config{
			Role:       "entry",
			TunnelID:   1,
			RuleID:     2,
			ListenPort: entryPort,
			Protocol:   "tcp",
			ExitHost:   "127.0.0.1",
			ExitPort:   exitPort,
			TargetIP:   "127.0.0.1",
			TargetPort: targetPort,
			Key:        key,
		})
	}()
	waitForTCP(t, entryPort)

	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort)), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("forwardx")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, len("forwardx"))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != "forwardx" {
		t.Fatalf("unexpected echo %q", string(buf))
	}
}

func TestForwardXUDPDirectRoundTrip(t *testing.T) {
	target, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	go func() {
		buf := make([]byte, 65535)
		for {
			n, addr, err := target.ReadFromUDP(buf)
			if err != nil {
				return
			}
			_, _ = target.WriteToUDP(buf[:n], addr)
		}
	}()

	key := "udp-direct-key"
	targetPort := target.LocalAddr().(*net.UDPAddr).Port
	exitPort := freeUDPPort(t)
	entryPort := freeUDPPort(t)
	exitDone := make(chan struct{})
	entryDone := make(chan struct{})
	defer close(exitDone)
	defer close(entryDone)

	go func() {
		_ = runExit(exitDone, config{
			Role:       "exit",
			TunnelID:   21,
			ListenPort: exitPort,
			Protocol:   "udp",
			Key:        key,
			UDPTargets: []udpTarget{{RuleID: 22, TargetIP: "127.0.0.1", TargetPort: targetPort}},
		})
	}()
	go func() {
		_ = runEntry(entryDone, config{
			Role:       "entry",
			TunnelID:   21,
			RuleID:     22,
			ListenPort: entryPort,
			Protocol:   "udp",
			ExitHost:   "127.0.0.1",
			ExitPort:   exitPort,
			TargetIP:   "127.0.0.1",
			TargetPort: targetPort,
			Key:        key,
		})
	}()
	client, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: entryPort})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if reply := udpRoundTrip(t, client, []byte("udp-forwardx")); string(reply) != "udp-forwardx" {
		t.Fatalf("unexpected udp echo %q", string(reply))
	}
	largePayload := make([]byte, 32*1024+137)
	for i := range largePayload {
		largePayload[i] = byte(i % 251)
	}
	if reply := udpRoundTrip(t, client, largePayload); !bytes.Equal(reply, largePayload) {
		t.Fatalf("large udp echo mismatch: got=%d want=%d", len(reply), len(largePayload))
	}
}

func TestForwardXBothSplitUDPWirePorts(t *testing.T) {
	targetPort := freeTCPUDPPort(t)
	targetLn, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(targetPort)))
	if err != nil {
		t.Fatal(err)
	}
	defer targetLn.Close()
	targetUDP, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: targetPort})
	if err != nil {
		t.Fatal(err)
	}
	defer targetUDP.Close()
	go func() {
		for {
			conn, err := targetLn.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()
	go func() {
		buf := make([]byte, 65535)
		for {
			n, addr, err := targetUDP.ReadFromUDP(buf)
			if err != nil {
				return
			}
			_, _ = targetUDP.WriteToUDP(buf[:n], addr)
		}
	}()

	key := "both-split-udp-key"
	exitTCPPort := freeTCPUDPPort(t)
	exitUDPPort := freeTCPUDPPort(t)
	for exitUDPPort == exitTCPPort {
		exitUDPPort = freeTCPUDPPort(t)
	}
	entryPort := freeTCPUDPPort(t)
	exitDone := make(chan struct{})
	entryDone := make(chan struct{})
	defer close(exitDone)
	defer close(entryDone)

	go func() {
		_ = runExit(exitDone, config{
			Role:          "exit",
			TunnelID:      31,
			ListenPort:    exitTCPPort,
			UDPListenPort: exitUDPPort,
			Protocol:      "both",
			Key:           key,
			UDPTargets:    []udpTarget{{RuleID: 32, TargetIP: "127.0.0.1", TargetPort: targetPort}},
		})
	}()
	waitForTCP(t, exitTCPPort)

	go func() {
		_ = runEntry(entryDone, config{
			Role:        "entry",
			TunnelID:    31,
			RuleID:      32,
			ListenPort:  entryPort,
			Protocol:    "both",
			ExitHost:    "127.0.0.1",
			ExitPort:    exitTCPPort,
			UDPExitPort: exitUDPPort,
			TargetIP:    "127.0.0.1",
			TargetPort:  targetPort,
			Key:         key,
		})
	}()
	waitForTCP(t, entryPort)

	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort)), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("split-tcp")); err != nil {
		t.Fatal(err)
	}
	tcpBuf := make([]byte, len("split-tcp"))
	if _, err := io.ReadFull(conn, tcpBuf); err != nil {
		t.Fatal(err)
	}
	if string(tcpBuf) != "split-tcp" {
		t.Fatalf("unexpected tcp echo %q", string(tcpBuf))
	}

	client, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: entryPort})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if _, err := client.Write([]byte("split-udp")); err != nil {
		t.Fatal(err)
	}
	_ = client.SetReadDeadline(time.Now().Add(3 * time.Second))
	udpBuf := make([]byte, 64)
	n, err := client.Read(udpBuf)
	if err != nil {
		t.Fatal(err)
	}
	if string(udpBuf[:n]) != "split-udp" {
		t.Fatalf("unexpected udp echo %q", string(udpBuf[:n]))
	}
}

func TestForwardXRelayUDPDirectRoundTrip(t *testing.T) {
	target, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	go func() {
		buf := make([]byte, 65535)
		for {
			n, addr, err := target.ReadFromUDP(buf)
			if err != nil {
				return
			}
			_, _ = target.WriteToUDP(buf[:n], addr)
		}
	}()

	upstreamKey := "udp-entry-to-relay-key"
	downstreamKey := "udp-relay-to-exit-key"
	targetPort := target.LocalAddr().(*net.UDPAddr).Port
	exitPort := freeUDPPort(t)
	relayPort := freeUDPPort(t)
	entryPort := freeUDPPort(t)
	exitDone := make(chan struct{})
	relayDone := make(chan struct{})
	entryDone := make(chan struct{})
	defer close(exitDone)
	defer close(relayDone)
	defer close(entryDone)

	go func() {
		_ = runExit(exitDone, config{
			Role:       "exit",
			TunnelID:   23,
			ListenPort: exitPort,
			Protocol:   "udp",
			Key:        downstreamKey,
			UDPTargets: []udpTarget{{RuleID: 24, TargetIP: "127.0.0.1", TargetPort: targetPort}},
		})
	}()
	go func() {
		_ = runRelay(relayDone, config{
			Role:          "relay",
			TunnelID:      23,
			ListenPort:    relayPort,
			Protocol:      "udp",
			Key:           upstreamKey,
			RelayExitHost: "127.0.0.1",
			RelayExitPort: exitPort,
			RelayKey:      downstreamKey,
		})
	}()
	go func() {
		_ = runEntry(entryDone, config{
			Role:       "entry",
			TunnelID:   23,
			RuleID:     24,
			ListenPort: entryPort,
			Protocol:   "udp",
			ExitHost:   "127.0.0.1",
			ExitPort:   relayPort,
			TargetIP:   "127.0.0.1",
			TargetPort: targetPort,
			Key:        upstreamKey,
		})
	}()
	client, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: entryPort})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if reply := udpRoundTrip(t, client, []byte("udp-relay-forwardx")); string(reply) != "udp-relay-forwardx" {
		t.Fatalf("unexpected udp relay echo %q", string(reply))
	}
	largePayload := make([]byte, 24*1024+73)
	for i := range largePayload {
		largePayload[i] = byte((i * 7) % 251)
	}
	if reply := udpRoundTrip(t, client, largePayload); !bytes.Equal(reply, largePayload) {
		t.Fatalf("large relay udp echo mismatch: got=%d want=%d", len(reply), len(largePayload))
	}
}

func TestFXPUDPv3EncryptsAuthenticatesAndRejectsReplay(t *testing.T) {
	packet := fxpUDPPacket{
		packetType: fxpUDPTypeData,
		tunnelID:   41,
		ruleID:     42,
		sessionID:  43,
		sequence:   44,
		payload:    []byte("private-udp-payload"),
	}
	raw, err := sealFXPUDPPacket(packet, "udp-v3-test-key")
	if err != nil {
		t.Fatal(err)
	}
	if raw[4] != fxpUDPVersion {
		t.Fatalf("unexpected UDP wire version %d", raw[4])
	}
	if bytes.Contains(raw, packet.payload) {
		t.Fatal("UDP v3 payload was sent in plaintext")
	}
	opened, err := openFXPUDPPacket(raw, "udp-v3-test-key")
	if err != nil {
		t.Fatal(err)
	}
	if opened.sequence != packet.sequence || !bytes.Equal(opened.payload, packet.payload) {
		t.Fatalf("unexpected opened packet: %+v", opened)
	}

	tampered := append([]byte(nil), raw...)
	tampered[len(tampered)-1] ^= 0x01
	if _, err := openFXPUDPPacket(tampered, "udp-v3-test-key"); err == nil {
		t.Fatal("expected tampered payload to be rejected")
	}
	tamperedHeader := append([]byte(nil), raw...)
	tamperedHeader[12] ^= 0x01
	if _, err := openFXPUDPPacket(tamperedHeader, "udp-v3-test-key"); err == nil {
		t.Fatal("expected tampered header to be rejected")
	}
	if _, err := openFXPUDPPacket(raw, "wrong-key"); err == nil {
		t.Fatal("expected wrong key to be rejected")
	}

	var replay udpReplayWindow
	if !replay.accept(100) || replay.accept(100) {
		t.Fatal("replay window did not reject a duplicate sequence")
	}
	if !replay.accept(102) || !replay.accept(101) || replay.accept(101) {
		t.Fatal("replay window did not preserve bounded packet reordering")
	}
	if replay.accept(1) {
		t.Fatal("replay window accepted an expired sequence")
	}
}

func TestFXPUDPFragmentsStayWithinSafeWireSizeAndReassembleOutOfOrder(t *testing.T) {
	payload := make([]byte, fxpUDPMaxDatagramPayload)
	for i := range payload {
		payload[i] = byte((i * 13) % 251)
	}
	var sequence atomic.Uint64
	sequence.Store(400)
	frames, err := sealFXPUDPDatagrams(fxpUDPPacket{
		packetType: fxpUDPTypeData,
		tunnelID:   51,
		ruleID:     52,
		sessionID:  53,
		payload:    payload,
	}, "udp-fragment-test-key", &sequence)
	if err != nil {
		t.Fatal(err)
	}
	wantFragments, err := fxpUDPFragmentCount(len(payload))
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != wantFragments || len(frames) <= 1 {
		t.Fatalf("fragment count = %d, want %d", len(frames), wantFragments)
	}

	packets := make([]fxpUDPPacket, len(frames))
	for i, frame := range frames {
		if len(frame) > fxpUDPMaxWirePacketSize {
			t.Fatalf("fragment %d wire size = %d, max %d", i, len(frame), fxpUDPMaxWirePacketSize)
		}
		packets[i], err = openFXPUDPPacket(frame, "udp-fragment-test-key")
		if err != nil {
			t.Fatalf("open fragment %d: %v", i, err)
		}
		if int(packets[i].fragment) != i || int(packets[i].fragments) != len(frames) {
			t.Fatalf("fragment metadata %d = %d/%d", i, packets[i].fragment, packets[i].fragments)
		}
		if packets[i].sequence != 401 {
			t.Fatalf("fragment %d sequence = %d, want logical datagram sequence 401", i, packets[i].sequence)
		}
	}

	var reassembler udpFragmentReassembler
	var replay udpReplayWindow
	var reassembled []byte
	for i := len(packets) - 1; i >= 0; i-- {
		if result, ok := reassembler.accept(packets[i], &replay); ok {
			if reassembled != nil {
				t.Fatal("fragment set produced more than one datagram")
			}
			reassembled = result
		}
	}
	if !bytes.Equal(reassembled, payload) {
		t.Fatalf("reassembled payload mismatch: got=%d want=%d", len(reassembled), len(payload))
	}
	for i := len(packets) - 1; i >= 0; i-- {
		if _, ok := reassembler.accept(packets[i], &replay); ok {
			t.Fatal("replayed fragment set was accepted")
		}
	}
}

func TestFXPUDPSmallDatagramKeepsLegacyHeader(t *testing.T) {
	var sequence atomic.Uint64
	frames, err := sealFXPUDPDatagrams(fxpUDPPacket{
		packetType: fxpUDPTypeReturn,
		tunnelID:   61,
		ruleID:     62,
		sessionID:  63,
		payload:    []byte("small-compatible-payload"),
	}, "udp-small-test-key", &sequence)
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 1 {
		t.Fatalf("small datagram produced %d frames", len(frames))
	}
	if frames[0][4] != fxpUDPVersion || frames[0][6] != 0 || frames[0][7] != 0 {
		t.Fatalf("small datagram changed legacy header: version=%d fragments=%d/%d", frames[0][4], frames[0][6], frames[0][7])
	}
}

func TestFXPUDPReassemblesAdjacentLargeDatagramsOutOfOrder(t *testing.T) {
	var sequence atomic.Uint64
	seal := func(fill byte) []fxpUDPPacket {
		payload := bytes.Repeat([]byte{fill}, 32*1024)
		frames, err := sealFXPUDPDatagrams(fxpUDPPacket{
			packetType: fxpUDPTypeData,
			tunnelID:   71,
			ruleID:     72,
			sessionID:  73,
			payload:    payload,
		}, "udp-adjacent-test-key", &sequence)
		if err != nil {
			t.Fatal(err)
		}
		packets := make([]fxpUDPPacket, len(frames))
		for i, frame := range frames {
			packets[i], err = openFXPUDPPacket(frame, "udp-adjacent-test-key")
			if err != nil {
				t.Fatalf("open fragment %d: %v", i, err)
			}
		}
		return packets
	}
	first := seal(0x11)
	second := seal(0x22)
	var reassembler udpFragmentReassembler
	var replay udpReplayWindow
	for _, test := range []struct {
		name    string
		packets []fxpUDPPacket
		fill    byte
	}{
		{name: "second", packets: second, fill: 0x22},
		{name: "first", packets: first, fill: 0x11},
	} {
		var payload []byte
		for i := len(test.packets) - 1; i >= 0; i-- {
			if result, ok := reassembler.accept(test.packets[i], &replay); ok {
				payload = result
			}
		}
		if !bytes.Equal(payload, bytes.Repeat([]byte{test.fill}, 32*1024)) {
			t.Fatalf("%s datagram did not survive cross-datagram reordering", test.name)
		}
	}
}

func TestFXPUDPExitTargetIsConfigurationBound(t *testing.T) {
	cfg := config{UDPTargets: []udpTarget{{RuleID: 7, TargetIP: "127.0.0.1", TargetPort: 5353}}}
	target, ok := udpTargetForRule(cfg, 7)
	if !ok || target.TargetIP != "127.0.0.1" || target.TargetPort != 5353 {
		t.Fatalf("configured UDP target not resolved: %+v ok=%v", target, ok)
	}
	if _, ok := udpTargetForRule(cfg, 8); ok {
		t.Fatal("UDP exit accepted a destination that was not configured for the rule")
	}
}

func TestForwardXProxyProtocolRoundTrip(t *testing.T) {
	headerCh := make(chan string, 1)
	targetLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer targetLn.Close()
	go func() {
		conn, err := targetLn.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		deadline := time.Now().Add(3 * time.Second)
		_ = conn.SetReadDeadline(deadline)
		buf := make([]byte, 256)
		var got []byte
		for len(got) < len("PROXY TCP4 203.0.113.10 198.51.100.20 54321 443\r\npayload") {
			n, err := conn.Read(buf)
			if n > 0 {
				got = append(got, buf[:n]...)
			}
			if err != nil {
				break
			}
		}
		headerCh <- string(got)
	}()

	key := "proxy-protocol-key"
	targetPort := targetLn.Addr().(*net.TCPAddr).Port
	exitPort := freeTCPPort(t)
	entryPort := freeTCPPort(t)
	exitDone := make(chan struct{})
	entryDone := make(chan struct{})
	defer close(exitDone)
	defer close(entryDone)

	go func() {
		_ = runExit(exitDone, config{
			Role:       "exit",
			TunnelID:   11,
			ListenPort: exitPort,
			Protocol:   "tcp",
			Key:        key,
		})
	}()
	waitForTCP(t, exitPort)

	go func() {
		_ = runEntry(entryDone, config{
			Role:                     "entry",
			TunnelID:                 11,
			RuleID:                   12,
			ListenPort:               entryPort,
			Protocol:                 "tcp",
			ExitHost:                 "127.0.0.1",
			ExitPort:                 exitPort,
			TargetIP:                 "127.0.0.1",
			TargetPort:               targetPort,
			Key:                      key,
			ProxyProtocolReceive:     true,
			ProxyProtocolSend:        true,
			ProxyProtocolExitReceive: true,
			ProxyProtocolExitSend:    true,
		})
	}()
	waitForTCP(t, entryPort)

	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort)), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("PROXY TCP4 203.0.113.10 198.51.100.20 54321 443\r\npayload")); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-headerCh:
		want := "PROXY TCP4 203.0.113.10 198.51.100.20 54321 443\r\npayload"
		if got != want {
			t.Fatalf("unexpected target payload %q", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timeout waiting for target payload")
	}
}

func TestForwardXRelayTCPRoundTrip(t *testing.T) {
	targetLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer targetLn.Close()
	go func() {
		for {
			conn, err := targetLn.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()

	upstreamKey := "entry-to-relay-key"
	downstreamKey := "relay-to-exit-key"
	targetPort := targetLn.Addr().(*net.TCPAddr).Port
	exitPort := freeTCPPort(t)
	relayPort := freeTCPPort(t)
	entryPort := freeTCPPort(t)
	exitDone := make(chan struct{})
	relayDone := make(chan struct{})
	entryDone := make(chan struct{})
	defer close(exitDone)
	defer close(relayDone)
	defer close(entryDone)

	go func() {
		_ = runExit(exitDone, config{
			Role:       "exit",
			TunnelID:   3,
			ListenPort: exitPort,
			Protocol:   "tcp",
			Key:        downstreamKey,
		})
	}()
	waitForTCP(t, exitPort)

	go func() {
		_ = runRelay(relayDone, config{
			Role:          "relay",
			TunnelID:      3,
			ListenPort:    relayPort,
			Protocol:      "tcp",
			Key:           upstreamKey,
			RelayExitHost: "127.0.0.1",
			RelayExitPort: exitPort,
			RelayKey:      downstreamKey,
		})
	}()
	waitForTCP(t, relayPort)

	go func() {
		_ = runEntry(entryDone, config{
			Role:       "entry",
			TunnelID:   3,
			RuleID:     4,
			ListenPort: entryPort,
			Protocol:   "tcp",
			ExitHost:   "127.0.0.1",
			ExitPort:   relayPort,
			TargetIP:   "127.0.0.1",
			TargetPort: targetPort,
			Key:        upstreamKey,
		})
	}()
	waitForTCP(t, entryPort)

	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort)), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("relay-forwardx")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, len("relay-forwardx"))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != "relay-forwardx" {
		t.Fatalf("unexpected echo %q", string(buf))
	}
}

func TestForwardXRelayChainTCPRoundTrip(t *testing.T) {
	targetLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer targetLn.Close()
	go func() {
		for {
			conn, err := targetLn.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()

	keys := []string{
		"entry-to-relay-1-key",
		"relay-1-to-relay-2-key",
		"relay-2-to-exit-key",
	}
	targetPort := targetLn.Addr().(*net.TCPAddr).Port
	exitPort := freeTCPPort(t)
	relay2Port := freeTCPPort(t)
	relay1Port := freeTCPPort(t)
	entryPort := freeTCPPort(t)
	exitDone := make(chan struct{})
	relay2Done := make(chan struct{})
	relay1Done := make(chan struct{})
	entryDone := make(chan struct{})
	defer close(exitDone)
	defer close(relay2Done)
	defer close(relay1Done)
	defer close(entryDone)

	go func() {
		_ = runExit(exitDone, config{
			Role:       "exit",
			TunnelID:   5,
			ListenPort: exitPort,
			Protocol:   "tcp",
			Key:        keys[2],
		})
	}()
	waitForTCP(t, exitPort)

	go func() {
		_ = runRelay(relay2Done, config{
			Role:          "relay",
			TunnelID:      5,
			ListenPort:    relay2Port,
			Protocol:      "tcp",
			Key:           keys[1],
			RelayExitHost: "127.0.0.1",
			RelayExitPort: exitPort,
			RelayKey:      keys[2],
		})
	}()
	waitForTCP(t, relay2Port)

	go func() {
		_ = runRelay(relay1Done, config{
			Role:          "relay",
			TunnelID:      5,
			ListenPort:    relay1Port,
			Protocol:      "tcp",
			Key:           keys[0],
			RelayExitHost: "127.0.0.1",
			RelayExitPort: relay2Port,
			RelayKey:      keys[1],
		})
	}()
	waitForTCP(t, relay1Port)

	go func() {
		_ = runEntry(entryDone, config{
			Role:       "entry",
			TunnelID:   5,
			RuleID:     6,
			ListenPort: entryPort,
			Protocol:   "tcp",
			ExitHost:   "127.0.0.1",
			ExitPort:   relay1Port,
			TargetIP:   "127.0.0.1",
			TargetPort: targetPort,
			Key:        keys[0],
		})
	}()
	waitForTCP(t, entryPort)

	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort)), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("relay-chain-forwardx")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, len("relay-chain-forwardx"))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != "relay-chain-forwardx" {
		t.Fatalf("unexpected echo %q", string(buf))
	}
}

func TestFxpRejectsReplaySalt(t *testing.T) {
	c1, s1 := net.Pipe()
	defer c1.Close()
	defer s1.Close()
	c2, s2 := net.Pipe()
	defer c2.Close()
	defer s2.Close()

	cfg := config{Role: "exit", TunnelID: 77, RuleID: 0, ListenPort: 12345, Key: "replay-key"}
	salt := make([]byte, fxpSaltSize)
	for i := range salt {
		salt[i] = byte(i + 1)
	}
	key := replayKey(cfg, salt)
	fxpReplaySeen.mu.Lock()
	delete(fxpReplaySeen.seen, key)
	fxpReplaySeen.mu.Unlock()

	errCh := make(chan error, 2)
	go func() {
		sec, err := newServerSecureConn(s1, cfg)
		if err == nil {
			_ = sec.conn.Close()
		}
		errCh <- err
	}()
	if _, err := writeFull(c1, salt); err != nil {
		t.Fatal(err)
	}
	client, err := newSessionSecureConn(c1, cfg.Key, salt, true)
	if err != nil {
		t.Fatal(err)
	}
	hello, _ := json.Marshal(fxpHandshake{V: fxpHandshakeVersion, TS: time.Now().Unix(), TunnelID: cfg.TunnelID})
	if err := client.writeFrame(hello); err != nil {
		t.Fatal(err)
	}
	if _, err := client.readFrame(); err != nil {
		t.Fatal(err)
	}
	if err := <-errCh; err != nil {
		t.Fatalf("first handshake failed: %v", err)
	}

	go func() {
		sec, err := newServerSecureConn(s2, cfg)
		if err == nil {
			_ = sec.conn.Close()
		}
		errCh <- err
	}()
	if _, err := writeFull(c2, salt); err != nil {
		t.Fatal(err)
	}
	if err := <-errCh; err == nil {
		t.Fatal("expected replayed salt to be rejected")
	}
}

func TestFxpServerAcceptsCompatibilityWireContext(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer clientConn.Close()
	defer serverConn.Close()

	cfg := config{Role: "exit", TunnelID: 88, RuleID: 0, ListenPort: 12345, Key: "compat-key"}
	errCh := make(chan error, 1)
	go func() {
		sec, err := newServerSecureConn(serverConn, cfg)
		if err == nil {
			_ = sec.conn.Close()
		}
		errCh <- err
	}()
	client, err := newClientSecureConnWithWire(clientConn, cfg, fxpWireCompat2390)
	if err != nil {
		t.Fatal(err)
	}
	_ = client.conn.Close()
	if err := <-errCh; err != nil {
		t.Fatalf("compat handshake failed: %v", err)
	}
}

func TestFxpClientRetriesCompatibilityWireContext(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	cfg := config{Role: "entry", TunnelID: 89, RuleID: 0, ListenPort: 12345, Key: "compat-retry-key"}
	done := make(chan error, 1)
	go func() {
		for i := 0; i < 2; i++ {
			conn, err := ln.Accept()
			if err != nil {
				done <- err
				return
			}
			sec, err := newServerSecureConnWithWires(conn, cfg, []fxpWireContext{fxpWireCompat2390})
			if err != nil {
				_ = conn.Close()
				continue
			}
			_ = sec.conn.Close()
			done <- nil
			return
		}
		done <- errors.New("compat retry did not reach server")
	}()

	port := ln.Addr().(*net.TCPAddr).Port
	conn, sec, err := dialSecureTCP("127.0.0.1", port, cfg)
	if err != nil {
		t.Fatal(err)
	}
	_ = sec.conn.Close()
	_ = conn.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestWaitBidirectionalKeepsCleanHalfClosedStreamsOpen(t *testing.T) {
	errCh := make(chan error, 2)
	closed := make(chan struct{}, 1)
	done := make(chan error, 1)

	go func() {
		done <- waitBidirectionalWithLinger(errCh, func() {
			closed <- struct{}{}
		}, 20*time.Millisecond)
	}()

	errCh <- nil
	select {
	case err := <-done:
		t.Fatalf("returned before the opposite direction finished: %v", err)
	case <-closed:
		t.Fatal("closed both sides after a clean half-close")
	case <-time.After(60 * time.Millisecond):
	}

	errCh <- nil
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("unexpected wait error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for bidirectional relay to finish")
	}
	select {
	case <-closed:
		t.Fatal("closeAll should not run for a clean bidirectional shutdown")
	default:
	}
}

func TestFxpWireContextRemainsStable(t *testing.T) {
	if string(fxpWireCurrent.sessionInfo) != "forwardx-fxp-v2 session" {
		t.Fatalf("unexpected session context %q", string(fxpWireCurrent.sessionInfo))
	}
	if string(fxpWireCurrent.lengthAD) != "forwardx-fxp-v2 length" {
		t.Fatalf("unexpected length AD %q", string(fxpWireCurrent.lengthAD))
	}
	if string(fxpWireCurrent.payloadAD) != "forwardx-fxp-v2 payload" {
		t.Fatalf("unexpected payload AD %q", string(fxpWireCurrent.payloadAD))
	}
	if fxpWireCurrent.masterContext != "forwardx-fxp-v2 master" {
		t.Fatalf("unexpected master context %q", fxpWireCurrent.masterContext)
	}
	if string(fxpWireCompat2390.sessionInfo) != "forwardx-fxp session" {
		t.Fatalf("unexpected compat session context %q", string(fxpWireCompat2390.sessionInfo))
	}
	if fxpWireCompat2390.masterContext != "forwardx-fxp master" {
		t.Fatalf("unexpected compat master context %q", fxpWireCompat2390.masterContext)
	}
}

func freeTCPPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func freeUDPPort(t *testing.T) int {
	t.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	return conn.LocalAddr().(*net.UDPAddr).Port
}

func freeTCPUDPPort(t *testing.T) int {
	t.Helper()
	for i := 0; i < 100; i++ {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		port := ln.Addr().(*net.TCPAddr).Port
		_ = ln.Close()
		conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: port})
		if err == nil {
			_ = conn.Close()
			return port
		}
	}
	t.Fatal("could not find a port free for tcp and udp")
	return 0
}

func udpRoundTrip(t *testing.T, client *net.UDPConn, payload []byte) []byte {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	buf := make([]byte, 65535)
	for time.Now().Before(deadline) {
		if _, err := client.Write(payload); err != nil {
			if errors.Is(err, syscall.ECONNREFUSED) {
				time.Sleep(20 * time.Millisecond)
				continue
			}
			t.Fatal(err)
		}
		attemptDeadline := time.Now().Add(200 * time.Millisecond)
		if attemptDeadline.After(deadline) {
			attemptDeadline = deadline
		}
		_ = client.SetReadDeadline(attemptDeadline)
		n, err := client.Read(buf)
		if err == nil {
			return append([]byte(nil), buf[:n]...)
		}
		netErr, isNetErr := err.(net.Error)
		if (!isNetErr || !netErr.Timeout()) && !errors.Is(err, syscall.ECONNREFUSED) {
			t.Fatal(err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("udp round trip timed out after 3s")
	return nil
}

func waitForTCP(t *testing.T, port int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 100*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("port %d did not open", port)
}

func TestFormatProxyProtocolV2(t *testing.T) {
	hello := helloFrame{
		TargetIP:             "10.0.0.5",
		TargetPort:           8443,
		ProxySourceIP:        "198.51.100.7",
		ProxySourcePort:      51443,
		ProxyDestIP:          "10.0.0.5",
		ProxyDestPort:        8443,
		ProxyProtocolVersion: 2,
	}
	payload := append(formatProxyProtocol(hello), []byte("payload")...)
	info, remaining, ok, err := consumeProxyProtocol(payload)
	if err != nil {
		t.Fatalf("consumeProxyProtocol v2 error: %v", err)
	}
	if !ok {
		t.Fatal("expected proxy protocol v2 header")
	}
	if string(remaining) != "payload" {
		t.Fatalf("remaining payload = %q", string(remaining))
	}
	if info.SourceIP != "198.51.100.7" || info.SourcePort != 51443 || info.DestIP != "10.0.0.5" || info.DestPort != 8443 {
		t.Fatalf("unexpected proxy info: %+v", info)
	}
}
