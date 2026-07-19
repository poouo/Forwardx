package main

import "testing"

func TestNormalizeFXPSpecExitStrategies(t *testing.T) {
	for _, strategy := range []string{"fallback", "random", "ip_hash", "round_robin"} {
		spec := normalizeFXPSpec(fxpSpec{ExitStrategy: strategy})
		if spec.ExitStrategy != strategy {
			t.Fatalf("strategy %q normalized to %q", strategy, spec.ExitStrategy)
		}
	}
	if spec := normalizeFXPSpec(fxpSpec{ExitStrategy: "none"}); spec.ExitStrategy != "round_robin" {
		t.Fatalf("unsupported strategy normalized to %q", spec.ExitStrategy)
	}
}
