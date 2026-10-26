package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const agentLogRetentionDays = 3

func agentLogDayStart(now time.Time) time.Time {
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
}

func agentLogRetentionStart(now time.Time) time.Time {
	return agentLogDayStart(now).AddDate(0, 0, 1-agentLogRetentionDays)
}

func agentLogArchivePath(primary string, day time.Time) string {
	ext := filepath.Ext(primary)
	return strings.TrimSuffix(primary, ext) + "." + day.Format("2006-01-02") + ext
}

// Keep the active filename stable for tail -F, support bundles and installers.
// Call under agentLogMu before writes and from idle background maintenance.
func rotateAgentLogFile(primary string, now time.Time) error {
	info, err := os.Stat(primary)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || !agentLogDayStart(info.ModTime().In(now.Location())).Before(agentLogDayStart(now)) {
		return nil
	}
	archive := agentLogArchivePath(primary, info.ModTime().In(now.Location()))
	if _, err := os.Stat(archive); os.IsNotExist(err) {
		return os.Rename(primary, archive)
	} else if err != nil {
		return err
	}
	// Preserve both files when a restart/clock correction revisits a date.
	input, err := os.Open(primary)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(archive, os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if err := input.Close(); err != nil {
		return err
	}
	return os.Remove(primary)
}

func appendAgentDailyLog(primary string, now time.Time, line string) error {
	if err := os.MkdirAll(filepath.Dir(primary), 0755); err != nil {
		return err
	}
	if err := rotateAgentLogFile(primary, now); err != nil {
		return err
	}
	f, err := os.OpenFile(primary, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	_, writeErr := f.WriteString(line)
	info, _ := f.Stat()
	closeErr := f.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	if info != nil && info.Size() > agentLogMaxBytes {
		trimLogFileTail(primary, agentLogTailBytes)
	}
	return nil
}

func agentLogArchiveDay(primary string, candidate string, location *time.Location) (time.Time, bool) {
	ext := filepath.Ext(primary)
	prefix := strings.TrimSuffix(filepath.Base(primary), ext) + "."
	name := filepath.Base(candidate)
	if !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, ext) {
		return time.Time{}, false
	}
	day := strings.TrimSuffix(strings.TrimPrefix(name, prefix), ext)
	parsed, err := time.ParseInLocation("2006-01-02", day, location)
	return parsed, err == nil && parsed.Format("2006-01-02") == day
}

func reportAgentLogError(action string, err error) {
	// Do not recurse through logf if the log directory is unwritable.
	fmt.Fprintf(os.Stderr, "[ForwardX] Agent log %s failed: %v\n", action, err)
}
