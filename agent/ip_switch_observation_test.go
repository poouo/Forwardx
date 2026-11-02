package main

import (
	"testing"
	"time"
)

func TestPublicIPSwitchObservationIsBounded(t *testing.T) {
	now := time.Now()
	if got := publicIPRefreshIntervalFor(now, now.Add(time.Minute)); got != 10*time.Second {
		t.Fatalf("active observation interval=%v", got)
	}
	for _, expired := range []time.Time{{}, now, now.Add(-time.Second)} {
		if got := publicIPRefreshIntervalFor(now, expired); got != publicIPRefreshInterval {
			t.Fatalf("expired observation interval=%v", got)
		}
	}
}
