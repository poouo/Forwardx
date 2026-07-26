package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const agentStateLockFile = "forwardx-agent.lock"

type agentStateLock struct {
	file *os.File
}

func acquireAgentStateLock(stateDir string) (*agentStateLock, error) {
	stateDir = strings.TrimSpace(stateDir)
	if stateDir == "" {
		return nil, fmt.Errorf("Agent state directory is empty")
	}
	if err := os.MkdirAll(stateDir, 0755); err != nil {
		return nil, fmt.Errorf("create Agent state directory: %w", err)
	}
	path := filepath.Join(stateDir, agentStateLockFile)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, fmt.Errorf("open Agent state lock: %w", err)
	}
	if err := lockAgentStateFile(file); err != nil {
		owner := ""
		if raw, readErr := os.ReadFile(path); readErr == nil {
			owner = strings.TrimSpace(string(raw))
		}
		_ = file.Close()
		if owner != "" {
			return nil, fmt.Errorf("another ForwardX Agent is already using %s (pid %s): %w", stateDir, owner, err)
		}
		return nil, fmt.Errorf("another ForwardX Agent is already using %s: %w", stateDir, err)
	}
	lock := &agentStateLock{file: file}
	if err := file.Truncate(0); err != nil {
		_ = lock.Close()
		return nil, fmt.Errorf("initialize Agent state lock: %w", err)
	}
	if _, err := file.Seek(0, 0); err != nil {
		_ = lock.Close()
		return nil, fmt.Errorf("initialize Agent state lock: %w", err)
	}
	if _, err := file.WriteString(strconv.Itoa(os.Getpid()) + "\n"); err != nil {
		_ = lock.Close()
		return nil, fmt.Errorf("record Agent state lock owner: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = lock.Close()
		return nil, fmt.Errorf("persist Agent state lock owner: %w", err)
	}
	return lock, nil
}

func (lock *agentStateLock) Close() error {
	if lock == nil || lock.file == nil {
		return nil
	}
	file := lock.file
	lock.file = nil
	unlockErr := unlockAgentStateFile(file)
	closeErr := file.Close()
	if unlockErr != nil {
		return unlockErr
	}
	return closeErr
}
