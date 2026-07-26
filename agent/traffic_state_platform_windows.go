//go:build windows

package main

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

func lockAgentStateFile(file *os.File) error {
	overlapped := new(windows.Overlapped)
	return windows.LockFileEx(
		windows.Handle(file.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0,
		1,
		0,
		overlapped,
	)
}

func unlockAgentStateFile(file *os.File) error {
	return windows.UnlockFileEx(windows.Handle(file.Fd()), 0, 1, 0, new(windows.Overlapped))
}

func replaceTrafficStateFile(source string, target string, stateDir string) error {
	from, err := windows.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	if err := windows.MoveFileEx(from, to, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH); err != nil {
		return err
	}
	return syncTrafficStateDirectoryAfterMutation(stateDir)
}

func removeTrafficStateFile(path string, stateDir string) error {
	from, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	tombstone, err := windows.UTF16PtrFromString(path + ".removed")
	if err != nil {
		return err
	}
	if err := windows.MoveFileEx(from, tombstone, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH); err != nil {
		if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
			return ensureTrafficStateDirectoryDurable(stateDir)
		}
		return err
	}
	if err := syncTrafficStateDirectoryAfterMutation(stateDir); err != nil {
		return err
	}
	_ = os.Remove(path + ".removed")
	return nil
}

// MoveFileEx with MOVEFILE_WRITE_THROUGH provides the required metadata
// durability on Windows. Keep this hook for shared ordering checks and tests.
func syncTrafficStateDirectory(string) error {
	return nil
}
