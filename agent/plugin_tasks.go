package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const pluginAgentTaskRoot = "/var/lib/forwardx-agent/plugins"
const pluginAgentTaskQueueCapacity = 64
const pluginAgentTaskOutputLimit = 256 * 1024
const pluginAgentTaskRetention = 24 * time.Hour
const pluginAgentResultQueueCapacity = 256
const pluginAgentResultReportAttempts = 12
const pluginAgentManifestSyncWait = 10 * time.Second
const pluginAgentManifestPollInterval = 100 * time.Millisecond
const pluginAgentTaskWorkerConcurrency = 4
const pluginAgentResultWorkerConcurrency = 4

var pluginAgentTaskWorkersOnce sync.Once
var pluginAgentTaskQueue = make(chan pluginAgentTaskJob, pluginAgentTaskQueueCapacity)
var pluginAgentResultQueue = make(chan pluginAgentTaskResultJob, pluginAgentResultQueueCapacity)
var pluginAgentTaskSeenMu sync.Mutex
var pluginAgentTaskSeen = map[string]time.Time{}
var pluginAgentTaskLocksMu sync.Mutex
var pluginAgentTaskLocks = map[string]*sync.RWMutex{}
var pluginAgentTaskIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

type pluginAgentTask struct {
	TaskID           string   `json:"taskId"`
	GroupID          string   `json:"groupId"`
	PluginID         string   `json:"pluginId"`
	PluginVersion    string   `json:"pluginVersion"`
	ActionID         string   `json:"actionId"`
	Intent           string   `json:"intent"`
	ContextID        string   `json:"contextId,omitempty"`
	Executor         string   `json:"executor"`
	Interpreter      string   `json:"interpreter"`
	WorkingDirectory string   `json:"workingDirectory"`
	Entry            string   `json:"entry"`
	Arguments        []string `json:"arguments"`
	TimeoutMs        int      `json:"timeoutMs"`
	OutputType       string   `json:"outputType"`
	CreatedAt        string   `json:"createdAt"`
}

type pluginAgentTaskJob struct {
	cfg  Config
	task pluginAgentTask
}

type pluginAgentTaskResultJob struct {
	cfg    Config
	result pluginAgentTaskResult
}

type pluginAgentTaskResult struct {
	TaskID       string `json:"taskId"`
	GroupID      string `json:"groupId"`
	PluginID     string `json:"pluginId"`
	ActionID     string `json:"actionId"`
	Success      bool   `json:"success"`
	Output       string `json:"output,omitempty"`
	Stderr       string `json:"stderr,omitempty"`
	Data         any    `json:"data,omitempty"`
	ExitCode     *int   `json:"exitCode,omitempty"`
	TimedOut     bool   `json:"timedOut,omitempty"`
	DurationMs   int    `json:"durationMs"`
	StartedAt    string `json:"startedAt,omitempty"`
	FinishedAt   string `json:"finishedAt,omitempty"`
	Error        string `json:"error,omitempty"`
	ErrorDetail  string `json:"errorDetail,omitempty"`
	Advice       string `json:"advice,omitempty"`
	ProcessError string `json:"processError,omitempty"`
}

type pluginAgentManifest struct {
	Version       string `json:"version"`
	PluginVersion string `json:"pluginVersion"`
	SyncSignature string `json:"syncSignature"`
}

type pluginAgentTaskOutput struct {
	buffer    bytes.Buffer
	limit     int
	truncated bool
}

func (output *pluginAgentTaskOutput) Write(data []byte) (int, error) {
	remaining := output.limit - output.buffer.Len()
	if remaining > 0 {
		if len(data) > remaining {
			_, _ = output.buffer.Write(data[:remaining])
			output.truncated = true
		} else {
			_, _ = output.buffer.Write(data)
		}
	} else if len(data) > 0 {
		output.truncated = true
	}
	return len(data), nil
}

func (output *pluginAgentTaskOutput) String() string {
	text := strings.TrimSpace(output.buffer.String())
	if output.truncated {
		if text != "" {
			text += "\n"
		}
		text += "[输出已截断]"
	}
	return text
}

func startPluginAgentTaskWorkers() {
	pluginAgentTaskWorkersOnce.Do(func() {
		for i := 0; i < pluginAgentTaskWorkerConcurrency; i++ {
			go pluginAgentTaskWorker()
		}
		for i := 0; i < pluginAgentResultWorkerConcurrency; i++ {
			go pluginAgentTaskResultWorker()
		}
	})
}

func acquirePluginAgentTaskLock(task pluginAgentTask) func() {
	pluginAgentTaskLocksMu.Lock()
	lock := pluginAgentTaskLocks[task.PluginID]
	if lock == nil {
		lock = &sync.RWMutex{}
		pluginAgentTaskLocks[task.PluginID] = lock
	}
	pluginAgentTaskLocksMu.Unlock()
	if strings.TrimSpace(task.Intent) == "read" {
		lock.RLock()
		return lock.RUnlock
	}
	lock.Lock()
	return lock.Unlock
}

