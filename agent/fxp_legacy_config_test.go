package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFXPConfigUsesRemovedTrafficPadding(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want bool
	}{
		{name: "clean", raw: `{"role":"entry","transportVersion":"v1","listenPort":10001}`, want: false},
		{name: "enabled", raw: `{"trafficPaddingEnabled":true}`, want: true},
		{name: "enabled string", raw: `{"trafficPaddingEnabled":"yes"}`, want: true},
		{name: "ratio", raw: `{"entries":[{"trafficPaddingRatio":5}]}`, want: true},
		{name: "max", raw: `{"entries":[{"trafficPaddingMaxMbps":"1"}]}`, want: true},
		{name: "disabled zero", raw: `{"trafficPaddingEnabled":false,"trafficPaddingRatio":0,"trafficPaddingMaxMbps":0}`, want: false},
		{name: "disabled zero strings", raw: `{"trafficPaddingEnabled":"off","trafficPaddingRatio":"0.0","trafficPaddingMaxMbps":""}`, want: false},
		{name: "malformed json", raw: `{"trafficPaddingEnabled":true`, want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := fxpConfigUsesRemovedTrafficPadding([]byte(test.raw)); got != test.want {
				t.Fatalf("fxpConfigUsesRemovedTrafficPadding() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestFXPProcessMatchesCurrentRuntimeRejectsRemovedPaddingConfig(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "fxp-entry.json")
	if err := os.WriteFile(configPath, []byte(`{"trafficPaddingRatio":10}`), 0600); err != nil {
		t.Fatal(err)
	}
	process := &fxpProcess{configPath: configPath}
	if fxpProcessMatchesCurrentRuntime(process) {
		t.Fatal("FXP process with removed traffic-padding config was treated as current")
	}
}
