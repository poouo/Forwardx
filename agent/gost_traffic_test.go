package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"
)

func gostTrafficFixture(protocol string, input, output uint64) map[string]any {
	return map[string]any{
		"name": "fwx-42-" + protocol, "addr": ":22022",
		"metadata": map[string]any{"enableStats": true, "observer.resetTraffic": false},
		"listener": map[string]any{"type": protocol},
		"status": map[string]any{"createTime": 1700000000, "state": "ready", "stats": map[string]any{
			"inputBytes": input, "outputBytes": output, "totalConns": uint64(3),
		}},
	}
}

func TestGostNativeTrafficSnapshotRequiresCompleteCurrentListeners(t *testing.T) {
	state := localRuleState{RuleID: 42, Port: "22022", Protocol: "both", ForwardType: "gost"}
	for _, name := range []string{"complete", "missing-udp", "stale-port", "wrong-rule", "disabled-stats", "reset-on-read", "missing-stats", "closed", "wrong-listener", "duplicate", "overflow", "wrong-tool"} {
		t.Run(name, func(t *testing.T) {
			tcp := gostTrafficFixture("tcp", 9007199254740993, 200)
			udp := gostTrafficFixture("udp", 100, 50)
			services := []any{tcp, udp}
			current := state
			switch name {
			case "missing-udp":
				services = services[:1]
			case "stale-port":
				tcp["addr"] = ":22023"
			case "wrong-rule":
				tcp["name"] = "fwx-43-tcp"
			case "disabled-stats":
				tcp["metadata"] = nil
			case "reset-on-read":
				tcp["metadata"].(map[string]any)["observer.resetTraffic"] = true
			case "missing-stats":
				delete(tcp["status"].(map[string]any), "stats")
			case "closed":
				tcp["status"].(map[string]any)["state"] = "closed"
			case "wrong-listener":
				tcp["listener"] = map[string]any{"type": "tls"}
			case "duplicate":
				services = append(services, tcp)
			case "overflow":
				udp["status"].(map[string]any)["stats"].(map[string]any)["inputBytes"] = ^uint64(0)
			case "wrong-tool":
				current.ForwardType = "forwardx"
			}
			data, _ := json.Marshal(map[string]any{"services": services})
			samples, err := parseGostTrafficSnapshot(data, []localRuleState{current}, "socket-a")
			if err != nil {
				t.Fatal(err)
			}
			if name != "complete" {
				if len(samples) != 0 {
					t.Fatalf("incomplete/foreign counters accepted: %+v", samples)
				}
				return
			}
			sample := samples[state.Port]
			if sample.counters != (trafficCounters{In: 9007199254741093, Out: 250, Connections: 6}) || !validTrafficByteIdentity(sample.source, sample.epoch) {
				t.Fatalf("incorrect or lossy counters: %+v", sample)
			}
			other, _ := parseGostTrafficSnapshot(data, []localRuleState{current}, "socket-b")
			if other[state.Port].epoch == sample.epoch {
				t.Fatal("runtime replacement retained old epoch")
			}
		})
	}
	for _, data := range []string{"{", `{"services":[{"status":{"stats":{"inputBytes":-1}}}]}`} {
		if _, err := parseGostTrafficSnapshot([]byte(data), []localRuleState{state}, "a"); err == nil {
			t.Fatal("invalid/negative counters accepted")
		}
	}
}

func TestNativeTrafficSourceAndEpochTransitionsNeverReplay(t *testing.T) {
	previous := trafficPrevState{ruleID: 42, in: 1000, out: 500, byteSource: trafficSourceGostNative, byteEpoch: "a"}
	for _, tc := range []struct {
		name, source, epoch string
		previous            trafficPrevState
		counters            trafficCounters
		in, out             uint64
		baseline            bool
	}{
		{"increment", trafficSourceGostNative, "a", previous, trafficCounters{In: 1200, Out: 800}, 200, 300, false},
		{"restart-larger-counters", trafficSourceGostNative, "b", previous, trafficCounters{In: 8000, Out: 9000}, 0, 0, true},
		{"counter-reset", trafficSourceGostNative, "a", previous, trafficCounters{In: 10, Out: 20}, 0, 0, true},
		{"native-to-kernel", trafficConnectionSourceProcessNFT, "", previous, trafficCounters{In: 8000, Out: 9000}, 0, 0, true},
		{"legacy-to-native", trafficSourceGostNative, "a", trafficPrevState{ruleID: 42, in: 10}, trafficCounters{In: 8000}, 0, 0, true},
		{"legacy-kernel", trafficConnectionSourceProcessNFT, "", trafficPrevState{ruleID: 42, in: 10}, trafficCounters{In: 30}, 20, 0, false},
		{"native-to-guard", trafficSourceGuardNative, "c", previous, trafficCounters{In: 3000}, 0, 0, true},
		{"new-rule", trafficSourceGostNative, "a", trafficPrevState{ruleID: 41}, trafficCounters{In: 3000}, 0, 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in, out, baseline := trafficByteDeltas(tc.previous, 42, tc.counters, tc.source, tc.epoch)
			if in != tc.in || out != tc.out || baseline != tc.baseline {
				t.Fatalf("got %d/%d baseline=%v", in, out, baseline)
			}
		})
	}
}

