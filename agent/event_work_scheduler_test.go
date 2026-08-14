package main

import (
	"testing"
	"time"
)

func TestDesiredStatePushSchedulerCoalescesToLatestPendingSnapshot(t *testing.T) {
	processed := make(chan string, 3)
	releaseFirst := make(chan struct{})
	scheduler := newDesiredStatePushScheduler(func(_ Config, push agentDesiredStatePush) {
		marker := push.StateSignatures["marker"]
		processed <- marker
		if marker == "first" {
			<-releaseFirst
		}
	})

	scheduler.schedule(Config{}, agentDesiredStatePush{StateSignatures: map[string]string{"marker": "first"}})
	select {
	case marker := <-processed:
		if marker != "first" {
			t.Fatalf("first processed marker = %q", marker)
		}
	case <-time.After(time.Second):
		t.Fatal("first desired-state push did not start")
	}
	scheduler.schedule(Config{}, agentDesiredStatePush{StateSignatures: map[string]string{"marker": "superseded"}})
	scheduler.schedule(Config{}, agentDesiredStatePush{StateSignatures: map[string]string{"marker": "latest"}})
	close(releaseFirst)

	select {
	case marker := <-processed:
		if marker != "latest" {
			t.Fatalf("pending processed marker = %q, want latest", marker)
		}
	case <-time.After(time.Second):
		t.Fatal("latest desired-state push was not processed")
	}
	select {
	case marker := <-processed:
		t.Fatalf("superseded desired-state push was unexpectedly processed: %q", marker)
	case <-time.After(30 * time.Millisecond):
	}
}

func TestSupportBundleSchedulerSerializesAndDeduplicatesTasks(t *testing.T) {
	started := make(chan string, 3)
	releaseFirst := make(chan struct{})
	scheduler := newSupportBundleScheduler(func(_ Config, request supportBundleRequest) bool {
		started <- request.TaskID
		if request.TaskID == "task-first" {
			<-releaseFirst
		}
		return true
	})
	scheduler.retention = time.Hour

	if !scheduler.schedule(Config{}, supportBundleRequest{TaskID: "task-first"}) {
		t.Fatal("first support-bundle request was not accepted")
	}
	select {
	case taskID := <-started:
		if taskID != "task-first" {
			t.Fatalf("first support-bundle task = %q", taskID)
		}
	case <-time.After(time.Second):
		t.Fatal("first support-bundle request did not start")
	}
	if scheduler.schedule(Config{}, supportBundleRequest{TaskID: "task-first"}) {
		t.Fatal("duplicate active support-bundle request was accepted")
	}
	if !scheduler.schedule(Config{}, supportBundleRequest{TaskID: "task-second"}) {
		t.Fatal("distinct support-bundle request was not queued")
	}
	select {
	case taskID := <-started:
		t.Fatalf("support-bundle tasks overlapped: %q", taskID)
	case <-time.After(30 * time.Millisecond):
	}
	close(releaseFirst)
	select {
	case taskID := <-started:
		if taskID != "task-second" {
			t.Fatalf("second support-bundle task = %q", taskID)
		}
	case <-time.After(time.Second):
		t.Fatal("queued support-bundle request did not start")
	}

	deadline := time.Now().Add(time.Second)
	for {
		if !scheduler.schedule(Config{}, supportBundleRequest{TaskID: "task-second"}) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("completed support-bundle task was not retained for deduplication")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestSupportBundleSchedulerAllowsRetryAfterReportFailure(t *testing.T) {
	finished := make(chan struct{}, 2)
	scheduler := newSupportBundleScheduler(func(_ Config, _ supportBundleRequest) bool {
		finished <- struct{}{}
		return false
	})
	request := supportBundleRequest{TaskID: "retry-task"}
	if !scheduler.schedule(Config{}, request) {
		t.Fatal("initial support-bundle request was not accepted")
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("initial support-bundle request did not finish")
	}
	deadline := time.Now().Add(time.Second)
	for !scheduler.schedule(Config{}, request) {
		if time.Now().After(deadline) {
			t.Fatal("failed support-bundle report remained permanently deduplicated")
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("support-bundle retry did not run")
	}
}