func pluginAgentTaskWorker() {
	for job := range pluginAgentTaskQueue {
		result := runPluginAgentTask(job.task)
		enqueuePluginAgentTaskResult(job.cfg, result)
	}
}

func pluginAgentTaskResultWorker() {
	for job := range pluginAgentResultQueue {
		reportPluginAgentTaskResult(job.cfg, job.result)
	}
}

func enqueuePluginAgentTaskResult(cfg Config, result pluginAgentTaskResult) {
	select {
	case pluginAgentResultQueue <- pluginAgentTaskResultJob{cfg: cfg, result: result}:
	case <-time.After(2 * time.Second):
		logf("plugin action result queue full task=%s plugin=%s action=%s", result.TaskID, result.PluginID, result.ActionID)
	}
}

func enqueuePluginAgentTask(cfg Config, task pluginAgentTask) {
	if err := validatePluginAgentTask(task); err != nil {
		enqueuePluginAgentTaskResult(cfg, invalidPluginAgentTaskResult(task, err))
		return
	}
	if !reservePluginAgentTask(task.TaskID) {
		return
	}
	select {
	case pluginAgentTaskQueue <- pluginAgentTaskJob{cfg: cfg, task: task}:
	default:
		enqueuePluginAgentTaskResult(cfg, invalidPluginAgentTaskResult(task, errors.New("插件任务队列已满，请稍后重试")))
	}
}

func reservePluginAgentTask(taskID string) bool {
	now := time.Now()
	pluginAgentTaskSeenMu.Lock()
	defer pluginAgentTaskSeenMu.Unlock()
	for id, seenAt := range pluginAgentTaskSeen {
		if now.Sub(seenAt) > pluginAgentTaskRetention {
			delete(pluginAgentTaskSeen, id)
		}
	}
	if _, exists := pluginAgentTaskSeen[taskID]; exists {
		return false
	}
	pluginAgentTaskSeen[taskID] = now
	return true
}

func validatePluginAgentTask(task pluginAgentTask) error {
	for _, value := range []string{task.TaskID, task.GroupID, task.PluginID, task.ActionID} {
		if !pluginAgentTaskIDPattern.MatchString(strings.TrimSpace(value)) {
			return errors.New("插件任务标识不合法")
		}
	}
	if task.Executor != "script" {
		return errors.New("不支持的插件执行器")
	}
	if task.Interpreter != "bash" && task.Interpreter != "sh" && task.Interpreter != "python3" {
		return errors.New("不支持的插件解释器")
	}
	if task.OutputType != "json" && task.OutputType != "text" {
		return errors.New("不支持的插件输出类型")
	}
	if intent := strings.TrimSpace(task.Intent); intent != "" && intent != "read" && intent != "write" && intent != "execute" {
		return errors.New("不支持的插件操作类型")
	}
	if len(task.Arguments) > 16 {
		return errors.New("插件任务参数过多")
	}
	for _, argument := range task.Arguments {
		if len(argument) > 24*1024 || strings.ContainsRune(argument, '\x00') {
			return errors.New("插件任务参数不合法")
		}
	}
	workingDirectory := filepath.Clean(strings.TrimSpace(task.WorkingDirectory))
	pluginDirectory := filepath.Join(pluginAgentTaskRoot, task.PluginID)
	if workingDirectory != pluginDirectory && !strings.HasPrefix(workingDirectory, pluginDirectory+string(os.PathSeparator)) {
		return errors.New("插件任务目录不在受控路径内")
	}
	entry := filepath.Clean(strings.TrimSpace(task.Entry))
	if entry == "." || filepath.IsAbs(entry) || strings.HasPrefix(entry, ".."+string(os.PathSeparator)) || entry == ".." {
		return errors.New("插件入口路径不合法")
	}
	entryPath := filepath.Join(workingDirectory, entry)
	if entryPath != pluginDirectory && !strings.HasPrefix(entryPath, pluginDirectory+string(os.PathSeparator)) {
		return errors.New("插件入口不在受控路径内")
	}
	return nil
}

func pluginAgentTaskTimeout(task pluginAgentTask) time.Duration {
	value := task.TimeoutMs
	if value <= 0 {
		value = 15000
	}
	if value < 1000 {
		value = 1000
	}
	if value > 60000 {
		value = 60000
	}
	return time.Duration(value) * time.Millisecond
}

func parsePluginAgentManifestVersion(content []byte) (string, error) {
	var manifest pluginAgentManifest
	if err := json.Unmarshal(content, &manifest); err != nil {
		return "", err
	}
	if version := strings.TrimSpace(manifest.PluginVersion); version != "" {
		return version, nil
	}
	return strings.TrimSpace(manifest.Version), nil
}

