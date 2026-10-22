package main

// SPDX-License-Identifier: AGPL-3.0-only
// BBR operations run in a short-lived Agent subprocess, never through an interpreter.
import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"
)

const bbrPreset = "net.core.default_qdisc = fq\nnet.ipv4.tcp_congestion_control = bbr\n"

var bbrGUIKeys = strings.Fields("net.ipv4.tcp_congestion_control net.core.default_qdisc net.ipv4.tcp_rmem net.ipv4.tcp_wmem net.core.rmem_max net.core.wmem_max net.ipv4.tcp_mtu_probing net.ipv4.tcp_fastopen net.ipv4.tcp_slow_start_after_idle net.ipv4.tcp_no_metrics_save net.core.somaxconn net.core.netdev_max_backlog")
var bbrTCPKey = regexp.MustCompile(`^net\.ipv4\.tcp_[a-z0-9_]+$`)
var bbrConfigLine = regexp.MustCompile(`^([a-z0-9_.]+)\s*=\s*([a-zA-Z0-9_.:/+ \t-]+)$`)

func pluginAgentExecutable() string {
	// The running executable remains addressable even after an upgrade replaces its path.
	if runtime.GOOS == "linux" {
		return fmt.Sprintf("/proc/%d/exe", os.Getpid())
	}
	path, _ := os.Executable()
	return path
}

func bbrSupportedKey(key string) bool {
	if bbrTCPKey.MatchString(key) {
		return true
	}
	for _, name := range strings.Fields("default_qdisc somaxconn rmem_max wmem_max rmem_default wmem_default optmem_max netdev_max_backlog netdev_budget netdev_budget_usecs") {
		if key == "net.core."+name {
			return true
		}
	}
	return false
}

func bbrNormalize(value string) string { return strings.Join(strings.Fields(value), " ") }

type bbrEntry struct{ key, value string }

func parseBBRConfig(text string) ([]bbrEntry, error) {
	if len(text) > 12000 || !utf8.ValidString(text) {
		return nil, errors.New("配置必须为 UTF-8 文本且不能超过 12000 字节")
	}
	var entries []bbrEntry
	seen := map[string]bool{}
	for index, line := range strings.Split(text, "\n") {
		clean := strings.TrimSpace(strings.SplitN(line, "#", 2)[0])
		if clean == "" || strings.HasPrefix(clean, ";") {
			continue
		}
		match := bbrConfigLine.FindStringSubmatch(clean)
		if match == nil || !bbrSupportedKey(match[1]) || bbrNormalize(match[2]) == "" {
			return nil, fmt.Errorf("第 %d 行不是受支持的 TCP / 队列参数", index+1)
		}
		if seen[match[1]] {
			return nil, fmt.Errorf("第 %d 行参数重复：%s", index+1, match[1])
		}
		seen[match[1]] = true
		entries = append(entries, bbrEntry{match[1], bbrNormalize(match[2])})
	}
	if len(entries) == 0 {
		return nil, errors.New("请至少填写一个参数")
	}
	return entries, nil
}

type bbrBackend interface {
	read(string) (string, error)
	write(string, string) error
	prepare([]bbrEntry) error
	qdiscs() string
}

type bbrLinuxBackend struct{}

func (bbrLinuxBackend) read(key string) (string, error) {
	if !bbrSupportedKey(key) && key != "net.ipv4.tcp_available_congestion_control" {
		return "", errors.New("不支持的参数：" + key)
	}
	data, err := os.ReadFile("/proc/sys/" + strings.ReplaceAll(key, ".", "/"))
	return bbrNormalize(string(data)), err
}

func (bbrLinuxBackend) write(key, value string) error {
	entries, err := parseBBRConfig(key + "=" + value)
	if err != nil || len(entries) != 1 {
		return errors.New("不支持的参数或值：" + key)
	}
	// procfs is the kernel sysctl interface: no Python, procps or shell execution.
	file, err := os.OpenFile("/proc/sys/"+strings.ReplaceAll(key, ".", "/"), os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = io.WriteString(file, value+"\n")
	return err
}

func bbrCommand(name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, name, args...).Output()
}

