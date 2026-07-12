package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParsePluginAgentManifestVersion(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    string
	}{
		{name: "generated manifest", content: `{"pluginVersion":"2.2.0"}`, want: "2.2.0"},
		{name: "standard manifest", content: `{"version":"1.4.3"}`, want: "1.4.3"},
		{name: "generated field wins", content: `{"version":"old","pluginVersion":"new"}`, want: "new"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := parsePluginAgentManifestVersion([]byte(test.content))
			if err != nil {
				t.Fatalf("parsePluginAgentManifestVersion() error = %v", err)
			}
			if got != test.want {
				t.Fatalf("parsePluginAgentManifestVersion() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestParsePluginAgentManifestVersionRejectsInvalidJSON(t *testing.T) {
	if _, err := parsePluginAgentManifestVersion([]byte(`{"pluginVersion":`)); err == nil {
		t.Fatal("parsePluginAgentManifestVersion() should reject invalid JSON")
	}
}

func TestInstalledPluginVersionsAt(t *testing.T) {
	root := t.TempDir()
	manifests := map[string]string{
		"generated-plugin": `{"pluginVersion":"2.2.0"}`,
		"standard-plugin":  `{"version":"1.4.3"}`,
		"invalid-plugin":   `{"pluginVersion":`,
	}
	for pluginID, content := range manifests {
		dir := filepath.Join(root, pluginID)
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}

	versions := installedPluginVersionsAt(root)
	if got := versions["generated-plugin"]; got != "2.2.0" {
		t.Fatalf("generated plugin version = %q, want 2.2.0", got)
	}
	if got := versions["standard-plugin"]; got != "1.4.3" {
		t.Fatalf("standard plugin version = %q, want 1.4.3", got)
	}
	if _, exists := versions["invalid-plugin"]; exists {
		t.Fatal("invalid plugin manifest should not be reported")
	}
}
