package main

import (
	"errors"
	"reflect"
	"testing"
)

func TestTrafficShutdownRequiresFreshAuthorization(t *testing.T) {
	failure := errors.New("test failure")
	for _, tc := range []struct {
		name       string
		commandErr error
		allowed    bool
		claimErr   error
		runErr     error
		wantRun    bool
		wantClaim  bool
		wantErr    error
	}{
		{name: "unsupported host", commandErr: failure, wantErr: failure},
		{name: "disabled or below threshold", wantClaim: true},
		{name: "network failure", claimErr: failure, wantClaim: true, wantErr: failure},
		{name: "allowed", allowed: true, wantRun: true, wantClaim: true},
		{name: "native command failure", allowed: true, runErr: failure, wantRun: true, wantClaim: true, wantErr: failure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			claimed, ran := false, false
			args := []string{"/test-only/systemctl", "poweroff"}
			err := runTrafficShutdown(func() ([]string, error) { return args, tc.commandErr }, func() (bool, error) {
				claimed = true
				return tc.allowed, tc.claimErr
			}, func(actual []string) error {
				ran = true
				if !reflect.DeepEqual(actual, args) {
					t.Fatalf("unexpected command: %v", actual)
				}
				return tc.runErr
			})
			if claimed != tc.wantClaim || ran != tc.wantRun || !errors.Is(err, tc.wantErr) {
				t.Fatalf("claim=%v run=%v err=%v", claimed, ran, err)
			}
		})
	}
}

func TestTrafficShutdownEmptyCommandFailsClosed(t *testing.T) {
	err := runTrafficShutdown(func() ([]string, error) { return nil, nil }, func() (bool, error) {
		t.Fatal("must not claim without a local command")
		return true, nil
	}, func([]string) error { t.Fatal("must not execute"); return nil })
	if err == nil {
		t.Fatal("expected an error")
	}
}