func (backend bbrLinuxBackend) prepare(entries []bbrEntry) error {
	for _, entry := range entries {
		if entry.key == "net.ipv4.tcp_congestion_control" {
			available, err := backend.read("net.ipv4.tcp_available_congestion_control")
			if err != nil {
				return err
			}
			has := func(value string) bool {
				for _, algorithm := range strings.Fields(value) {
					if algorithm == entry.value {
						return true
					}
				}
				return false
			}
			if !has(available) {
				switch entry.value {
				case "bbr", "bbr2", "bbr3", "cubic":
					_, _ = bbrCommand("modprobe", "tcp_"+entry.value)
				}
				available, err = backend.read("net.ipv4.tcp_available_congestion_control")
				if err != nil {
					return err
				}
				if !has(available) {
					return errors.New("当前内核不支持拥塞控制算法：" + entry.value)
				}
			}
		}
		if entry.key == "net.core.default_qdisc" {
			switch entry.value {
			case "fq", "fq_codel", "cake":
				_, _ = bbrCommand("modprobe", "sch_"+entry.value)
			}
		}
	}
	return nil
}

func (bbrLinuxBackend) qdiscs() string {
	if _, err := exec.LookPath("tc"); err != nil {
		return "未安装 tc，无法读取现有队列"
	}
	data, err := bbrCommand("tc", "-j", "qdisc", "show")
	var rows []struct {
		Dev  string `json:"dev"`
		Kind string `json:"kind"`
	}
	if err != nil || json.Unmarshal(data, &rows) != nil {
		return "现有队列读取失败"
	}
	var result []string
	for _, row := range rows {
		result = append(result, row.Dev+": "+row.Kind)
	}
	if len(result) == 0 {
		return "暂无队列"
	}
	return strings.Join(result, "; ")
}

// JSON layout is compatible with the Python-based BBR plugin 1.0.0.
type bbrState struct {
	Version        int               `json:"version"`
	Values         map[string]string `json:"values"`
	ManagedKeys    []string          `json:"managedKeys"`
	OriginalConfig *string           `json:"originalConfig"`
}

type bbrManager struct {
	backend     bbrBackend
	conf, state string
	replace     func(string, []byte) error
}

func newBBRManager(backend bbrBackend, root string) *bbrManager {
	return &bbrManager{backend: backend, conf: filepath.Join(root, "etc/sysctl.d/90-forwardx-bbr.conf"), state: filepath.Join(root, "var/lib/forwardx-agent/plugin-state/bbr-manager/original.json"), replace: bbrReplaceFile}
}

func bbrFileBytes(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	return data, err
}