func TestNativeTrafficBaselinePersistsAcrossRetryAndAgentRestart(t *testing.T) {
	useIsolatedTrafficState(t)
	epoch := strings.Repeat("a", 64)
	previous := trafficPrevState{ruleID: 42, in: 100, out: 200, conns: 3, connSource: trafficSourceGostNative, byteSource: trafficSourceGostNative, byteEpoch: epoch}
	if err := writePrevState("22022", previous); err != nil {
		t.Fatal(err)
	}
	next := previous
	next.in += 500
	next.out += 600
	next.conns++
	updates := []trafficBaselineUpdate{{port: "22022", state: next}}
	report := testRulePendingTrafficReport("native-retry", testTrafficReportIdentity("native"), persistedTrafficBaselines(updates)...)
	if err := savePendingTrafficReport(report); err != nil {
		t.Fatal(err)
	}
	if err := commitTrafficBaselines(false, updates); err != nil {
		t.Fatal(err)
	}
	trafficPrevMu.Lock()
	trafficPrevCache = map[string]trafficPrevState{}
	trafficPrevMu.Unlock()
	if readPrevState("22022") != previous {
		t.Fatal("failed report advanced or lost the native baseline")
	}
	loaded, ok, err := loadPendingTrafficReport(report.Identity)
	if err != nil || !ok {
		t.Fatalf("load: %v %v", ok, err)
	}
	if err := commitTrafficBaselines(true, pendingTrafficBaselineUpdates(loaded.Baselines)); err != nil {
		t.Fatal(err)
	}
	trafficPrevMu.Lock()
	trafficPrevCache = map[string]trafficPrevState{}
	trafficPrevMu.Unlock()
	if readPrevState("22022") != next {
		t.Fatal("native source/epoch lost during retry persistence")
	}
	if err := os.WriteFile(trafficStateDir+"/traffic_22023.prev", []byte("42\n100\n200\n3\nconntrack-snapshot-v1\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if old := readPrevState("22023"); old.byteSource != "" || old.ruleID != 42 {
		t.Fatal("legacy format broken")
	}
}

func TestMissingNetAdminBoundingCapability(t *testing.T) {
	for _, tc := range []struct {
		status  string
		missing bool
	}{
		{"CapBnd:\t00000000800405fb\n", true},
		{"CapBnd:\t000001ffffffffff\n", false},
		{"CapEff:\t0000000000000000\nCapBnd:\t0000000000001000\n", false},
		{"CapBnd:\tinvalid\n", false}, {"", false},
	} {
		if got := missingNetAdminBoundingCapability(tc.status); got != tc.missing {
			t.Fatalf("%q got %v", tc.status, got)
		}
	}
}

func TestRestrictedContainerDoesNotQueueImpossibleKernelRepairs(t *testing.T) {
	isolateCountingStateTest(t, "restricted")
	kernelTrafficUnavailable = func() bool { return true }
	for _, forwardType := range []string{"gost", "realm", "guard", "iptables"} {
		ensureCountingChainsIfNeeded(runningRule{RuleID: 42, SourcePort: 22022, ForwardType: forwardType})
	}
	if len(countingChainRepairQueue) != 0 || len(countingChainRepairPending) != 0 {
		t.Fatal("unprivileged Agent queued impossible firewall repairs")
	}
}

func TestNativeToFreshKernelConnectionCounterDoesNotDoubleCount(t *testing.T) {
	isolateCountingStateTest(t, "native-to-kernel")
	state := localRuleState{RuleID: 42, Port: "22022", ForwardType: "gost", Protocol: "tcp"}
	markFreshProcessConnectionCounter(22022, 42)
	previous := trafficPrevState{ruleID: 42, conns: 10, connSource: trafficSourceGostNative}
	total, source, baseline := prepareConnectionCounterBaseline(state, previous, 8, trafficConnectionSourceProcessNFT)
	if total != 8 || source != trafficConnectionSourceProcessNFT || baseline != total {
		t.Fatalf("kernel restoration replayed native connections: %d %s %d", total, source, baseline)
	}
}

func TestGuardNativeTrafficSnapshotIdentityAndLifetime(t *testing.T) {
	rule := guardRule{RuleID: 42, ListenPort: 22022, Protocol: "both"}
	server := newProtocolGuardServer(rule)
	defer server.close()
	server.trafficIn.Add(100)
	server.trafficOut.Add(200)
	server.trafficConns.Add(3)
	protocolGuardMu.Lock()
	previous := protocolGuards
	protocolGuards = map[string]*protocolGuardServer{guardID(rule): server}
	protocolGuardMu.Unlock()
	defer func() { protocolGuardMu.Lock(); protocolGuards = previous; protocolGuardMu.Unlock() }()
	states := []localRuleState{{RuleID: 42, Port: "22022", Protocol: "both", ForwardType: "guard"}}
	sample := guardNativeTrafficSnapshot(states)["22022"]
	if sample.counters != (trafficCounters{In: 100, Out: 200, Connections: 3}) || !validTrafficByteIdentity(sample.source, sample.epoch) {
		t.Fatalf("sample %+v", sample)
	}
	states[0].RuleID++
	if len(guardNativeTrafficSnapshot(states)) != 0 {
		t.Fatal("foreign rule attributed")
	}
	states[0].RuleID--
	server.close()
	if len(guardNativeTrafficSnapshot(states)) != 0 {
		t.Fatal("closed guard counted")
	}
}

func TestGostNativeTrafficSingleProtocol(t *testing.T) {
	for _, protocol := range []string{"tcp", "udp"} {
		data, _ := json.Marshal(map[string]any{"services": []any{gostTrafficFixture(protocol, 100, 200)}})
		state := localRuleState{RuleID: 42, Port: "22022", Protocol: protocol, ForwardType: "gost"}
		samples, err := parseGostTrafficSnapshot(data, []localRuleState{state}, "runtime")
		if err != nil || samples[state.Port].counters.In != 100 {
			t.Fatalf("%s %+v %v", protocol, samples, err)
		}
	}
}

// Keep native per-connection writes observable before the connection closes.
func TestGuardNativeTrafficCountsLiveTCP(t *testing.T) {
	server := newProtocolGuardServer(guardRule{RuleID: 42})
	defer server.close()
	client, input := net.Pipe()
	target, output := net.Pipe()
	defer client.Close()
	defer input.Close()
	defer target.Close()
	defer output.Close()
	done := make(chan error, 1)
	go func() {
		done <- server.copyTCPToTargetWithGuard(server.ctx, Config{}, client, target, []byte("payload"), newProtocolGuardInspection(protocolPolicy{}))
	}()
	data := make([]byte, 7)
	_ = output.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := output.Read(data); err != nil {
		t.Fatal(err)
	}
	output.Close()
	input.Close()
	<-done
	if server.trafficIn.Load() != 7 {
		t.Fatal(fmt.Sprintf("live TCP counted %d bytes", server.trafficIn.Load()))
	}
}

func TestGuardNativeTrafficCountsTCPReplies(t *testing.T) {
	server := newProtocolGuardServer(guardRule{RuleID: 42})
	defer server.close()
	client, output := net.Pipe()
	target, input := net.Pipe()
	defer client.Close()
	defer output.Close()
	defer target.Close()
	defer input.Close()
	done := make(chan error, 1)
	go func() {
		done <- server.copyTCPToClientWithGuard(server.ctx, Config{}, client, target, newProtocolGuardInspection(protocolPolicy{}))
	}()
	go func() { _, _ = input.Write([]byte("reply")); _ = input.Close() }()
	_ = output.SetReadDeadline(time.Now().Add(3 * time.Second))
	data := make([]byte, 5)
	if _, err := io.ReadFull(output, data); err != nil {
		t.Fatal(err)
	}
	<-done
	if server.trafficOut.Load() != 5 {
		t.Fatalf("reply counted %d bytes", server.trafficOut.Load())
	}
}

func TestGuardNativeTrafficCountsLiveUDP(t *testing.T) {
	echo, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		buffer := make([]byte, 256)
		for {
			n, address, err := echo.ReadFrom(buffer)
			if err != nil {
				return
			}
			_, _ = echo.WriteTo(buffer[:n], address)
		}
	}()
	_, targetPort, _ := net.SplitHostPort(echo.LocalAddr().String())
	server := newProtocolGuardServer(guardRule{RuleID: 42, TargetIP: "127.0.0.1", TargetPort: parseStatePort(targetPort), Protocol: "udp"})
	server.udpConn, err = listenUDPReplyConn("udp", "127.0.0.1:0")
	if err != nil {
		server.close()
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { defer close(done); server.serveUDP() }()
	defer func() { server.close(); <-done }()
	client, err := net.Dial("udp", server.udpConn.LocalAddr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(3 * time.Second))
	for i := 0; i < 3; i++ {
		if _, err := client.Write([]byte("udp-data")); err != nil {
			t.Fatal(err)
		}
		buffer := make([]byte, 64)
		n, err := client.Read(buffer)
		if err != nil || string(buffer[:n]) != "udp-data" {
			t.Fatalf("UDP reply n=%d err=%v", n, err)
		}
	}
	// The WriteTo syscall may return to its caller just after the client read.
	deadline := time.Now().Add(time.Second)
	for server.trafficOut.Load() < 24 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if in, out, conns := server.trafficIn.Load(), server.trafficOut.Load(), server.trafficConns.Load(); in != 24 || out != 24 || conns != 1 {
		t.Fatalf("UDP counters %d/%d sessions=%d", in, out, conns)
	}
}
