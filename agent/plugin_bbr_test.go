package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

// All manager tests use a fake kernel and a temporary filesystem root.
type fakeBBRBackend struct {
	values map[string]string
	writes []bbrEntry
	fail   func(string, string) error
	ignore bool
}

func newFakeBBRBackend() *fakeBBRBackend {
	return &fakeBBRBackend{values: map[string]string{
		"net.ipv4.tcp_congestion_control": "cubic", "net.core.default_qdisc": "fq_codel",
		"net.ipv4.tcp_rmem": "4096 131072 6291456", "net.core.somaxconn": "4096",
		"net.ipv4.tcp_available_congestion_control": "reno cubic bbr",
	}}
}
func (b *fakeBBRBackend) read(key string) (string, error) {
	value, ok := b.values[key]
	if !ok {
		return "", fmt.Errorf("%s: %w", key, os.ErrNotExist)
	}
	return value, nil
}
func (b *fakeBBRBackend) write(key, value string) error {
	b.writes = append(b.writes, bbrEntry{key, value})
	if !b.ignore {
		b.values[key] = bbrNormalize(value)
	}
	if b.fail != nil {
		return b.fail(key, value)
	}
	return nil
}
func (b *fakeBBRBackend) prepare(entries []bbrEntry) error {
	for _, entry := range entries {
		if entry.key == bbrGUIKeys[0] && !strings.Contains(" "+b.values["net.ipv4.tcp_available_congestion_control"]+" ", " "+entry.value+" ") {
			return fmt.Errorf("内核不支持：%s", entry.value)
		}
	}
	return nil
}
func (b *fakeBBRBackend) qdiscs() string { return "eth0: fq_codel" }

func bbrTestManager(t *testing.T) (*bbrManager, *fakeBBRBackend) {
	t.Helper()
	backend := newFakeBBRBackend()
	return newBBRManager(backend, t.TempDir()), backend
}
func bbrMustApply(t *testing.T, m *bbrManager, text string) {
	t.Helper()
	if _, err := m.apply(text); err != nil {
		t.Fatal(err)
	}
}
func bbrMustRestore(t *testing.T, m *bbrManager) {
	t.Helper()
	if _, err := m.restore(); err != nil {
		t.Fatal(err)
	}
}
func bbrMustReadFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
func bbrWantAbsent(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expected absent %s: %v", path, err)
	}
}

