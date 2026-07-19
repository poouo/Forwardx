package main

import (
	"errors"
	"testing"
	"time"
)

func TestInvalidateMimicEnvironmentCache(t *testing.T) {
	mimicEnvironmentMu.Lock()
	mimicEnvironmentCached = mimicEnvironmentReport{Available: true, Status: "ready"}
	mimicEnvironmentCheckedAt = time.Now()
	mimicEnvironmentMu.Unlock()

	invalidateMimicEnvironmentCache()

	mimicEnvironmentMu.Lock()
	defer mimicEnvironmentMu.Unlock()
	if !mimicEnvironmentCheckedAt.IsZero() || mimicEnvironmentCached.Status != "" {
		t.Fatalf("mimic environment cache was not invalidated: checkedAt=%v report=%+v", mimicEnvironmentCheckedAt, mimicEnvironmentCached)
	}
}

func TestInspectMimicEnvironmentUnsupportedOS(t *testing.T) {
	report := inspectMimicEnvironment("windows", func(string) bool { return true }, func() bool { return false }, func(string, ...string) (string, error) {
		return "", nil
	})
	if report.Available || report.Status != "unsupported-os" {
		t.Fatalf("unexpected report: %+v", report)
	}
}

func TestInspectMimicEnvironmentMissingCommand(t *testing.T) {
	report := inspectMimicEnvironment("linux", func(name string) bool { return name != "mimic" }, func() bool { return false }, func(string, ...string) (string, error) {
		return "", nil
	})
	if report.Available || report.Status != "command-missing" {
		t.Fatalf("unexpected report: %+v", report)
	}
}

func TestInspectMimicEnvironmentMissingModule(t *testing.T) {
	report := inspectMimicEnvironment("linux", func(name string) bool {
		return name == "mimic" || name == "modprobe"
	}, func() bool { return false }, func(name string, args ...string) (string, error) {
		if name == "mimic" {
			return "mimic 0.7.1", nil
		}
		return "module mimic not found", errors.New("exit status 1")
	})
	if report.Available || report.Status != "kernel-module-missing" || !report.CommandReady {
		t.Fatalf("unexpected report: %+v", report)
	}
}

func TestInspectMimicEnvironmentReady(t *testing.T) {
	report := inspectMimicEnvironment("linux", func(name string) bool {
		return name == "mimic" || name == "modprobe"
	}, func() bool { return false }, func(name string, args ...string) (string, error) {
		if name == "mimic" {
			return "mimic 0.7.1", nil
		}
		return "", nil
	})
	if !report.Available || report.Status != "ready" || !report.CommandReady || !report.ModuleReady {
		t.Fatalf("unexpected report: %+v", report)
	}
}
