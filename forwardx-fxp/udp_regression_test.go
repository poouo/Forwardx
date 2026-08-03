package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestCheckFXPUDPSessionCapacityUsesPrecomputedHardLimits(t *testing.T) {
	policy := fxpUDPSessionPolicy{
		softSessions: 2,
		hardSessions: 3,
		softPerIP:    2,
		hardPerIP:    2,
	}
	tests := []struct {
		name       string
		total      int
		perIP      int
		incomingIP string
		allow      bool
		reason     fxpUDPAdmissionReason
	}{
		{name: "below limits", total: 1, perIP: 1, incomingIP: "192.0.2.1", allow: true, reason: fxpUDPAdmissionBelowLimit},
		{name: "soft limits remain admissible", total: 2, perIP: 1, incomingIP: "192.0.2.1", allow: true, reason: fxpUDPAdmissionBelowLimit},
		{name: "global hard boundary", total: 3, perIP: 0, allow: false, reason: fxpUDPAdmissionRejectActiveGlobal},
		{name: "per IP hard boundary", total: 2, perIP: 2, incomingIP: "192.0.2.1", allow: false, reason: fxpUDPAdmissionRejectActivePerIP},
		{name: "scoped hard limit has priority", total: 3, perIP: 2, incomingIP: "192.0.2.1", allow: false, reason: fxpUDPAdmissionRejectActivePerIP},
		{name: "empty source ignores per IP count", total: 2, perIP: 99, allow: true, reason: fxpUDPAdmissionBelowLimit},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			decision := checkFXPUDPSessionCapacity(test.total, test.perIP, test.incomingIP, policy)
			if decision.allow != test.allow || decision.reason != test.reason {
				t.Fatalf("capacity decision = %+v, want allow=%v reason=%s", decision, test.allow, test.reason)
			}
			if decision.total != test.total || decision.perIP != test.perIP {
				t.Fatalf("capacity counts = %d/%d, want %d/%d", decision.total, decision.perIP, test.total, test.perIP)
			}
		})
	}
}

func TestPlanFXPUDPPressureReclamationOnlyReclaimsQuiescentIdleSessions(t *testing.T) {
	now := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	newSession := func(ip string, age time.Duration) *udpEntrySession {
		session := &udpEntrySession{clientAddr: &net.UDPAddr{IP: net.ParseIP(ip)}}
		session.lastActivity.Store(now.Add(-age).UnixNano())
		return session
	}
	queued := newSession("192.0.2.1", 2*time.Minute)
	queued.send = newFXPUDPQueue(1, 64)
	if dropped := queued.send.enqueue([]byte("queued")); dropped {
		t.Fatal("queued session packet was unexpectedly dropped")
	}
	inFlight := newSession("192.0.2.3", 2*time.Minute)
	inFlight.inFlight.Store(1)
	sessions := map[string]*udpEntrySession{
		"global-oldest": newSession("192.0.2.2", 2*time.Minute),
		"same-old":      newSession("192.0.2.1", 90*time.Second),
		"same-middle":   newSession("192.0.2.1", time.Minute),
		"same-new":      newSession("192.0.2.1", 31*time.Second),
		"boundary":      newSession("192.0.2.4", 30*time.Second),
		"queued":        queued,
		"in-flight":     inFlight,
		"too-new":       newSession("192.0.2.1", 30*time.Second-time.Nanosecond),
	}
	policy := fxpUDPSessionPolicy{
		softSessions: 4,
		hardSessions: 8,
		softPerIP:    3,
		hardPerIP:    6,
		reclaimAfter: 30 * time.Second,
	}

	reclaimed := planFXPUDPPressureReclamation(now, sessions, policy, udpEntrySessionSnapshot)
	wantKeys := []string{"global-oldest", "same-old", "same-middle", "same-new", "boundary"}
	if len(reclaimed) != len(wantKeys) {
		t.Fatalf("reclaimed %d sessions, want %d: %+v", len(reclaimed), len(wantKeys), reclaimed)
	}
	for i, want := range wantKeys {
		if reclaimed[i].key != want || reclaimed[i].session != sessions[want] {
			t.Fatalf("reclamation %d = %+v, want key=%q session=%p", i, reclaimed[i], want, sessions[want])
		}
	}
	if remaining := len(sessions) - len(reclaimed); remaining >= policy.softSessions {
		t.Fatalf("remaining sessions = %d, want below soft limit %d", remaining, policy.softSessions)
	}
	for _, protected := range []string{"queued", "in-flight", "too-new"} {
		for _, candidate := range reclaimed {
			if candidate.key == protected {
				t.Fatalf("pressure planner reclaimed protected session %q", protected)
			}
		}
	}
}

