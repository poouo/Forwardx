package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"sync/atomic"
	"time"
)

var trafficShutdownInFlight atomic.Bool

func trafficShutdownSupported() bool {
	return runtime.GOOS == "linux" && os.Geteuid() == 0
}

func trafficShutdownCommand() ([]string, error) {
	if !trafficShutdownSupported() {
		return nil, fmt.Errorf("traffic shutdown requires a root Linux Agent")
	}
	if info, err := os.Stat("/run/systemd/system"); err == nil && info.IsDir() {
		if path, err := exec.LookPath("systemctl"); err == nil {
			return []string{path, "poweroff"}, nil
		}
	}
	for _, name := range []string{"shutdown", "poweroff"} {
		if path, err := exec.LookPath(name); err == nil {
			if name == "shutdown" {
				return []string{path, "-h", "now"}, nil
			}
			return []string{path}, nil
		}
	}
	return nil, fmt.Errorf("no supported shutdown command found")
}

// Resolve a fixed local command before claiming. Never execute a command or
// arguments supplied by the panel. Errors/denials fail closed, with no retry
// after authorization: the persisted panel latch prevents power-off loops.
func runTrafficShutdown(command func() ([]string, error), claim func() (bool, error), run func([]string) error) error {
	args, err := command()
	if err != nil {
		return err
	}
	if len(args) == 0 {
		return fmt.Errorf("empty shutdown command")
	}
	allowed, err := claim()
	if err != nil || !allowed {
		return err
	}
	return run(args)
}

func handleTrafficShutdownCheck(cfg Config, requested bool) {
	if !requested || !trafficShutdownInFlight.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer trafficShutdownInFlight.Store(false)
		err := runTrafficShutdown(trafficShutdownCommand, func() (bool, error) {
			var response struct {
				Allowed bool `json:"allowed"`
			}
			err := post(cfg, "/api/agent/traffic-shutdown-claim", map[string]any{}, &response)
			return response.Allowed, err
		}, func(args []string) error {
			logf("[HostTrafficShutdown] traffic threshold reached; powering off host")
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			output, err := exec.CommandContext(ctx, args[0], args[1:]...).CombinedOutput()
			if err != nil {
				return fmt.Errorf("shutdown command failed: %w (%s)", err, output)
			}
			return nil
		})
		if err != nil && shouldLogAgentReport("traffic-shutdown-error", time.Minute) {
			logf("[HostTrafficShutdown] %v; check host permissions and re-enable the switch to rearm", err)
		}
	}()
}