func TestBBRParserRejectsUnsafeConfig(t *testing.T) {
	for _, text := range []string{"", "# comment", "kernel.panic=1", "net.ipv4.ip_forward=1", "net.ipv4.tcp_syncookies=$(id)", "net.core.default_qdisc=fq;reboot", "include /tmp/example", "net.ipv4.tcp_*=1", "net.core.somaxconn=1\nnet.core.somaxconn=2", "#" + strings.Repeat("x", 12000), "net.core.default_qdisc=", "net.core.default_qdisc=fq\x00", string([]byte{0xff})} {
		if _, err := parseBBRConfig(text); err == nil {
			t.Fatalf("accepted unsafe input %q", text)
		}
	}
}
func TestBBRParserPreservesOrderAndNormalizesTuples(t *testing.T) {
	entries, err := parseBBRConfig("; hi\r\nnet.ipv4.tcp_rmem = 4096\t131072\t6291456 # ok\r\nnet.core.somaxconn=2048\n")
	want := []bbrEntry{{"net.ipv4.tcp_rmem", "4096 131072 6291456"}, {"net.core.somaxconn", "2048"}}
	if err != nil || !reflect.DeepEqual(entries, want) {
		t.Fatalf("%v %v", entries, err)
	}
}
func TestBBRReadAndRuntimeDrift(t *testing.T) {
	m, b := bbrTestManager(t)
	detail, err := m.read()
	if err != nil || detail["congestionControl"] != "cubic" || detail["persisted"] != false || len(b.writes) != 0 {
		t.Fatalf("%v %v", detail, err)
	}
	if !strings.Contains(detail["runtimeText"].(string), "tcp_rmem") {
		t.Fatal("missing runtime parameter")
	}
	text := "# chosen\r\nnet.core.default_qdisc = fq # queue\r\nnet.ipv4.tcp_congestion_control = bbr\r\n"
	bbrMustApply(t, m, text)
	b.values[bbrGUIKeys[0]] = "reno"
	detail, err = m.read()
	if err != nil {
		t.Fatal(err)
	}
	if detail["inSync"] != false || !strings.Contains(detail["configText"].(string), "= reno") || !strings.Contains(detail["savedConfigText"].(string), "= bbr") || !strings.Contains(detail["configText"].(string), "# queue") {
		t.Fatalf("%v", detail)
	}
	if detail["currentQueues"] != "eth0: fq_codel" || detail["defaultQdisc"] != "fq" {
		t.Fatal("actual queue confused with default queue")
	}
}
func TestBBRApplyRestoreAndHostIsolation(t *testing.T) {
	m, b := bbrTestManager(t)
	other := filepath.Join(filepath.Dir(m.conf), "99-custom.conf")
	if err := m.replace(other, []byte("# third party\n")); err != nil {
		t.Fatal(err)
	}
	bbrMustApply(t, m, bbrPreset)
	detail, err := m.read()
	if err != nil || detail["inSync"] != true {
		t.Fatalf("%v %v", detail, err)
	}
	second, _ := bbrTestManager(t)
	if _, err = second.restore(); err == nil {
		t.Fatal("another host should have no baseline")
	}
	// Re-create the manager as after an Agent restart or plugin asset replacement.
	m2 := &bbrManager{backend: b, conf: m.conf, state: m.state, replace: bbrReplaceFile}
	bbrMustRestore(t, m2)
	if b.values[bbrGUIKeys[0]] != "cubic" || b.values[bbrGUIKeys[1]] != "fq_codel" {
		t.Fatal(b.values)
	}
	bbrWantAbsent(t, m.conf)
	bbrWantAbsent(t, m.state)
	if string(bbrMustReadFile(t, other)) != "# third party\n" {
		t.Fatal("unrelated config modified")
	}
}
func TestBBRAddRemoveKeysKeepsFirstBaseline(t *testing.T) {
	m, b := bbrTestManager(t)
	bbrMustApply(t, m, bbrPreset+"net.core.somaxconn=2048\n")
	bbrMustApply(t, m, bbrPreset+"net.core.somaxconn=1024\n")
	state, err := m.loadState()
	if err != nil || state.Values["net.core.somaxconn"] != "4096" {
		t.Fatalf("%v %v", state, err)
	}
	bbrMustApply(t, m, bbrPreset)
	if b.values["net.core.somaxconn"] != "4096" {
		t.Fatal(b.values)
	}
	bbrMustRestore(t, m)
}
func TestBBRExistingConfigRestoredExactly(t *testing.T) {
	for _, original := range [][]byte{[]byte("# old plugin config\r\nnet.core.default_qdisc=fq_codel\r\n"), {}} {
		m, _ := bbrTestManager(t)
		if err := m.replace(m.conf, original); err != nil {
			t.Fatal(err)
		}
		bbrMustApply(t, m, bbrPreset)
		bbrMustRestore(t, m)
		if !bytes.Equal(bbrMustReadFile(t, m.conf), original) {
			t.Fatal("original bytes changed")
		}
	}
}
func TestBBRMissingKeyOrUnsupportedAlgorithmNoWrites(t *testing.T) {
	for _, text := range []string{bbrPreset + "net.ipv4.tcp_nonexistent=1", "net.ipv4.tcp_congestion_control=bbr3"} {
		m, b := bbrTestManager(t)
		if _, err := m.apply(text); err == nil {
			t.Fatal("expected rejection")
		}
		if len(b.writes) != 0 {
			t.Fatal(b.writes)
		}
		bbrWantAbsent(t, m.state)
	}
}
func TestBBRPartialApplyFailureRollsBack(t *testing.T) {
	m, b := bbrTestManager(t)
	b.fail = func(key, value string) error {
		if key == bbrGUIKeys[0] && value == "bbr" {
			return fmt.Errorf("partial write")
		}
		return nil
	}
	_, err := m.apply(bbrPreset)
	if err == nil || !strings.Contains(err.Error(), "已回滚") {
		t.Fatal(err)
	}
	if b.values[bbrGUIKeys[0]] != "cubic" || b.values[bbrGUIKeys[1]] != "fq_codel" {
		t.Fatal(b.values)
	}
	bbrWantAbsent(t, m.conf)
	bbrWantAbsent(t, m.state)
}
func TestBBRReadbackMismatchRollsBack(t *testing.T) {
	m, b := bbrTestManager(t)
	b.ignore = true
	_, err := m.apply(bbrPreset)
	if err == nil || !strings.Contains(err.Error(), "参数校验失败") {
		t.Fatal(err)
	}
	bbrWantAbsent(t, m.state)
}
func TestBBRPersistenceFailuresRollBack(t *testing.T) {
	for _, target := range []string{"config", "final-state"} {
		t.Run(target, func(t *testing.T) {
			m, b := bbrTestManager(t)
			bbrMustApply(t, m, bbrPreset)
			oldState, oldConfig := bbrMustReadFile(t, m.state), bbrMustReadFile(t, m.conf)
			failed, stateWrites := false, 0
			m.replace = func(path string, data []byte) error {
				if path == m.state {
					stateWrites++
				}
				if !failed && (target == "config" && path == m.conf || target == "final-state" && path == m.state && stateWrites == 2) {
					failed = true
					return fmt.Errorf("disk full")
				}
				return bbrReplaceFile(path, data)
			}
			_, err := m.apply("net.ipv4.tcp_congestion_control=reno\n")
			if err == nil || !strings.Contains(err.Error(), "已回滚") {
				t.Fatal(err)
			}
			if b.values[bbrGUIKeys[0]] != "bbr" || b.values[bbrGUIKeys[1]] != "fq" {
				t.Fatal(b.values)
			}
			if !bytes.Equal(bbrMustReadFile(t, m.state), oldState) || !bytes.Equal(bbrMustReadFile(t, m.conf), oldConfig) {
				t.Fatal("files not rolled back")
			}
		})
	}
}
func TestBBRJournalFailureNeverChangesKernel(t *testing.T) {
	m, b := bbrTestManager(t)
	m.replace = func(string, []byte) error { return fmt.Errorf("disk full") }
	if _, err := m.apply(bbrPreset); err == nil {
		t.Fatal("expected error")
	}
	if len(b.writes) > 0 {
		t.Fatal(b.writes)
	}
}
func TestBBRRestoreFailureKeepsBaseline(t *testing.T) {
	m, b := bbrTestManager(t)
	bbrMustApply(t, m, bbrPreset)
	b.fail = func(key, value string) error {
		if key == bbrGUIKeys[0] && value == "cubic" {
			return fmt.Errorf("partial write")
		}
		return nil
	}
	if _, err := m.restore(); err == nil || !strings.Contains(err.Error(), "已回滚") {
		t.Fatal(err)
	}
	if b.values[bbrGUIKeys[0]] != "bbr" {
		t.Fatal(b.values)
	}
	if _, err := m.loadState(); err != nil {
		t.Fatal(err)
	}
	b.fail = nil
	bbrMustRestore(t, m)
	bbrWantAbsent(t, m.state)
}
func TestBBRRollbackFailureKeepsRecoveryJournal(t *testing.T) {
	m, b := bbrTestManager(t)
	b.fail = func(key, value string) error {
		if value == "bbr" || value == "fq_codel" {
			return fmt.Errorf("write failure")
		}
		return nil
	}
	if _, err := m.apply(bbrPreset); err == nil || !strings.Contains(err.Error(), "部分回滚失败") {
		t.Fatal(err)
	}
	state, err := m.loadState()
	if err != nil || state.Values[bbrGUIKeys[1]] != "fq_codel" {
		t.Fatalf("%v %v", state, err)
	}
	b.fail = nil
	bbrMustRestore(t, m)
	bbrWantAbsent(t, m.state)
}
func TestBBRPython100BackupCompatibility(t *testing.T) {
	m, b := bbrTestManager(t)
	b.values[bbrGUIKeys[0]] = "bbr"
	b.values[bbrGUIKeys[1]] = "fq"
	original := []byte("# original\r\nnet.core.default_qdisc=fq_codel\r\n")
	// Exact schema produced by manage.py 1.0.0 (including base64 originalConfig).
	legacy := fmt.Sprintf(`{"version":1,"values":{"net.core.default_qdisc":"fq_codel","net.ipv4.tcp_congestion_control":"cubic"},"managedKeys":["net.core.default_qdisc","net.ipv4.tcp_congestion_control"],"originalConfig":%q}`, base64.StdEncoding.EncodeToString(original))
	if err := m.replace(m.state, []byte(legacy)); err != nil {
		t.Fatal(err)
	}
	if err := m.replace(m.conf, []byte(bbrPreset)); err != nil {
		t.Fatal(err)
	}
	bbrMustRestore(t, m)
	if !bytes.Equal(bbrMustReadFile(t, m.conf), original) || b.values[bbrGUIKeys[0]] != "cubic" {
		t.Fatal("legacy restore failed")
	}
}
func TestBBRCorruptStateDoesNotOverwriteBaseline(t *testing.T) {
	for _, text := range []string{`{"version":2}`, `{"version":1,"values":{},"managedKeys":[]}`, `{"version":1,"values":{},"managedKeys":["net.core.default_qdisc"],"originalConfig":null}`, `{"version":1,"values":{"kernel.panic":"1"},"managedKeys":[],"originalConfig":null}`, `{"version":1,"values":{},"managedKeys":[],"originalConfig":"@@@"}`, `{"version":1,"values":{"net.core.default_qdisc":"$(id)"},"managedKeys":[],"originalConfig":null}`} {
		m, b := bbrTestManager(t)
		if err := m.replace(m.state, []byte(text)); err != nil {
			t.Fatal(err)
		}
		if _, err := m.apply(bbrPreset); err == nil {
			t.Fatalf("accepted corrupt backup %s", text)
		}
		if len(b.writes) > 0 || string(bbrMustReadFile(t, m.state)) != text {
			t.Fatal("modified corrupt state or kernel")
		}
	}
}
func TestBBRLocksCoordinateReadersAndWriters(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lock")
	open := func() *os.File {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { f.Close() })
		return f
	}
	a, b := open(), open()
	if err := lockBBRStateFile(a, false); err != nil {
		t.Fatal(err)
	}
	if err := lockBBRStateFile(b, false); err != nil {
		t.Fatal("readers should share", err)
	}
	if err := lockBBRStateFile(open(), true); err == nil {
		t.Fatal("writer acquired read lock")
	}
	_ = unlockAgentStateFile(a)
	_ = unlockAgentStateFile(b)
	if err := lockBBRStateFile(a, true); err != nil {
		t.Fatal(err)
	}
	if err := lockBBRStateFile(b, false); err == nil {
		t.Fatal("reader acquired write lock")
	}
	_ = unlockAgentStateFile(a)
}
func TestBBRLauncherNoPythonAndOldAgentFailsClearly(t *testing.T) {
	launcher := filepath.Join("..", "plugins", "bbr-manager", "manage.sh")
	data := string(bbrMustReadFile(t, launcher))
	if strings.Contains(data, "python") || strings.Contains(data, "eval ") || !strings.Contains(data, `exec "$FORWARDX_AGENT_EXECUTABLE" --plugin-bbr "$@"`) {
		t.Fatal("launcher must only forward literal arguments to Agent")
	}
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("sh unavailable; launcher checked statically")
	}
	cmd := exec.Command(sh, launcher, "read")
	cmd.Env = append(os.Environ(), "FORWARDX_AGENT_EXECUTABLE=")
	output, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "请先更新 Agent") {
		t.Fatalf("%s: %v", output, err)
	}
}
func TestBBRExecutableTracksRunningAgent(t *testing.T) {
	path := pluginAgentExecutable()
	if runtime.GOOS == "linux" && path != fmt.Sprintf("/proc/%d/exe", os.Getpid()) {
		t.Fatal(path)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
}
func TestBBRCLIRejectsInvalidArgumentsBeforeAnyOperation(t *testing.T) {
	for _, args := range [][]string{nil, {"unknown"}, {"apply"}, {"read", "unexpected"}, {"apply", "x", "y"}} {
		var output bytes.Buffer
		if err := runBBRPlugin(args, &output); err == nil || output.Len() != 0 {
			t.Fatalf("%v: %v", args, err)
		}
	}
}