func TestPlanFXPUDPPressureReclamationScopesPerIPPressure(t *testing.T) {
	now := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	sessions := map[string]*udpAdmissionTestSession{
		"other-oldest": {ip: "192.0.2.2", activity: now.Add(-2 * time.Minute).UnixNano()},
		"same-old":     {ip: "192.0.2.1", activity: now.Add(-time.Minute).UnixNano()},
		"same-new":     {ip: "192.0.2.1", activity: now.Add(-31 * time.Second).UnixNano()},
		"same-active":  {ip: "192.0.2.1", activity: now.Add(-time.Second).UnixNano()},
	}
	policy := fxpUDPSessionPolicy{
		softSessions: 100,
		hardSessions: 100,
		softPerIP:    2,
		hardPerIP:    4,
		reclaimAfter: 30 * time.Second,
	}

	reclaimed := planFXPUDPPressureReclamation(now, sessions, policy, udpAdmissionTestSnapshot)
	if len(reclaimed) != 2 || reclaimed[0].key != "same-old" || reclaimed[1].key != "same-new" {
		t.Fatalf("per-IP reclamation = %+v, want only same-IP idle sessions", reclaimed)
	}
}

func TestFXPUDPSessionWorkerDrainPreservesFinalTrafficDelta(t *testing.T) {
	resetTrafficBatchesForTest()
	t.Cleanup(resetTrafficBatchesForTest)
	reportStarted := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		select {
		case reportStarted <- struct{}{}:
		default:
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	cfg := config{PanelURL: server.URL, Token: "udp-worker-drain-token", RuleID: 701}
	key := trafficBatchKey{panelURL: server.URL, token: cfg.Token, producerID: fxpTrafficProducerID(cfg)}
	counter := &trafficCounter{}
	stopReporting := startTrafficReporter(cfg, counter)
	releaseWorker := make(chan struct{})
	var releaseOnce sync.Once
	release := func() {
		releaseOnce.Do(func() { close(releaseWorker) })
	}
	workerStarted := make(chan struct{})
	var workerWG sync.WaitGroup
	t.Cleanup(func() {
		release()
		workerWG.Wait()
		stopReporting()
	})
	startFXPUDPSessionWorker(&workerWG, func() {
		close(workerStarted)
		<-releaseWorker
		counter.in.Add(101)
		counter.out.Add(202)
		counter.connections.Add(1)
	})
	<-workerStarted
	trafficBatchFlushMu.Lock()
	flushLocked := true
	t.Cleanup(func() {
		if flushLocked {
			trafficBatchFlushMu.Unlock()
		}
	})

	shutdownDone := make(chan struct{})
	go func() {
		workerWG.Wait()
		stopReporting()
		close(shutdownDone)
	}()
	select {
	case <-shutdownDone:
		t.Fatal("shutdown stopped the reporter before the UDP worker drained")
	case <-time.After(20 * time.Millisecond):
	}
	release()
	select {
	case <-shutdownDone:
	case <-time.After(2 * time.Second):
		t.Fatal("shutdown did not finish after the UDP worker drained")
	}

	got := trafficBatchSnapshot()[key][cfg.RuleID]
	if got.bytesIn != 101 || got.bytesOut != 202 || got.connections != 1 {
		t.Fatalf("final worker traffic delta was not retained: %+v", got)
	}
	trafficBatchFlushMu.Unlock()
	flushLocked = false
	select {
	case <-reportStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("stopping the reporter did not wake the traffic batch worker")
	}
	trafficBatchFlushMu.Lock()
	trafficBatchFlushMu.Unlock()
}

func TestFXPUDPDirectSnapshotsIncludeInFlightWork(t *testing.T) {
	entry := &udpDirectEntrySession{clientAddr: &net.UDPAddr{IP: net.ParseIP("192.0.2.20")}}
	entry.inFlight.Store(1)
	exit := &udpDirectExitSession{}
	exit.inFlight.Store(2)
	relay := &udpDirectRelaySession{}
	relay.inFlight.Store(3)

	for _, test := range []struct {
		name string
		got  fxpUDPSessionSnapshot
		want int
	}{
		{name: "entry", got: udpDirectEntrySessionSnapshot(entry), want: 1},
		{name: "exit", got: udpDirectExitSessionSnapshot(exit), want: 2},
		{name: "relay", got: udpDirectRelaySessionSnapshot(relay), want: 3},
	} {
		t.Run(test.name, func(t *testing.T) {
			if test.got.pending != test.want {
				t.Fatalf("snapshot pending = %d, want %d", test.got.pending, test.want)
			}
		})
	}
}

func TestFXPUDPDirectSnapshotsProtectPartialFragmentAssemblies(t *testing.T) {
	entry := &udpDirectEntrySession{}
	exit := &udpDirectExitSession{}
	relay := &udpDirectRelaySession{}
	tests := []struct {
		name     string
		accept   func(fxpUDPPacket, *udpReplayWindow) ([]byte, bool)
		expire   func(time.Time)
		snapshot func() fxpUDPSessionSnapshot
	}{
		{
			name:     "entry return",
			accept:   entry.returnFragments.accept,
			expire:   entry.returnFragments.expire,
			snapshot: func() fxpUDPSessionSnapshot { return udpDirectEntrySessionSnapshot(entry) },
		},
		{
			name:     "exit data",
			accept:   exit.dataFragments.accept,
			expire:   exit.dataFragments.expire,
			snapshot: func() fxpUDPSessionSnapshot { return udpDirectExitSessionSnapshot(exit) },
		},
		{
			name:     "relay data",
			accept:   relay.dataFragments.accept,
			expire:   relay.dataFragments.expire,
			snapshot: func() fxpUDPSessionSnapshot { return udpDirectRelaySessionSnapshot(relay) },
		},
		{
			name:     "relay return",
			accept:   relay.returnFragments.accept,
			expire:   relay.returnFragments.expire,
			snapshot: func() fxpUDPSessionSnapshot { return udpDirectRelaySessionSnapshot(relay) },
		},
	}

	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var replay udpReplayWindow
			sequence := uint64(800 + index*2)
			if payload, ok := test.accept(testFXPUDPFragment(sequence, 0, 2, "first"), &replay); ok || payload != nil {
				t.Fatalf("partial fragment unexpectedly completed: payload=%q ok=%v", payload, ok)
			}
			if got := test.snapshot().pending; got != 1 {
				t.Fatalf("snapshot pending with partial assembly = %d, want 1", got)
			}
			if payload, ok := test.accept(testFXPUDPFragment(sequence, 1, 2, "second"), &replay); !ok || string(payload) != "firstsecond" {
				t.Fatalf("completed fragment payload=%q ok=%v, want firstsecond/true", payload, ok)
			}
			if got := test.snapshot().pending; got != 0 {
				t.Fatalf("snapshot pending after completion = %d, want 0", got)
			}

			if _, ok := test.accept(testFXPUDPFragment(sequence+1, 0, 2, "expires"), &replay); ok {
				t.Fatal("partial expiring fragment unexpectedly completed")
			}
			if got := test.snapshot().pending; got != 1 {
				t.Fatalf("snapshot pending before expiration = %d, want 1", got)
			}
			test.expire(time.Now().Add(fxpUDPFragmentTimeout + time.Second))
			if got := test.snapshot().pending; got != 0 {
				t.Fatalf("snapshot pending after expiration = %d, want 0", got)
			}
		})
	}
}