func installedPluginInventory() (map[string]string, map[string]string) {
	return installedPluginInventoryAt(pluginAgentTaskRoot)
}

func installedPluginVersionsAt(root string) map[string]string {
	versions, _ := installedPluginInventoryAt(root)
	return versions
}

func installedPluginInventoryAt(root string) (map[string]string, map[string]string) {
	versions := map[string]string{}
	signatures := map[string]string{}
	entries, err := os.ReadDir(root)
	if err != nil {
		return versions, signatures
	}
	for _, entry := range entries {
		pluginID := strings.TrimSpace(entry.Name())
		if !entry.IsDir() || !pluginAgentTaskIDPattern.MatchString(pluginID) {
			continue
		}
		content, err := os.ReadFile(filepath.Join(root, pluginID, "manifest.json"))
		if err != nil {
			continue
		}
		var manifest pluginAgentManifest
		if err := json.Unmarshal(content, &manifest); err != nil {
			continue
		}
		version := strings.TrimSpace(manifest.PluginVersion)
		if version == "" {
			version = strings.TrimSpace(manifest.Version)
		}
		if version != "" {
			versions[pluginID] = version
			if signature := strings.TrimSpace(manifest.SyncSignature); signature != "" {
				signatures[pluginID] = signature
			}
		}
	}
	return versions, signatures
}

func validatePluginAgentTaskVersion(task pluginAgentTask) error {
	expected := strings.TrimSpace(task.PluginVersion)
	if expected == "" {
		return nil
	}
	manifestPath := filepath.Join(pluginAgentTaskRoot, task.PluginID, "manifest.json")
	deadline := time.Now().Add(pluginAgentManifestSyncWait)
	var actual string
	var lastErr error
	for {
		content, err := os.ReadFile(manifestPath)
		if err == nil {
			actual, lastErr = parsePluginAgentManifestVersion(content)
			if lastErr == nil && actual == expected {
				return nil
			}
		} else {
			lastErr = err
		}
		if !time.Now().Before(deadline) {
			if lastErr != nil {
				return fmt.Errorf("插件尚未同步或 manifest 不可用: %w", lastErr)
			}
			return fmt.Errorf("插件版本不一致: Agent=%s 面板=%s", actual, expected)
		}
		time.Sleep(pluginAgentManifestPollInterval)
	}
}

func invalidPluginAgentTaskResult(task pluginAgentTask, err error) pluginAgentTaskResult {
	now := time.Now().Format(time.RFC3339Nano)
	message := "插件任务无效"
	if err != nil {
		message = err.Error()
	}
	code := 1
	return pluginAgentTaskResult{
		TaskID:     task.TaskID,
		GroupID:    task.GroupID,
		PluginID:   task.PluginID,
		ActionID:   task.ActionID,
		Success:    false,
		Output:     message,
		ExitCode:   &code,
		StartedAt:  now,
		FinishedAt: now,
		Error:      message,
	}
}

func pluginAgentTaskJSONText(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(typed)
	case bool, float64, json.Number:
		return fmt.Sprint(typed)
	default:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(encoded))
	}
}

func pluginAgentTaskJSONField(data any, keys ...string) string {
	object, ok := data.(map[string]any)
	if !ok {
		return ""
	}
	for _, key := range keys {
		for actualKey, value := range object {
			if strings.EqualFold(strings.TrimSpace(actualKey), key) {
				if text := pluginAgentTaskJSONText(value); text != "" {
					return text
				}
			}
		}
	}
	for _, containerKey := range []string{"data", "result", "details"} {
		for actualKey, value := range object {
			if strings.EqualFold(strings.TrimSpace(actualKey), containerKey) {
				if text := pluginAgentTaskJSONField(value, keys...); text != "" {
					return text
				}
			}
		}
	}
	return ""
}

func pluginAgentTaskBusinessDetails(data any) (message string, advice string, detail string) {
	message = pluginAgentTaskJSONField(data,
		"error", "errorMessage", "message", "detail", "reason",
		"错误", "错误信息", "原因",
	)
	advice = pluginAgentTaskJSONField(data,
		"suggestion", "advice", "resolution", "hint",
		"处理建议", "建议", "解决方案",
	)
	encoded, err := json.Marshal(data)
	if err == nil {
		detail = strings.TrimSpace(string(encoded))
		if len(detail) > 4000 {
			detail = detail[:4000] + "..."
		}
	}
	return message, advice, detail
}

