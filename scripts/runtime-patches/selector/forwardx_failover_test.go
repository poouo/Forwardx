package selector

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/go-gost/core/chain"
	"github.com/go-gost/x/metadata"
)

func TestForwardXFailoverDoesNotReinstateExpiredFailures(t *testing.T) {
	ctx := context.Background()
	primary, fallback := chain.NewNode("primary", "127.0.0.1:1"), chain.NewNode("fallback", "127.0.0.1:2")
	s := ForwardXFailoverNodeSelector(1, time.Nanosecond)
	if s.Select(ctx, primary, fallback) != primary {
		t.Fatal("initial selection must respect configured order")
	}
	primary.Marker().Mark()
	// Marker time uses whole seconds, so its exclusion has already expired.
	for i := 0; i < 1000; i++ {
		if s.Select(ctx, primary, fallback) != fallback {
			t.Fatal("timer expiry must not send business traffic back to a failed primary")
		}
	}
	primary.Marker().Reset()
	if s.Select(ctx, primary, fallback) != primary {
		t.Fatal("independently confirmed recovery must restore priority")
	}
}

func TestForwardXFailoverAllDownNeverBypassesHop(t *testing.T) {
	a, b := chain.NewNode("a", ":1"), chain.NewNode("b", ":2")
	a.Marker().Mark()
	b.Marker().Mark()
	for _, timeout := range []time.Duration{time.Hour, time.Nanosecond} {
		s := ForwardXFailoverNodeSelector(1, timeout)
		seen := map[*chain.Node]bool{}
		for i := 0; i < 2; i++ {
			n := s.Select(context.Background(), a, b)
			if n == nil {
				t.Fatal("nil silently bypasses a required upstream hop")
			}
			seen[n] = true
		}
		if len(seen) != 2 {
			t.Fatal("all-down retries must rotate candidates")
		}
		// A successful real connection resets its marker upstream.
		b.Marker().Reset()
		if s.Select(context.Background(), a, b) != b {
			t.Fatal("recovered fallback must immediately serve subsequent traffic")
		}
		b.Marker().Mark()
	}
}

func TestForwardXFailoverBackupAndFailureThreshold(t *testing.T) {
	ctx := context.Background()
	a := chain.NewNode("primary", ":1", chain.MetadataNodeOption(metadata.NewMetadata(map[string]any{"maxFails": 2})))
	b := chain.NewNode("backup", ":2", chain.MetadataNodeOption(metadata.NewMetadata(map[string]any{"backup": true})))
	s := ForwardXFailoverNodeSelector(1, time.Second)
	a.Marker().Mark()
	if s.Select(ctx, a, b) != a {
		t.Fatal("node-specific failure threshold must be respected")
	}
	a.Marker().Mark()
	if s.Select(ctx, a, b) != b {
		t.Fatal("healthy backup must outrank a known-failed primary")
	}
	if s.Select(ctx, nil, b) != b || s.Select(ctx) != nil {
		t.Fatal("empty/nil nodes must be safe")
	}
}

func TestForwardXFailoverConcurrentSelections(t *testing.T) {
	a, b := chain.NewNode("a", ":1"), chain.NewNode("b", ":2")
	a.Marker().Mark()
	s := ForwardXFailoverNodeSelector(1, time.Nanosecond)
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 1000; j++ {
				if s.Select(context.Background(), a, b) != b {
					t.Error("concurrent selection retried a dead primary")
					return
				}
			}
		}()
	}
	wg.Wait()
}
