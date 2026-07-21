package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPruneLogDirectoryCapsEachFileAndDirectoryTotal(t *testing.T) {
	dir := t.TempDir()
	primary := filepath.Join(dir, "agent-go.log")
	paths := []string{primary}
	for i := 0; i < 8; i++ {
		paths = append(paths, filepath.Join(dir, fmt.Sprintf("runtime-%d.log", i)))
	}
	for _, path := range paths {
		content := strings.Repeat("2026-07-21T12:00:00+08:00 noisy runtime line\n", 80)
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}

	limits := logPruneLimits{
		fileMaxBytes:    2048,
		fileTailBytes:   1024,
		minimumTail:     256,
		directoryMax:    4096,
		directoryTarget: 3072,
		retention:       72 * time.Hour,
	}
	pruneLogDirectory(dir, primary, time.Now(), false, limits)

	var total int64
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Size() > limits.fileMaxBytes {
			t.Fatalf("%s remained above file limit: %d", filepath.Base(path), info.Size())
		}
		total += info.Size()
	}
	if total > limits.directoryTarget {
		t.Fatalf("log directory remained above target: got=%d target=%d", total, limits.directoryTarget)
	}
	if info, err := os.Stat(primary); err != nil || info.Size() == 0 {
		t.Fatalf("primary Agent log tail was not retained: info=%v err=%v", info, err)
	}
}

func TestPruneAgentLocalLogFileUnderstandsRuntimeTimestamp(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime.log")
	now := time.Date(2026, 7, 21, 12, 0, 0, 0, time.Local)
	content := strings.Join([]string{
		"2026/07/16 12:00:00.000000 old runtime line",
		"2026/07/21 11:59:00.000000 current runtime line",
		"line without a timestamp",
		"",
	}, "\n")
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	limits := logPruneLimits{
		fileMaxBytes:  2048,
		fileTailBytes: 1024,
		retention:     72 * time.Hour,
	}
	pruneAgentLocalLogFile(path, now, true, limits)

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	got := string(raw)
	if strings.Contains(got, "old runtime line") {
		t.Fatalf("expired runtime log line was retained: %q", got)
	}
	if !strings.Contains(got, "current runtime line") || !strings.Contains(got, "line without a timestamp") {
		t.Fatalf("current or unparseable log line was removed: %q", got)
	}
}