func TestExitUDPDirectSameSessionIDDifferentRulesPreservesOldSession(t *testing.T) {
	targetOne, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer targetOne.Close()
	targetTwo, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer targetTwo.Close()
	exitConn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}

	const (
		tunnelID  = 501
		ruleOne   = 601
		ruleTwo   = 602
		sessionID = uint64(0x1122334455667788)
		key       = "udp-exit-session-collision-key"
	)
	cfg := config{
		Role:     "exit",
		TunnelID: tunnelID,
		Protocol: "udp",
		Key:      key,
		UDPTargets: []udpTarget{
			{RuleID: ruleOne, TargetIP: "127.0.0.1", TargetPort: targetOne.LocalAddr().(*net.UDPAddr).Port},
			{RuleID: ruleTwo, TargetIP: "127.0.0.1", TargetPort: targetTwo.LocalAddr().(*net.UDPAddr).Port},
		},
	}
	serveDone := make(chan error, 1)
	go func() {
		serveDone <- serveExitUDPDirect(exitConn, cfg)
	}()
	t.Cleanup(func() {
		_ = exitConn.Close()
		select {
		case <-serveDone:
		case <-time.After(2 * time.Second):
			t.Error("exit UDP server did not stop")
		}
	})

	client, err := net.DialUDP("udp", nil, exitConn.LocalAddr().(*net.UDPAddr))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	var ruleOneSequence atomic.Uint64
	var ruleTwoSequence atomic.Uint64
	send := func(t *testing.T, ruleID int, sequence *atomic.Uint64, payload string) {
		t.Helper()
		frames, err := sealFXPUDPDatagrams(fxpUDPPacket{
			packetType: fxpUDPTypeData,
			tunnelID:   tunnelID,
			ruleID:     ruleID,
			sessionID:  sessionID,
			payload:    []byte(payload),
		}, key, sequence)
		if err != nil {
			t.Fatal(err)
		}
		for _, frame := range frames {
			if _, err := client.Write(frame); err != nil {
				t.Fatal(err)
			}
		}
	}
	readTarget := func(t *testing.T, target *net.UDPConn, want string) *net.UDPAddr {
		t.Helper()
		if err := target.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
			t.Fatal(err)
		}
		buf := make([]byte, 1024)
		n, addr, err := target.ReadFromUDP(buf)
		if err != nil {
			t.Fatal(err)
		}
		if got := string(buf[:n]); got != want {
			t.Fatalf("target payload = %q, want %q", got, want)
		}
		return addr
	}

	send(t, ruleOne, &ruleOneSequence, "first-rule")
	oldSessionAddr := readTarget(t, targetOne, "first-rule")
	send(t, ruleTwo, &ruleTwoSequence, "second-rule")
	_ = readTarget(t, targetTwo, "second-rule")

	if _, err := targetOne.WriteToUDP([]byte("old-session-reply"), oldSessionAddr); err != nil {
		t.Fatal(err)
	}
	if err := client.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 2048)
	n, err := client.Read(buf)
	if err != nil {
		t.Fatalf("old rule session no longer returned traffic after rule collision: %v", err)
	}
	packet, err := openFXPUDPPacket(buf[:n], key)
	if err != nil {
		t.Fatal(err)
	}
	if packet.packetType != fxpUDPTypeReturn || packet.ruleID != ruleOne || packet.sessionID != sessionID || string(packet.payload) != "old-session-reply" {
		t.Fatalf("unexpected old-session reply: type=%d rule=%d session=%d payload=%q", packet.packetType, packet.ruleID, packet.sessionID, packet.payload)
	}
}
