package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func writeConfigTestFile(t *testing.T, path string, value map[string]any) []byte {
	t.Helper()
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatalf("marshal config: %v", err)
	}
	raw = append(raw, '\n')
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatalf("create config directory: %v", err)
	}
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	return raw
}

func TestLoadConfigWithFallbackKeepsValidCanonicalConfig(t *testing.T) {
	root := t.TempDir()
	canonicalPath := filepath.Join(root, "canonical", "config.json")
	legacyPath := filepath.Join(root, "legacy", "config.json")
	canonicalRaw := writeConfigTestFile(t, canonicalPath, map[string]any{
		"panelUrl": "https://canonical.example.com",
		"token":    "canonical-token",
		"interval": 30,
	})
	writeConfigTestFile(t, legacyPath, map[string]any{
		"panelUrl": "https://legacy.example.com",
		"token":    "legacy-token",
		"interval": 2,
	})

	resolvedPath, cfg, migrated, err := loadConfigWithFallbackPaths(canonicalPath, canonicalPath, legacyPath)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if migrated {
		t.Fatal("valid canonical config must not be replaced by legacy config")
	}
	if resolvedPath != canonicalPath {
		t.Fatalf("resolved path = %q, want %q", resolvedPath, canonicalPath)
	}
	if cfg.PanelURL != "https://canonical.example.com" || cfg.Token != "canonical-token" || cfg.Interval != 30 {
		t.Fatalf("loaded unexpected canonical config: %+v", cfg)
	}
	after, err := os.ReadFile(canonicalPath)
	if err != nil {
		t.Fatalf("read canonical config: %v", err)
	}
	if string(after) != string(canonicalRaw) {
		t.Fatalf("canonical config was modified:\n%s", after)
	}
}

func TestLoadConfigWithFallbackMigratesLegacyWhenCanonicalMissing(t *testing.T) {
	root := t.TempDir()
	canonicalPath := filepath.Join(root, "canonical", "config.json")
	legacyPath := filepath.Join(root, "legacy", "config.json")
	legacyRaw := writeConfigTestFile(t, legacyPath, map[string]any{
		"panelUrl":    "https://legacy.example.com",
		"token":       "legacy-token",
		"interval":    30,
		"futureField": "preserved",
	})

	resolvedPath, cfg, migrated, err := loadConfigWithFallbackPaths(canonicalPath, canonicalPath, legacyPath)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if !migrated {
		t.Fatal("missing canonical config should be migrated from legacy config")
	}
	if resolvedPath != canonicalPath {
		t.Fatalf("resolved path = %q, want %q", resolvedPath, canonicalPath)
	}
	if cfg.PanelURL != "https://legacy.example.com" || cfg.Token != "legacy-token" || cfg.Interval != 30 {
		t.Fatalf("loaded unexpected legacy config: %+v", cfg)
	}
	canonicalRaw, err := os.ReadFile(canonicalPath)
	if err != nil {
		t.Fatalf("read migrated canonical config: %v", err)
	}
	if string(canonicalRaw) != string(legacyRaw) {
		t.Fatalf("migrated config did not preserve the complete legacy JSON:\n%s", canonicalRaw)
	}
}
