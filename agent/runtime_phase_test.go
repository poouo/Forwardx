package main

import (
	"testing"
	"time"
)

func TestPrepareDesiredActionJobsAddsSharedRuntimePhase(t *testing.T) {
	portDone := make(chan struct{})
	pluginDone := make(chan struct{})
	nginxDone := make(chan struct{})
	gostDone := make(chan struct{})
	jobs := []actionJob{
		{action: action{StatusType: "rule", ForwardType: "forwardx", SourcePort: 9911}, done: portDone},
		{action: action{StatusType: "runtime", ForwardType: "plugin-sync:test"}, done: pluginDone},
		{action: action{StatusType: "runtime", ForwardType: "nginx-runtime-sync"}, done: nginxDone},
		{action: action{StatusType: "runtime", ForwardType: "gost-runtime-sync"}, done: gostDone},
	}

	prepared := prepareDesiredActionJobs(jobs)
	if len(prepared) != 4 {
		t.Fatalf("prepared jobs = %d, want 4", len(prepared))
	}
	if !isSharedRuntimeSyncAction(prepared[0].action) || !isSharedRuntimeSyncAction(prepared[1].action) {
		t.Fatalf("shared runtime jobs were not placed first: %#v", prepared)
	}
	var pluginJob actionJob
	var portJob actionJob
	for _, job := range prepared[2:] {
		if job.action.ForwardType == "plugin-sync:test" {
			pluginJob = job
		} else if job.action.ForwardType == "forwardx" {
			portJob = job
		}
	}
	if len(pluginJob.prerequisites) != 0 {
		t.Fatalf("unrelated plugin prerequisites = %d, want 0", len(pluginJob.prerequisites))
	}
	if len(portJob.prerequisites) != 2 {
		t.Fatalf("port prerequisites = %d, want 2", len(portJob.prerequisites))
	}

	released := make(chan struct{})
	go func() {
		waitForActionPrerequisites(portJob)
		close(released)
	}()
	close(nginxDone)
	select {
	case <-released:
		t.Fatal("port job was released before all shared runtimes completed")
	case <-time.After(20 * time.Millisecond):
	}
	close(gostDone)
	select {
	case <-released:
	case <-time.After(time.Second):
		t.Fatal("port job did not resume after shared runtimes completed")
	}
}

func TestForcedRuntimeSyncCannotBeAdoptedFromOldSuccessRecord(t *testing.T) {
	forced := action{StatusType: "runtime", ForwardType: "nginx-runtime-sync", ForceRuntimeSync: true}
	if desiredActionRecordConsistent(forced, nil) {
		t.Fatal("forced runtime reconciliation was treated as already consistent")
	}
	ordinary := action{StatusType: "runtime", ForwardType: "nginx-runtime-sync"}
	if !desiredActionRecordConsistent(ordinary, nil) {
		t.Fatal("ordinary runtime action lost its idempotent record behavior")
	}
}
