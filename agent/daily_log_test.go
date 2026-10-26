package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAgentDailyLogRotationAndThreeCalendarDayCleanup(t *testing.T) {
	dir := t.TempDir()
	primary := filepath.Join(dir, "agent-go.log")
	zone := time.FixedZone("test", 8*3600)
	now := time.Date(2026, 10, 26, 12, 0, 0, 0, zone)
	for daysAgo := 4; daysAgo >= 0; daysAgo-- {
		at := now.AddDate(0, 0, -daysAgo)
		if err := appendAgentDailyLog(primary, at, at.Format(time.RFC3339)+" day="+at.Format("2006-01-02")+"\n"); err != nil {
			t.Fatal(err)
		}
		// The test clock differs from the filesystem clock.
		if err := os.Chtimes(primary, at, at); err != nil {
			t.Fatal(err)
		}
	}
	limits := logPruneLimits{fileMaxBytes: 8192, fileTailBytes: 4096, retention: 72 * time.Hour}
	pruneLogDirectory(dir, primary, now, true, limits)
	files, err := filepath.Glob(filepath.Join(dir, "*.log"))
	if err != nil || len(files) != 3 {
		t.Fatalf("expected today + 2 archives, got %v, err=%v", files, err)
	}
	for daysAgo := 0; daysAgo < 3; daysAgo++ {
		at := now.AddDate(0, 0, -daysAgo)
		name := primary
		if daysAgo > 0 {
			name = agentLogArchivePath(primary, at)
		}
		raw, err := os.ReadFile(name)
		if err != nil || !strings.Contains(string(raw), "day="+at.Format("2006-01-02")) {
			t.Fatalf("missing retained day=%s raw=%q err=%v", at, raw, err)
		}
	}
}

func TestAgentDailyLogExistingArchiveIsNotOverwritten(t *testing.T) {
	dir := t.TempDir()
	primary := filepath.Join(dir, "agent-go.log")
	now := time.Date(2026, 10, 26, 0, 0, 1, 0, time.Local)
	yesterday := now.AddDate(0, 0, -1)
	archive := agentLogArchivePath(primary, yesterday)
	if err := os.WriteFile(archive, []byte("earlier\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(primary, []byte("later\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(primary, yesterday, yesterday); err != nil {
		t.Fatal(err)
	}
	if err := appendAgentDailyLog(primary, now, "today\n"); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(archive)
	if string(raw) != "earlier\nlater\n" {
		t.Fatalf("archive lost records: %q", raw)
	}
	raw, _ = os.ReadFile(primary)
	if string(raw) != "today\n" {
		t.Fatalf("active file contains old day: %q", raw)
	}
}

func TestAgentLogCalendarRetentionHonorsMidnightAndDST(t *testing.T) {
	zone, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("timezone database not installed")
	}
	now := time.Date(2026, 11, 2, 12, 0, 0, 0, zone)
	want := time.Date(2026, 10, 31, 0, 0, 0, 0, zone)
	if !agentLogRetentionStart(now).Equal(want) {
		t.Fatalf("calendar cutoff=%v want=%v", agentLogRetentionStart(now), want)
	}
	path := filepath.Join(t.TempDir(), "agent-go.log")
	content := want.Add(-time.Second).Format(time.RFC3339) + " expired\n" + want.Format(time.RFC3339) + " retained\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, now, now); err != nil {
		t.Fatal(err)
	}
	pruneAgentLocalLogFile(path, now, true, logPruneLimits{fileMaxBytes: 8192, retention: 72 * time.Hour})
	raw, _ := os.ReadFile(path)
	if strings.Contains(string(raw), "expired") || !strings.Contains(string(raw), "retained") {
		t.Fatalf("incorrect midnight boundary: %q", raw)
	}
}
