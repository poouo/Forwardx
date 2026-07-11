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

var pluginAgentTaskWorkersOnce sync.Once
var pluginAgentTaskQueue = make(chan pluginAgentTaskJob, pluginAgentTaskQueueCapacity)
var pluginAgentTaskSeenMu sync.Mutex
var pluginAgentTaskSeen = map[string]time.Time{}
var pluginAgentTaskIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

type pluginAgentTask struct {
	TaskID           string   `json:"taskId"`
	GroupID          string   `json:"groupId"`
	PluginID         string   `json:"pluginId"`
	PluginVersion    string   `json:"pluginVersion"`
	ActionID         string   `json:"actionId"`
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

type pluginAgentTaskResult struct {
	TaskID     string `json:"taskId"`
	GroupID    string `json:"groupId"`
	PluginID   string `json:"pluginId"`
	ActionID   string `json:"actionId"`
	Success    bool   `json:"success"`
	Output     string `json:"output,omitempty"`
	Stderr     string `json:"stderr,omitempty"`
	Data       any    `json:"data,omitempty"`
	ExitCode   *int   `json:"exitCode,omitempty"`
	TimedOut   bool   `json:"timedOut,omitempty"`
	DurationMs int    `json:"durationMs"`
	StartedAt  string `json:"startedAt,omitempty"`
	FinishedAt string `json:"finishedAt,omitempty"`
	Error      string `json:"error,omitempty"`
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
		for i := 0; i < 2; i++ {
			go pluginAgentTaskWorker()
		}
	})
}

func pluginAgentTaskWorker() {
	for job := range pluginAgentTaskQueue {
		result := runPluginAgentTask(job.task)
		reportPluginAgentTaskResult(job.cfg, result)
	}
}

func enqueuePluginAgentTask(cfg Config, task pluginAgentTask) {
	if err := validatePluginAgentTask(task); err != nil {
		reportPluginAgentTaskResult(cfg, invalidPluginAgentTaskResult(task, err))
		return
	}
	if !reservePluginAgentTask(task.TaskID) {
		return
	}
	select {
	case pluginAgentTaskQueue <- pluginAgentTaskJob{cfg: cfg, task: task}:
	default:
		reportPluginAgentTaskResult(cfg, invalidPluginAgentTaskResult(task, errors.New("插件任务队列已满，请稍后重试")))
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
	if len(task.Arguments) > 16 {
		return errors.New("插件任务参数过多")
	}
	for _, argument := range task.Arguments {
		if len(argument) > 2000 || strings.ContainsRune(argument, '\x00') {
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

func runPluginAgentTask(task pluginAgentTask) pluginAgentTaskResult {
	started := time.Now()
	result := pluginAgentTaskResult{
		TaskID:    task.TaskID,
		GroupID:   task.GroupID,
		PluginID:  task.PluginID,
		ActionID:  task.ActionID,
		StartedAt: started.Format(time.RFC3339Nano),
	}
	if err := validatePluginAgentTask(task); err != nil {
		return invalidPluginAgentTaskResult(task, err)
	}
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
	err = command.Run()
	result.Output = stdout.String()
	result.Stderr = stderr.String()
	result.DurationMs = int(time.Since(started).Milliseconds())
	result.FinishedAt = time.Now().Format(time.RFC3339Nano)
	result.TimedOut = ctx.Err() == context.DeadlineExceeded
	code := 0
	if err != nil {
		code = 1
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			code = exitError.ExitCode()
		}
		result.Error = err.Error()
	}
	if result.TimedOut {
		result.Error = "插件操作执行超时"
	}
	result.ExitCode = &code
	result.Success = err == nil && !result.TimedOut
	if result.Success && task.OutputType == "json" {
		if strings.TrimSpace(result.Output) == "" {
			result.Success = false
			result.Error = "插件操作未返回 JSON 数据"
		} else if err := json.Unmarshal([]byte(result.Output), &result.Data); err != nil {
			result.Success = false
			result.Error = "插件操作返回的 JSON 数据无效: " + err.Error()
		}
	}
	if !result.Success && result.Output == "" && result.Stderr != "" {
		result.Output = result.Stderr
	}
	return result
}

func reportPluginAgentTaskResult(cfg Config, result pluginAgentTaskResult) {
	if err := post(cfg, "/api/agent/plugin-action-result", map[string]any{"result": result}, &map[string]any{}); err != nil {
		if isTransientAgentCommError(err) {
			logAgentCommError("plugin-action-result", err)
		} else {
			logf("plugin action result report failed task=%s plugin=%s action=%s: %v", result.TaskID, result.PluginID, result.ActionID, err)
		}
	}
}
