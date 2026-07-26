package main

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

const (
	agentStateLockTestModeEnv = "FORWARDX_AGENT_STATE_LOCK_TEST_MODE"
	agentStateLockTestDirEnv  = "FORWARDX_AGENT_STATE_LOCK_TEST_DIR"
)

func TestAgentStateLockExcludesAnotherProcess(t *testing.T) {
	if mode := os.Getenv(agentStateLockTestModeEnv); mode != "" {
		runAgentStateLockHelper(t, mode)
		return
	}

	stateDir := t.TempDir()
	lock, err := acquireAgentStateLock(stateDir)
	if err != nil {
		t.Fatalf("acquire parent Agent state lock: %v", err)
	}
	if output, err := runAgentStateLockProcess(stateDir, "blocked"); err != nil {
		_ = lock.Close()
		t.Fatalf("second process lock check failed: %v\n%s", err, output)
	}
	if err := lock.Close(); err != nil {
		t.Fatalf("release parent Agent state lock: %v", err)
	}
	if output, err := runAgentStateLockProcess(stateDir, "available"); err != nil {
		t.Fatalf("released lock was not reusable: %v\n%s", err, output)
	}
}

func runAgentStateLockHelper(t *testing.T, mode string) {
	t.Helper()
	stateDir := os.Getenv(agentStateLockTestDirEnv)
	lock, err := acquireAgentStateLock(stateDir)
	switch mode {
	case "blocked":
		if err == nil {
			_ = lock.Close()
			t.Fatal("second process unexpectedly acquired the Agent state lock")
		}
		if !strings.Contains(err.Error(), "another ForwardX Agent") {
			t.Fatalf("second process received an unclear lock error: %v", err)
		}
	case "available":
		if err != nil {
			t.Fatalf("acquire released Agent state lock: %v", err)
		}
		if err := lock.Close(); err != nil {
			t.Fatalf("release child Agent state lock: %v", err)
		}
	default:
		t.Fatalf("unknown Agent state lock helper mode %q", mode)
	}
}

func runAgentStateLockProcess(stateDir string, mode string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestAgentStateLockExcludesAnotherProcess$")
	cmd.Env = append(os.Environ(),
		agentStateLockTestModeEnv+"="+mode,
		agentStateLockTestDirEnv+"="+stateDir,
	)
	return cmd.CombinedOutput()
}
