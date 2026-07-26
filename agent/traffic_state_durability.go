package main

import "sync/atomic"

var (
	trafficStateDirectoryDirty atomic.Bool
	trafficStateDirectorySync  = syncTrafficStateDirectory
)

func syncTrafficStateDirectoryAfterMutation(stateDir string) error {
	trafficStateDirectoryDirty.Store(true)
	if err := trafficStateDirectorySync(stateDir); err != nil {
		return err
	}
	trafficStateDirectoryDirty.Store(false)
	return nil
}

func ensureTrafficStateDirectoryDurable(stateDir string) error {
	if !trafficStateDirectoryDirty.Load() {
		return nil
	}
	if err := trafficStateDirectorySync(stateDir); err != nil {
		return err
	}
	trafficStateDirectoryDirty.Store(false)
	return nil
}
