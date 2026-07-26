//go:build !windows

package main

import (
	"os"

	"golang.org/x/sys/unix"
)

func lockAgentStateFile(file *os.File) error {
	return unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
}

func unlockAgentStateFile(file *os.File) error {
	return unix.Flock(int(file.Fd()), unix.LOCK_UN)
}

func replaceTrafficStateFile(source string, target string, stateDir string) error {
	if err := os.Rename(source, target); err != nil {
		return err
	}
	return syncTrafficStateDirectoryAfterMutation(stateDir)
}

func removeTrafficStateFile(path string, stateDir string) error {
	if err := os.Remove(path); err != nil {
		if os.IsNotExist(err) {
			return ensureTrafficStateDirectoryDurable(stateDir)
		}
		return err
	}
	return syncTrafficStateDirectoryAfterMutation(stateDir)
}

func syncTrafficStateDirectory(stateDir string) error {
	directory, err := os.Open(stateDir)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
