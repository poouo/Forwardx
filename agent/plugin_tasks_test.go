package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestPluginAgentTaskResultIsPersistedAtomically(t *testing.T) {
	previousRoot := pluginAgentResultRoot
	pluginAgentResultRoot = t.TempDir()
	defer func() { pluginAgentResultRoot = previousRoot }()

	result := pluginAgentTaskResult{TaskID: "task-17", PluginID: "demo", ActionID: "refresh", Success: true}
	if err := persistPluginAgentTaskResult(result); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(pluginAgentTaskResultPath(result.TaskID))
	if err != nil {
		t.Fatal(err)
	}
	var restored pluginAgentTaskResult
	if err := json.Unmarshal(data, &restored); err != nil {
		t.Fatal(err)
	}
	if restored.TaskID != result.TaskID || restored.PluginID != result.PluginID || !restored.Success {
		t.Fatalf("unexpected restored result: %#v", restored)
	}
}

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
		{name: "current manifest", content: `{"version":"2.2.0"}`, want: "2.2.0"},
		{name: "legacy field is ignored", content: `{"pluginVersion":"1.4.3"}`, want: ""},
		{name: "current field wins", content: `{"version":"new","pluginVersion":"old"}`, want: "new"},
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
	if _, err := parsePluginAgentManifestVersion([]byte(`{"version":`)); err == nil {
		t.Fatal("parsePluginAgentManifestVersion() should reject invalid JSON")
	}
}

func TestValidatePluginAgentTaskVersionRequiresVersion(t *testing.T) {
	if err := validatePluginAgentTaskVersion(pluginAgentTask{}); err == nil {
		t.Fatal("validatePluginAgentTaskVersion() should reject a missing task version")
	}
}

func TestValidatePluginAgentTaskEnvironmentReportsMissingInterpreter(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	err := validatePluginAgentTaskEnvironment(pluginAgentTask{Interpreter: "python3"})
	if err == nil || !strings.Contains(err.Error(), "缺少插件解释器 python3") {
		t.Fatalf("missing interpreter error = %v", err)
	}
}

func TestInstalledPluginVersionsAt(t *testing.T) {
	root := t.TempDir()
	manifests := map[string]string{
		"current-plugin": `{"version":"2.2.0","syncSignature":"sync-abc"}`,
		"legacy-plugin":  `{"pluginVersion":"1.4.3"}`,
		"invalid-plugin": `{"version":`,
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
	if got := versions["current-plugin"]; got != "2.2.0" {
		t.Fatalf("current plugin version = %q, want 2.2.0", got)
	}
	if _, exists := versions["legacy-plugin"]; exists {
		t.Fatal("legacy pluginVersion-only manifest should not be reported")
	}
	if _, exists := versions["invalid-plugin"]; exists {
		t.Fatal("invalid plugin manifest should not be reported")
	}
	_, signatures := installedPluginInventoryAt(root)
	if got := signatures["current-plugin"]; got != "sync-abc" {
		t.Fatalf("current plugin sync signature = %q, want sync-abc", got)
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
