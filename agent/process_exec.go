package main

import (
	"context"
	"fmt"
	"os/exec"
	"time"
)

func commandOutputWithTimeout(timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), normalizedCommandTimeout(timeout))
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).Output()
	if ctx.Err() == context.DeadlineExceeded {
		return out, fmt.Errorf("%s timed out after %s: %w", name, normalizedCommandTimeout(timeout), ctx.Err())
	}
	return out, err
}

func commandCombinedOutputWithTimeout(timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), normalizedCommandTimeout(timeout))
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return out, fmt.Errorf("%s timed out after %s: %w", name, normalizedCommandTimeout(timeout), ctx.Err())
	}
	return out, err
}

func normalizedCommandTimeout(timeout time.Duration) time.Duration {
	if timeout <= 0 {
		return 5 * time.Second
	}
	return timeout
}