func bbrReplaceFile(path string, data []byte) error {
	dir := filepath.Dir(path)
	if data == nil {
		if err := os.Remove(path); err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		return syncTrafficStateDirectory(dir)
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, ".forwardx-bbr-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(data)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return replaceTrafficStateFile(file.Name(), path, dir)
}

func (m *bbrManager) loadState() (*bbrState, error) {
	data, err := bbrFileBytes(m.state)
	if err != nil || data == nil {
		return nil, err
	}
	var state bbrState
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil || json.Unmarshal(data, &state) != nil || state.Version != 1 || state.Values == nil || state.ManagedKeys == nil || fields["originalConfig"] == nil {
		return nil, errors.New("原参数备份损坏，停止操作以免覆盖")
	}
	for key, value := range state.Values {
		parsed, err := parseBBRConfig(key + "=" + value)
		if err != nil || len(parsed) != 1 || parsed[0].value != value {
			return nil, errors.New("原参数备份包含不支持的参数或值")
		}
	}
	seen := map[string]bool{}
	for _, key := range state.ManagedKeys {
		if _, ok := state.Values[key]; !ok || seen[key] {
			return nil, errors.New("原参数备份缺少已托管参数或包含重复键")
		}
		seen[key] = true
	}
	if state.OriginalConfig != nil {
		if _, err := base64.StdEncoding.Strict().DecodeString(*state.OriginalConfig); err != nil {
			return nil, errors.New("原配置文件备份损坏")
		}
	}
	return &state, nil
}

func (m *bbrManager) saveState(state *bbrState) error {
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	return m.replace(m.state, data)
}

func (m *bbrManager) read() (map[string]any, error) {
	saved, err := bbrFileBytes(m.conf)
	if err != nil {
		return nil, err
	}
	var entries []bbrEntry
	if strings.TrimSpace(string(saved)) != "" {
		entries, err = parseBBRConfig(string(saved))
		if err != nil {
			return nil, err
		}
	}
	keys := append([]string{}, bbrGUIKeys...)
	for _, entry := range entries {
		keys = append(keys, entry.key)
	}
	values := map[string]string{}
	var runtimeText strings.Builder
	for _, key := range keys {
		if _, ok := values[key]; ok {
			continue
		}
		value, err := m.backend.read(key)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		values[key] = value
		fmt.Fprintf(&runtimeText, "%s = %s\n", key, value)
	}
	var config strings.Builder
	if len(saved) > 0 {
		for _, line := range strings.Split(strings.TrimSuffix(strings.ReplaceAll(string(saved), "\r\n", "\n"), "\n"), "\n") {
			parts := strings.SplitN(line, "#", 2)
			key := strings.TrimSpace(strings.SplitN(parts[0], "=", 2)[0])
			if value, ok := values[key]; ok {
				line = key + " = " + value
				if len(parts) > 1 {
					line += " #" + parts[1]
				}
			}
			config.WriteString(line + "\n")
		}
	} else {
		for _, key := range bbrGUIKeys[:2] {
			if value, ok := values[key]; ok {
				fmt.Fprintf(&config, "%s = %s\n", key, value)
			}
		}
	}
	inSync := len(entries) > 0
	for _, entry := range entries {
		if values[entry.key] != entry.value {
			inSync = false
		}
	}
	available, err := m.backend.read("net.ipv4.tcp_available_congestion_control")
	if err != nil {
		return nil, err
	}
	kernel, _ := os.ReadFile("/proc/sys/kernel/osrelease")
	_, stateErr := os.Stat(m.state)
	get := func(key string) string {
		if value, ok := values[key]; ok {
			return value
		}
		return "不支持"
	}
	return map[string]any{"id": "kernel", "name": "TCP / BBR", "kernel": strings.TrimSpace(string(kernel)), "congestionControl": get(bbrGUIKeys[0]), "defaultQdisc": get(bbrGUIKeys[1]), "availableAlgorithms": available, "currentQueues": m.backend.qdiscs(), "persisted": saved != nil, "inSync": inSync, "configText": config.String(), "runtimeText": runtimeText.String(), "savedConfigText": string(saved), "canRestore": stateErr == nil}, nil
}

func (m *bbrManager) transaction(targets []bbrEntry, config []byte, journal, final *bbrState) error {
	before := map[string]string{}
	for _, entry := range targets {
		value, err := m.backend.read(entry.key)
		if err != nil {
			return err
		}
		before[entry.key] = value
	}
	oldConfig, err := bbrFileBytes(m.conf)
	if err != nil {
		return err
	}
	oldState, err := bbrFileBytes(m.state)
	if err != nil {
		return err
	}
	if err = m.saveState(journal); err != nil {
		return err
	}
	var attempted []string
	operation := func() error {
		for _, entry := range targets {
			if before[entry.key] != entry.value {
				attempted = append(attempted, entry.key)
				if err := m.backend.write(entry.key, entry.value); err != nil {
					return err
				}
			}
			value, err := m.backend.read(entry.key)
			if err != nil {
				return err
			}
			if value != entry.value {
				return errors.New("参数校验失败：" + entry.key)
			}
		}
		if err := m.replace(m.conf, config); err != nil {
			return err
		}
		if final == nil {
			return m.replace(m.state, nil)
		}
		return m.saveState(final)
	}
	if err = operation(); err == nil {
		return nil
	}
	var failures []string
	for i := len(attempted) - 1; i >= 0; i-- {
		key := attempted[i]
		rollbackErr := m.backend.write(key, before[key])
		if rollbackErr == nil {
			var actual string
			actual, rollbackErr = m.backend.read(key)
			if rollbackErr == nil && actual != before[key] {
				rollbackErr = errors.New("回滚校验失败")
			}
		}
		if rollbackErr != nil {
			failures = append(failures, key+": "+rollbackErr.Error())
		}
	}
	if rollbackErr := m.replace(m.conf, oldConfig); rollbackErr != nil {
		failures = append(failures, "配置文件: "+rollbackErr.Error())
	}
	if len(failures) == 0 {
		if rollbackErr := m.replace(m.state, oldState); rollbackErr != nil {
			failures = append(failures, "备份文件: "+rollbackErr.Error())
		}
	}
	if len(failures) > 0 {
		return fmt.Errorf("操作失败：%w；部分回滚失败（保留原参数备份，请重试还原）：%s", err, strings.Join(failures, "; "))
	}
	return fmt.Errorf("操作失败，已回滚：%w", err)
}

func (m *bbrManager) apply(text string) (map[string]any, error) {
	entries, err := parseBBRConfig(text)
	if err != nil {
		return nil, err
	}
	previous, err := m.loadState()
	if err != nil {
		return nil, err
	}
	if previous == nil {
		previous = &bbrState{Version: 1, Values: map[string]string{}, ManagedKeys: []string{}}
		config, err := bbrFileBytes(m.conf)
		if err != nil {
			return nil, err
		}
		if config != nil {
			encoded := base64.StdEncoding.EncodeToString(config)
			previous.OriginalConfig = &encoded
		}
	}
	journal := &bbrState{Version: 1, Values: map[string]string{}, ManagedKeys: append([]string{}, previous.ManagedKeys...), OriginalConfig: previous.OriginalConfig}
	for key, value := range previous.Values {
		journal.Values[key] = value
	}
	selected := map[string]bool{}
	var finalKeys []string
	for _, entry := range entries {
		selected[entry.key] = true
		finalKeys = append(finalKeys, entry.key)
		if _, ok := journal.Values[entry.key]; !ok {
			value, err := m.backend.read(entry.key)
			if err != nil {
				return nil, err
			}
			journal.Values[entry.key] = value
		}
	}
	var targets []bbrEntry
	managed := map[string]bool{}
	for _, key := range previous.ManagedKeys {
		managed[key] = true
		if !selected[key] {
			targets = append(targets, bbrEntry{key, journal.Values[key]})
		}
	}
	for _, entry := range entries {
		if !managed[entry.key] {
			journal.ManagedKeys = append(journal.ManagedKeys, entry.key)
		}
	}
	targets = append(targets, entries...)
	// Validate every key before loading modules or changing any runtime value.
	for _, entry := range targets {
		if _, err := m.backend.read(entry.key); err != nil {
			return nil, err
		}
	}
	if err = m.backend.prepare(targets); err != nil {
		return nil, err
	}
	final := *journal
	final.ManagedKeys = finalKeys
	persisted := strings.TrimRight(strings.ReplaceAll(text, "\r\n", "\n"), "\n") + "\n"
	if err = m.transaction(targets, []byte(persisted), journal, &final); err != nil {
		return nil, err
	}
	return map[string]any{"id": "kernel", "message": "已应用并保存；新 TCP 连接使用新算法。默认队列不强制替换现有网卡队列。"}, nil
}

func (m *bbrManager) restore() (map[string]any, error) {
	state, err := m.loadState()
	if err != nil {
		return nil, err
	}
	if state == nil {
		return nil, errors.New("没有可还原的插件修改记录")
	}
	var config []byte
	if state.OriginalConfig != nil {
		config, err = base64.StdEncoding.Strict().DecodeString(*state.OriginalConfig)
		if err != nil {
			return nil, err
		}
	}
	var targets []bbrEntry
	for _, key := range state.ManagedKeys {
		targets = append(targets, bbrEntry{key, state.Values[key]})
	}
	if err = m.backend.prepare(targets); err != nil {
		return nil, err
	}
	if err = m.transaction(targets, config, state, nil); err != nil {
		return nil, err
	}
	return map[string]any{"id": "kernel", "message": "已还原插件修改前的参数和插件配置文件；未修改其他 sysctl 文件。"}, nil
}

func runBBRPlugin(args []string, output io.Writer) error {
	if len(args) == 0 || len(args) > 2 {
		return errors.New("用法：--plugin-bbr list|read|preset|restore|apply <配置>")
	}
	command := args[0]
	if command != "list" && command != "read" && command != "preset" && command != "restore" && command != "apply" {
		return errors.New("未知操作")
	}
	if (command == "apply" && len(args) != 2) || (command != "apply" && len(args) != 1) {
		return errors.New("操作参数数量错误")
	}
	if runtime.GOOS != "linux" {
		return errors.New("此插件仅支持 Linux Agent")
	}
	if os.Geteuid() != 0 {
		return errors.New("请以 root 权限运行 Agent")
	}
	m := newBBRManager(bbrLinuxBackend{}, "/")
	dir := filepath.Dir(m.state)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(dir, "lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = lockBBRStateFile(lock, command != "list" && command != "read"); err != nil {
		return errors.New("该主机正在执行 BBR 管理操作，请稍后重试")
	}
	defer unlockAgentStateFile(lock)
	var result map[string]any
	switch command {
	case "list", "read":
		result, err = m.read()
		if command == "list" && err == nil {
			delete(result, "configText")
			delete(result, "runtimeText")
			delete(result, "savedConfigText")
			result = map[string]any{"items": []any{result}}
		}
	case "preset":
		result, err = m.apply(bbrPreset)
	case "apply":
		result, err = m.apply(args[1])
	case "restore":
		result, err = m.restore()
	}
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(result)
}