func finalizePluginAgentTaskResult(
	task pluginAgentTask,
	result pluginAgentTaskResult,
	commandErr error,
	timedOut bool,
) pluginAgentTaskResult {
	code := 0
	if commandErr != nil {
		code = 1
		var exitError *exec.ExitError
		if errors.As(commandErr, &exitError) {
			code = exitError.ExitCode()
		}
		result.ProcessError = commandErr.Error()
	}
	result.TimedOut = timedOut
	result.ExitCode = &code
	result.Success = commandErr == nil && !timedOut
	if timedOut {
		result.Error = "插件操作执行超时"
	}

	if task.OutputType == "json" {
		if strings.TrimSpace(result.Output) == "" {
			if result.Success {
				result.Success = false
				result.Error = "插件操作未返回 JSON 数据"
			}
		} else {
			var data any
			if decodeErr := json.Unmarshal([]byte(result.Output), &data); decodeErr != nil {
				if result.Success {
					result.Success = false
					result.Error = "插件操作返回的 JSON 数据无效: " + decodeErr.Error()
				}
			} else {
				result.Data = data
				if !result.Success {
					message, advice, detail := pluginAgentTaskBusinessDetails(data)
					if message != "" {
						result.Error = message
					}
					result.Advice = advice
					result.ErrorDetail = detail
				}
			}
		}
	}

	if !result.Success && result.Error == "" {
		result.Error = result.ProcessError
		if result.Error == "" {
			result.Error = strings.TrimSpace(result.Stderr)
		}
		if result.Error == "" {
			result.Error = strings.TrimSpace(result.Output)
		}
		if result.Error == "" {
			result.Error = "插件操作执行失败"
		}
	}
	if !result.Success && result.Output == "" && result.Stderr != "" {
		result.Output = result.Stderr
	}
	return result
}

func runPluginAgentTask(task pluginAgentTask) pluginAgentTaskResult {
	receivedAt := time.Now()
	result := pluginAgentTaskResult{
		TaskID:    task.TaskID,
		GroupID:   task.GroupID,
		PluginID:  task.PluginID,
		ActionID:  task.ActionID,
		StartedAt: receivedAt.Format(time.RFC3339Nano),
	}
	if err := validatePluginAgentTask(task); err != nil {
		return invalidPluginAgentTaskResult(task, err)
	}
	if err := validatePluginAgentTaskVersion(task); err != nil {
		return invalidPluginAgentTaskResult(task, err)
	}
	releasePluginLock := acquirePluginAgentTaskLock(task)
	defer releasePluginLock()
	entryPath := filepath.Join(filepath.Clean(task.WorkingDirectory), filepath.Clean(task.Entry))
	info, err := os.Stat(entryPath)
	if err != nil || info.IsDir() {
		if err == nil {
			err = errors.New("插件入口不是文件")
		}
		return invalidPluginAgentTaskResult(task, fmt.Errorf("插件入口不可用: %w", err))
	}
	ctx, cancel := context.WithTimeout(context.Background(), pluginAgentTaskTimeout(task))
	defer cancel()
	commandArgs := append([]string{entryPath}, task.Arguments...)
	command := exec.CommandContext(ctx, task.Interpreter, commandArgs...)
	command.Dir = filepath.Clean(task.WorkingDirectory)
	command.Env = append(os.Environ(),
		"FORWARDX_PLUGIN_ID="+task.PluginID,
		"FORWARDX_PLUGIN_ACTION_ID="+task.ActionID,
	)
	stdout := &pluginAgentTaskOutput{limit: pluginAgentTaskOutputLimit}
	stderr := &pluginAgentTaskOutput{limit: pluginAgentTaskOutputLimit}
	command.Stdout = stdout
	command.Stderr = stderr
	executionStartedAt := time.Now()
	result.StartedAt = executionStartedAt.Format(time.RFC3339Nano)
	err = command.Run()
	result.Output = stdout.String()
	result.Stderr = stderr.String()
	result.DurationMs = int(time.Since(executionStartedAt).Milliseconds())
	result.FinishedAt = time.Now().Format(time.RFC3339Nano)
	return finalizePluginAgentTaskResult(task, result, err, ctx.Err() == context.DeadlineExceeded)
}

func reportPluginAgentTaskResult(cfg Config, result pluginAgentTaskResult) {
	delay := time.Second
	for attempt := 1; attempt <= pluginAgentResultReportAttempts; attempt++ {
		err := post(cfg, "/api/agent/plugin-action-result", map[string]any{"result": result}, &map[string]any{})
		if err == nil {
			return
		}
		if !isTransientAgentCommError(err) || attempt == pluginAgentResultReportAttempts {
			logf("plugin action result report failed task=%s plugin=%s action=%s attempt=%d/%d: %v", result.TaskID, result.PluginID, result.ActionID, attempt, pluginAgentResultReportAttempts, err)
			return
		}
		logAgentCommError("plugin-action-result", err)
		time.Sleep(delay)
		if delay < 16*time.Second {
			delay *= 2
		}
	}
}
