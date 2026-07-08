package main

import (
	"bytes"
	"sync/atomic"
	"testing"
	"time"
)

func TestICMPEchoRequestChecksum(t *testing.T) {
	packet := buildICMPEchoRequest(8, 0x1234, 1)
	if got := icmpChecksum(packet); got != 0 {
		t.Fatalf("checksum should validate to zero, got %#x", got)
	}
}

func TestStripIPv4Header(t *testing.T) {
	header := make([]byte, 20)
	header[0] = 0x45
	body := []byte{0, 0, 0, 0, 0x12, 0x34, 0, 1}
	packet := append(header, body...)
	if got := stripIPv4Header(packet); !bytes.Equal(got, body) {
		t.Fatalf("unexpected stripped packet: %v", got)
	}
}

func TestCPUUsageFromTimes(t *testing.T) {
	cpuUsageMu.Lock()
	previousCPUTimes = cpuTimes{Idle: 100, Total: 200}
	previousCPUReady = true
	cpuUsageMu.Unlock()

	if got := cpuUsageFromTimes(cpuTimes{Idle: 125, Total: 300}); got != 75 {
		t.Fatalf("unexpected cpu usage: got %d want 75", got)
	}
}

func TestScheduleTCPingCollectionDoesNotBlockWhenBusy(t *testing.T) {
	atomic.StoreInt32(&tcpingCollectRunning, 1)
	defer atomic.StoreInt32(&tcpingCollectRunning, 0)

	started := time.Now()
	if !scheduleTCPingCollection(Config{}, nil, nil, nil, false) {
		t.Fatal("busy tcping collection should be treated as handled")
	}
	if elapsed := time.Since(started); elapsed > 50*time.Millisecond {
		t.Fatalf("busy tcping schedule blocked for %s", elapsed)
	}
}
