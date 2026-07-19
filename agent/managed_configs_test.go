package main

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestManagedConfigRejectsInvalidJSONWithoutReplacingLiveFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "runtime.json")
	if err := os.WriteFile(path, []byte(`{"services":[]}`), 0644); err != nil {
		t.Fatal(err)
	}
	_, err := applyManagedConfigs([]managedConfigSpec{{
		Path: path, Format: "json", ContentBase64: base64.StdEncoding.EncodeToString([]byte(`{"services":`)),
	}})
	if err == nil {
		t.Fatal("expected invalid JSON error")
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != `{"services":[]}` {
		t.Fatalf("live config changed: %s", raw)
	}
}

func TestManagedConfigRollbackRestoresPreviousContent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "runtime.json")
	if err := os.WriteFile(path, []byte(`{"version":1}`), 0644); err != nil {
		t.Fatal(err)
	}
	tx, err := applyManagedConfigs([]managedConfigSpec{{
		Path: path, Format: "json", ContentBase64: base64.StdEncoding.EncodeToString([]byte(`{"version":2}`)),
	}})
	if err != nil {
		t.Fatal(err)
	}
	if !tx.rollback() {
		t.Fatal("rollback failed")
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != `{"version":1}` {
		t.Fatalf("unexpected restored config: %s", raw)
	}
}

func TestManagedConfigBatchFailureRestoresEarlierFiles(t *testing.T) {
	dir := t.TempDir()
	certPath := filepath.Join(dir, "server.crt")
	configPath := filepath.Join(dir, "runtime.json")
	if err := os.WriteFile(certPath, []byte("old certificate"), 0644); err != nil {
		t.Fatal(err)
	}
	_, err := applyManagedConfigs([]managedConfigSpec{
		{
			Path: certPath, Format: "text", ContentBase64: base64.StdEncoding.EncodeToString([]byte("new certificate")),
		},
		{
			Path: configPath, Format: "json", ContentBase64: base64.StdEncoding.EncodeToString([]byte(`{"invalid":`)),
		},
	})
	if err == nil {
		t.Fatal("expected batch validation failure")
	}
	raw, readErr := os.ReadFile(certPath)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(raw) != "old certificate" {
		t.Fatalf("earlier file was not restored: %s", raw)
	}
}

func TestManagedConfigUsesRequestedFileMode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows does not expose POSIX permission bits consistently")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "server.key")
	_, err := applyManagedConfigs([]managedConfigSpec{{
		Path: path, Mode: 0600, Format: "text", ContentBase64: base64.StdEncoding.EncodeToString([]byte("private key")),
	}})
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if actual := info.Mode().Perm(); actual != 0600 {
		t.Fatalf("mode=%#o want=%#o", actual, os.FileMode(0600))
	}
}

func TestManagedConfigRejectsUnsafeFileMode(t *testing.T) {
	_, err := managedConfigFileMode(managedConfigSpec{Path: "/tmp/test", Mode: 01000})
	if err == nil {
		t.Fatal("expected invalid file mode error")
	}
}
