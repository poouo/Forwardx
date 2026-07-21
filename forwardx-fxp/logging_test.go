package main

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestBoundedLogWriterDropsFloodAndReportsSuppression(t *testing.T) {
	var output bytes.Buffer
	now := time.Date(2026, 7, 21, 12, 0, 0, 0, time.UTC)
	writer := newBoundedLogWriter(&output, time.Minute, 12)
	writer.now = func() time.Time { return now }

	if n, err := writer.Write([]byte("first-line\n")); err != nil || n != len("first-line\n") {
		t.Fatalf("first write n=%d err=%v", n, err)
	}
	if n, err := writer.Write([]byte("overflow\n")); err != nil || n != len("overflow\n") {
		t.Fatalf("suppressed write n=%d err=%v", n, err)
	}
	if strings.Contains(output.String(), "overflow") {
		t.Fatalf("rate-limited line reached destination: %q", output.String())
	}

	now = now.Add(time.Minute)
	_, _ = writer.Write([]byte("next\n"))
	got := output.String()
	if !strings.Contains(got, "suppressed=1") || !strings.Contains(got, "next") {
		t.Fatalf("suppression summary or next window line missing: %q", got)
	}
}

func TestCompactRuntimeLogLineLimitsSingleWrite(t *testing.T) {
	line := compactRuntimeLogLine([]byte(strings.Repeat("x", 8192)), 128)
	if len(line) != 128 {
		t.Fatalf("compacted line length=%d want=128", len(line))
	}
	if !strings.HasSuffix(string(line), "... [truncated]\n") {
		t.Fatalf("compacted line missing suffix: %q", line)
	}
}

func TestBoundedLogWriterCapsHighVolumeWithinWindow(t *testing.T) {
	var output bytes.Buffer
	now := time.Date(2026, 7, 21, 12, 0, 0, 0, time.UTC)
	writer := newBoundedLogWriter(&output, time.Minute, 64*1024)
	writer.now = func() time.Time { return now }
	line := []byte(strings.Repeat("x", 1023) + "\n")

	for i := 0; i < 100_000; i++ {
		if _, err := writer.Write(line); err != nil {
			t.Fatal(err)
		}
	}
	if output.Len() > 64*1024 {
		t.Fatalf("high-volume output exceeded window cap: %d", output.Len())
	}
	if writer.suppressed == 0 {
		t.Fatal("expected high-volume writes to be suppressed")
	}
}
