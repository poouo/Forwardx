package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func speedTestPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	return port
}
func speedTestSession(t *testing.T) *linkSpeedSession {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	s := &linkSpeedSession{ctx: ctx, cancel: cancel}
	t.Cleanup(s.close)
	return s
}

func TestLinkSpeedTCPTraversesEveryHopAndReportsReceiverBytes(t *testing.T) {
	session := speedTestSession(t)
	receiver, relay, entry := speedTestPort(t), speedTestPort(t), speedTestPort(t)
	task := linkSpeedTask{Protocol: "tcp", Token: strings.Repeat("ab", 32), Duration: 1, RateMbps: 8, Target: net.JoinHostPort("127.0.0.1", strconv.Itoa(entry))}
	for _, component := range []linkSpeedComponent{
		{Kind: "receiver", Port: receiver, ListenHost: "127.0.0.1"},
		{Kind: "proxy", Port: relay, ListenHost: "127.0.0.1", Target: net.JoinHostPort("127.0.0.1", strconv.Itoa(receiver))},
		{Kind: "proxy", Port: entry, ListenHost: "127.0.0.1", Target: net.JoinHostPort("127.0.0.1", strconv.Itoa(relay))},
	} {
		if err := prepareLinkSpeedComponent(Config{}, session, task, component); err != nil {
			t.Fatal(err)
		}
	}
	var samples []speedSample
	upload, download, err := runLinkSpeed(session.ctx, task, func(sample speedSample) { samples = append(samples, sample) }, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, result := range []speedMeasurement{upload, download} {
		if result.Bytes < 500_000 || result.Mbps < 3 || result.Mbps > 14 || result.DurationMs < 900 {
			t.Fatalf("unexpected measured rate: %+v", result)
		}
	}
	if len(samples) < 12 {
		t.Fatalf("missing live updates: %d", len(samples))
	}
	session.close()
	if conn, err := net.DialTimeout("tcp", task.Target, 100*time.Millisecond); err == nil {
		conn.Close()
		t.Fatal("cancelled session retained its listener")
	}
}
func TestLinkSpeedUDPTraversesEveryHopInBothDirections(t *testing.T) {
	session := speedTestSession(t)
	receiver, relay, entry := speedTestPort(t), speedTestPort(t), speedTestPort(t)
	task := linkSpeedTask{Protocol: "udp", Token: strings.Repeat("ac", 32), Duration: 1, RateMbps: 5, Target: net.JoinHostPort("127.0.0.1", strconv.Itoa(entry))}
	for _, component := range []linkSpeedComponent{
		{Kind: "receiver", Port: receiver, ListenHost: "127.0.0.1"},
		{Kind: "proxy", Port: relay, ListenHost: "127.0.0.1", Target: net.JoinHostPort("127.0.0.1", strconv.Itoa(receiver))},
		{Kind: "proxy", Port: entry, ListenHost: "127.0.0.1", Target: net.JoinHostPort("127.0.0.1", strconv.Itoa(relay))},
	} {
		if err := prepareLinkSpeedComponent(Config{}, session, task, component); err != nil {
			t.Fatal(err)
		}
	}
	counts := map[string]int{}
	upload, download, err := runLinkSpeed(session.ctx, task, func(sample speedSample) { counts[sample.Direction]++ }, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, result := range []speedMeasurement{upload, download} {
		if result.Bytes < 200_000 || result.SentPackets < 200 || result.Mbps < 1 || result.Mbps > 8 {
			t.Fatalf("unexpected UDP measurement: %+v", result)
		}
		if result.Packets+result.LostPackets != result.SentPackets {
			t.Fatalf("invalid packet accounting: %+v", result)
		}
	}
	if counts["upload"] < 6 || counts["download"] < 6 {
		t.Fatalf("missing live updates: %+v", counts)
	}
}

func TestLinkSpeedSampleBatchesFlushInOrderAndAtEnd(t *testing.T) {
	updates := make(chan speedSample, 70)
	for i := 0; i < 70; i++ {
		updates <- speedSample{ElapsedMs: int64(i * 100)}
	}
	close(updates)
	var received []speedSample
	var sizes []int
	reportSpeedSamples(updates, time.Hour, func(batch []speedSample) {
		sizes = append(sizes, len(batch))
		received = append(received, batch...)
	})
	if len(sizes) != 2 || sizes[0] != 64 || sizes[1] != 6 || len(received) != 70 {
		t.Fatalf("missing final batch: %v", sizes)
	}
	for i, sample := range received {
		if sample.ElapsedMs != int64(i*100) {
			t.Fatalf("out of order point: %+v", sample)
		}
	}
}

func TestLinkSpeedSampleBatchesFlushWhileRunning(t *testing.T) {
	updates := make(chan speedSample, 5)
	for i := 0; i < 5; i++ {
		updates <- speedSample{ElapsedMs: int64(i * 100)}
	}
	count := 0
	reportSpeedSamples(updates, 10*time.Millisecond, func(batch []speedSample) {
		count += len(batch)
		close(updates) // A timer flush must occur before producer completion.
	})
	if count != 5 {
		t.Fatalf("expected one batch with all five measured points, got %d", count)
	}
}
func TestLinkSpeedUDPCountsDuplicatesReorderingAndLoss(t *testing.T) {
	task := linkSpeedTask{RateMbps: 10, Duration: 1}
	stats := newSpeedUDPStats(task)
	for _, seq := range []uint64{2, 1, 2, 4, 4} {
		stats.record(seq, time.Now().UnixNano(), 100, "source")
	}
	result := stats.result(6, 1000)
	if result.Packets != 3 || result.Bytes != 300 || result.LostPackets != 3 || result.LossPercent != 50 {
		t.Fatalf("wrong receive accounting: %+v", result)
	}
	if stats.record(5, time.Now().UnixNano(), 100, "other-source") {
		t.Fatal("accepted another source")
	}
	if stats.record(1<<63, 0, 100, "source") {
		t.Fatal("accepted unbounded sequence")
	}
	token, _ := hex.DecodeString(strings.Repeat("aa", 32))
	other, _ := hex.DecodeString(strings.Repeat("bb", 32))
	if validSpeedUDP(speedUDPPacket(other, 'D', 0, 0, nil), token) || validSpeedUDP([]byte("short"), token) {
		t.Fatal("accepted unauthenticated UDP control")
	}
}
func TestLinkSpeedRejectsInvalidLeaseAndLimits(t *testing.T) {
	valid := linkSpeedTask{TaskID: strings.Repeat("a", 36), JobID: strings.Repeat("b", 36), Token: strings.Repeat("ac", 32), Protocol: "udp", Duration: 10, RateMbps: 100, ExpiresAt: time.Now().Add(time.Minute).UnixMilli(), Op: "prepare"}
	if err := validateLinkSpeedTask(valid); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*linkSpeedTask){func(v *linkSpeedTask) { v.Duration = 0 }, func(v *linkSpeedTask) { v.RateMbps = 1001 }, func(v *linkSpeedTask) { v.ExpiresAt = 1 }, func(v *linkSpeedTask) { v.Op = "shell" }, func(v *linkSpeedTask) { v.Protocol = "ucp" }} {
		bad := valid
		change(&bad)
		if validateLinkSpeedTask(bad) == nil {
			t.Fatalf("accepted invalid task: %+v", bad)
		}
	}
}

func TestLinkSpeedV2NormalizesUDPPortsBeforePreparingWireGuard(t *testing.T) {
	previous := resolveFXPRuntimeExecutable
	resolveFXPRuntimeExecutable = func() (string, error) { return filepath.Join(t.TempDir(), "missing-fxp"), nil }
	t.Cleanup(func() { resolveFXPRuntimeExecutable = previous })
	for _, protocol := range []string{"tcp", "udp"} {
		t.Run(protocol, func(t *testing.T) {
			const tunnelID = 98712
			runtime := newTestIsolatedWireGuardRuntime(t, tunnelID, "100.119.0.1")
			defer runtime.close()
			setTestWireGuardRuntime(t, tunnelID, runtime)
			session := speedTestSession(t)
			port := speedTestPort(t)
			spec, err := json.Marshal(fxpSpec{Role: "exit", TransportVersion: "v2", TunnelID: tunnelID, ListenPort: port, Protocol: protocol})
			if err != nil {
				t.Fatal(err)
			}
			err = prepareLinkSpeedComponent(Config{}, session, linkSpeedTask{JobID: "normalization-test", Protocol: protocol}, linkSpeedComponent{Kind: "fxp", Port: port, Config: spec})
			if err == nil || !strings.Contains(err.Error(), "启动测速转发组件失败") {
				t.Fatalf("expected to reach native process start after preparing WireGuard, got %v", err)
			}
			runtime.mu.RLock()
			inbound := len(runtime.inbound)
			runtime.mu.RUnlock()
			if inbound != 1 {
				t.Fatalf("missing normalized inbound proxy: %d", inbound)
			}
			session.close()
			runtime.mu.RLock()
			remaining := len(runtime.inbound)
			runtime.mu.RUnlock()
			if remaining != 0 {
				t.Fatalf("failed speed session leaked inbound proxies: %d", remaining)
			}
		})
	}
}

func TestLinkSpeedActualRuntimePaths(t *testing.T) {
	directory := os.Getenv("FORWARDX_SPEED_FIXTURES_DIR")
	if directory == "" {
		t.Skip("set FORWARDX_SPEED_FIXTURES_DIR to run planner/runtime integration tests")
	}
	previousGost, previousFXP := resolveLinkSpeedRuntime, resolveFXPRuntimeExecutable
	resolveLinkSpeedRuntime = func() string { return os.Getenv("FORWARDX_SPEED_RUNTIME_TEST_BIN") }
	resolveFXPRuntimeExecutable = func() (string, error) { return os.Getenv("FORWARDX_SPEED_FXP_TEST_BIN"), nil }
	t.Cleanup(func() { resolveLinkSpeedRuntime = previousGost; resolveFXPRuntimeExecutable = previousFXP })
	files, err := filepath.Glob(filepath.Join(directory, "*.json"))
	if err != nil || len(files) == 0 {
		t.Fatalf("missing integration fixtures: %v", err)
	}
	for _, file := range files {
		t.Run(filepath.Base(file), func(t *testing.T) {
			var fixture struct {
				Task       linkSpeedTask        `json:"task"`
				Components []linkSpeedComponent `json:"components"`
			}
			raw, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			if err = json.Unmarshal(raw, &fixture); err != nil {
				t.Fatal(err)
			}
			session := speedTestSession(t)
			for _, component := range fixture.Components {
				if err := prepareLinkSpeedComponent(Config{}, session, fixture.Task, component); err != nil {
					t.Fatal(err)
				}
			}
			upload, download, err := runLinkSpeed(session.ctx, fixture.Task, func(speedSample) {}, nil)
			if err != nil {
				t.Fatal(err)
			}
			if upload.Bytes < 100000 || download.Bytes < 100000 {
				t.Fatalf("incomplete payload: upload=%+v download=%+v", upload, download)
			}
		})
	}
}

func TestLinkSpeedFrameSizeFollowsRateLimit(t *testing.T) {
	for rate, want := range map[float64]int{0: 65536, 0.1: 1024, 1: 6250, 5: 31250, 11: 65536, 1000: 65536} {
		if got := speedFrameSize(rate); got != want {
			t.Fatalf("rate %v Mbps: frame %d, want %d", rate, got, want)
		}
	}
}
