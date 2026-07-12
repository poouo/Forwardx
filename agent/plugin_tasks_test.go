package main

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestFinalizePluginAgentTaskResultPreservesJSONErrorOnNonzeroExit(t *testing.T) {
	result := finalizePluginAgentTaskResult(
		pluginAgentTask{OutputType: "json"},
		pluginAgentTaskResult{Output: `{"错误信息":"省份规则应用失败","处理建议":"检查 nftables 规则","ruleId":17}`},
		errors.New("exit status 1"),
		false,
	)

	if result.Success {
		t.Fatal("nonzero script exit should fail the task")
	}
	if result.Error != "省份规则应用失败" {
		t.Fatalf("business error = %q", result.Error)
	}
	if result.Advice != "检查 nftables 规则" {
		t.Fatalf("business advice = %q", result.Advice)
	}
	if result.ProcessError != "exit status 1" {
		t.Fatalf("process error = %q", result.ProcessError)
	}
	data, ok := result.Data.(map[string]any)
	if !ok || data["ruleId"] != float64(17) {
		t.Fatalf("structured result data was not preserved: %#v", result.Data)
	}
}

func TestFinalizePluginAgentTaskResultKeepsProcessErrorForInvalidJSON(t *testing.T) {
	result := finalizePluginAgentTaskResult(
		pluginAgentTask{OutputType: "json"},
		pluginAgentTaskResult{Output: "not-json"},
		errors.New("exit status 2"),
		false,
	)

	if result.Error != "exit status 2" || result.ProcessError != "exit status 2" {
		t.Fatalf("invalid JSON should retain the process error: %#v", result)
	}
}

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
		"generated-plugin": `{"pluginVersion":"2.2.0","syncSignature":"sync-abc"}`,
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
	_, signatures := installedPluginInventoryAt(root)
	if got := signatures["generated-plugin"]; got != "sync-abc" {
		t.Fatalf("generated plugin sync signature = %q, want sync-abc", got)
	}
}

func TestPluginAgentTaskLockAllowsConcurrentReadsAndBlocksWrites(t *testing.T) {
	pluginAgentTaskLocksMu.Lock()
	pluginAgentTaskLocks = map[string]*sync.RWMutex{}
	pluginAgentTaskLocksMu.Unlock()

	releaseReadOne := acquirePluginAgentTaskLock(pluginAgentTask{PluginID: "demo", Intent: "read"})
	releaseReadTwo := acquirePluginAgentTaskLock(pluginAgentTask{PluginID: "demo", Intent: "read"})
	writeAcquired := make(chan struct{})
	go func() {
		releaseWrite := acquirePluginAgentTaskLock(pluginAgentTask{PluginID: "demo", Intent: "write"})
		close(writeAcquired)
		releaseWrite()
	}()

	select {
	case <-writeAcquired:
		releaseReadTwo()
		releaseReadOne()
		t.Fatal("write task acquired the plugin lock while read tasks were active")
	case <-time.After(30 * time.Millisecond):
	}

	releaseReadTwo()
	releaseReadOne()
	select {
	case <-writeAcquired:
	case <-time.After(time.Second):
		t.Fatal("write task did not acquire the plugin lock after reads completed")
	}
}
