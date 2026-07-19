package main

import (
	"sync"
	"testing"
	"time"
)

func TestWaitForWaitGroupTracksSessionDrain(t *testing.T) {
	var group sync.WaitGroup
	group.Add(1)
	go func() {
		time.Sleep(10 * time.Millisecond)
		group.Done()
	}()
	if !waitForWaitGroup(&group, 200*time.Millisecond) {
		t.Fatal("expected active session to drain")
	}
}

func TestWaitForWaitGroupHonorsTimeout(t *testing.T) {
	var group sync.WaitGroup
	group.Add(1)
	if waitForWaitGroup(&group, 10*time.Millisecond) {
		t.Fatal("expected drain timeout")
	}
	group.Done()
}
