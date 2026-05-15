package main

import (
	"bufio"
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

var Version = "2.1.27"
var upgradeStarted int32

type Config struct {
	PanelURL string `json:"panelUrl"`
	Token    string `json:"token"`
	Interval int    `json:"interval"`
}

type envelope struct {
	V   int    `json:"v"`
	IV  string `json:"iv"`
	CT  string `json:"ct"`
	MAC string `json:"mac"`
	TS  int64  `json:"ts"`
}

type heartbeatResp struct {
	Actions      []action      `json:"actions"`
	SelfTests    []selfTest    `json:"selfTests"`
	AgentUpgrade *agentUpgrade `json:"agentUpgrade"`
}

type selfTestResp struct {
	SelfTests []selfTest `json:"selfTests"`
}

type action struct {
	RuleID           int      `json:"ruleId"`
	Op               string   `json:"op"`
	ForwardType      string   `json:"forwardType"`
	SourcePort       int      `json:"sourcePort"`
	Protocol         string   `json:"protocol"`
	ServiceName      string   `json:"svcName"`
	ServiceNameExtra string   `json:"svcNameExtra"`
	Unit             string   `json:"unit"`
	UnitExtra        string   `json:"unitExtra"`
	Commands         []string `json:"commands"`
}

type agentUpgrade struct {
	TargetVersion string `json:"targetVersion"`
	PanelURL      string `json:"panelUrl"`
}

type selfTest struct {
	TestID     int    `json:"testId"`
	RuleID     int    `json:"ruleId"`
	ForwardType string `json:"forwardType"`
	SourcePort  int    `json:"sourcePort"`
	Protocol    string `json:"protocol"`
	TargetIP    string `json:"targetIp"`
	TargetPort  int    `json:"targetPort"`
}

func main() {
	configPath := flag.String("config", "/etc/forwardx-agent/config.json", "config file")
	onceRegister := flag.Bool("register", false, "register and exit")
	flag.Parse()

	cfg, err := loadConfig(*configPath)
	if err != nil {
		fatal("load config: %v", err)
	}
	if cfg.Interval <= 0 {
		cfg.Interval = 30
	}
	cfg.PanelURL = strings.TrimRight(cfg.PanelURL, "/")

	if *onceRegister {
		if err := register(cfg); err != nil {
			fatal("register: %v", err)
		}
		return
	}

	_ = register(cfg)
	go selfTestPoller(cfg)
	go agentEventStream(cfg)
	for {
		if err := heartbeat(cfg); err != nil {
			logf("heartbeat error: %v", err)
		}
		time.Sleep(time.Duration(cfg.Interval) * time.Second)
	}
}

func loadConfig(path string) (Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	if err := json.Unmarshal(b, &cfg); err != nil {
		return Config{}, err
	}
	if cfg.PanelURL == "" || cfg.Token == "" {
		return Config{}, fmt.Errorf("panelUrl/token required")
	}
	return cfg, nil
}

func register(cfg Config) error {
	payload := map[string]any{
		"token":        cfg.Token,
		"ip":           publicIP(),
		"osInfo":       osInfo(),
		"cpuInfo":      runtime.GOARCH,
		"memoryTotal":  memTotal(),
		"agentVersion": Version,
	}
	var out map[string]any
	return post(cfg, "/api/agent/register", payload, &out)
}

func heartbeat(cfg Config) error {
	payload := map[string]any{
		"cpuUsage":     cpuUsage(),
		"memoryUsage":  memUsagePercent(),
		"memoryUsed":   memUsed(),
		"memoryTotal":  memTotal(),
		"networkIn":    netBytes(0),
		"networkOut":   netBytes(1),
		"diskUsage":    diskUsage(),
		"uptime":       uptime(),
		"agentVersion": Version,
	}
	var resp heartbeatResp
	if err := post(cfg, "/api/agent/heartbeat", payload, &resp); err != nil {
		return err
	}
	for _, a := range resp.Actions {
		go handleAction(cfg, a)
	}
	for _, t := range resp.SelfTests {
		go handleSelfTest(cfg, t)
	}
	collectTraffic(cfg)
	if resp.AgentUpgrade != nil {
		go selfUpgrade(cfg, resp.AgentUpgrade)
	}
	return nil
}

func selfTestPoller(cfg Config) {
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		var resp selfTestResp
		if err := post(cfg, "/api/agent/selftest-pull", map[string]any{}, &resp); err != nil {
			logf("selftest pull error: %v", err)
			continue
		}
		for _, t := range resp.SelfTests {
			go handleSelfTest(cfg, t)
		}
	}
}

func handleSelfTest(cfg Config, t selfTest) {
	start := time.Now()
	target := net.JoinHostPort(t.TargetIP, strconv.Itoa(t.TargetPort))
	conn, err := net.DialTimeout("tcp", target, 3*time.Second)
	latency := int(time.Since(start).Milliseconds())
	reachable := err == nil
	msg := ""
	if err == nil {
		_ = conn.Close()
		if latency < 1 {
			latency = 1
		}
		msg = fmt.Sprintf("目标 %s TCP可达, 延迟 %dms", target, latency)
	} else {
		latency = 0
		msg = fmt.Sprintf("目标 %s TCP不可达: %v", target, err)
	}
	payload := map[string]any{
		"testId":          t.TestID,
		"targetReachable": reachable,
		"latencyMs":       latency,
		"message":         msg,
	}
	if err := post(cfg, "/api/agent/selftest-result", payload, &map[string]any{}); err != nil {
		logf("selftest report failed test=%d target=%s: %v", t.TestID, target, err)
	}
}

func agentEventStream(cfg Config) {
	for {
		if err := runAgentEventStream(cfg); err != nil {
			logf("agent event stream error: %v", err)
			time.Sleep(3 * time.Second)
		}
	}
}

func runAgentEventStream(cfg Config) error {
	req, err := http.NewRequest("GET", cfg.PanelURL+"/api/agent/events", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("X-Agent-Version", Version)

	client := &http.Client{Timeout: 0}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("event stream status: %s", resp.Status)
	}

	scanner := bufio.NewScanner(resp.Body)
	var eventName string
	var data strings.Builder
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if eventName == "agent-upgrade" && data.Len() > 0 {
				var up agentUpgrade
				if err := json.Unmarshal([]byte(data.String()), &up); err != nil {
					logf("decode agent upgrade event: %v", err)
				} else {
					go selfUpgrade(cfg, &up)
				}
			}
			eventName = ""
			data.Reset()
			continue
		}
		if strings.HasPrefix(line, "event:") {
			eventName = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		} else if strings.HasPrefix(line, "data:") {
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	return scanner.Err()
}

func handleAction(cfg Config, a action) {
	ok := true
	if a.Op == "apply" {
		if a.Unit != "" && a.ServiceName != "" {
			ok = writeUnitAndRestart(a.ServiceName, a.Unit) && ok
		}
		if a.UnitExtra != "" && a.ServiceNameExtra != "" {
			ok = writeUnitAndRestart(a.ServiceNameExtra, a.UnitExtra) && ok
		}
		for _, cmd := range a.Commands {
			ok = runShell(cmd) && ok
		}
		writeState(a)
	} else {
		for _, cmd := range a.Commands {
			ok = runShell(cmd) && ok
		}
		removeState(a.SourcePort)
	}
	_ = post(cfg, "/api/agent/rule-status", map[string]any{"ruleId": a.RuleID, "isRunning": ok && a.Op == "apply"}, &map[string]any{})
}

func writeUnitAndRestart(name, unit string) bool {
	path := "/etc/systemd/system/" + name + ".service"
	if err := os.WriteFile(path, []byte(unit), 0644); err != nil {
		logf("write unit %s: %v", name, err)
		return false
	}
	return runShell("systemctl daemon-reload") &&
		runShell("systemctl enable "+name+".service") &&
		runShell("systemctl restart "+name+".service")
}

func writeState(a action) {
	_ = os.MkdirAll("/var/lib/forwardx-agent", 0755)
	port := strconv.Itoa(a.SourcePort)
	_ = os.WriteFile("/var/lib/forwardx-agent/port_"+port+".rule", []byte(strconv.Itoa(a.RuleID)), 0644)
	_ = os.WriteFile("/var/lib/forwardx-agent/port_"+port+".fwtype", []byte(a.ForwardType), 0644)
}

func removeState(port int) {
	p := strconv.Itoa(port)
	_ = os.Remove("/var/lib/forwardx-agent/port_" + p + ".rule")
	_ = os.Remove("/var/lib/forwardx-agent/port_" + p + ".fwtype")
	_ = os.Remove("/var/lib/forwardx-agent/traffic_" + p + ".prev")
}

func collectTraffic(cfg Config) {
	files, _ := os.ReadDir("/var/lib/forwardx-agent")
	stats := []map[string]any{}
	for _, f := range files {
		name := f.Name()
		if !strings.HasPrefix(name, "port_") || !strings.HasSuffix(name, ".rule") {
			continue
		}
		port := strings.TrimSuffix(strings.TrimPrefix(name, "port_"), ".rule")
		ridBytes, err := os.ReadFile("/var/lib/forwardx-agent/" + name)
		if err != nil {
			continue
		}
		ruleID, _ := strconv.Atoi(strings.TrimSpace(string(ridBytes)))
		in := iptablesBytes("FWX_IN_" + port)
		out := iptablesBytes("FWX_OUT_" + port)
		prevIn, prevOut := readPrev(port)
		din, dout := delta(in, prevIn), delta(out, prevOut)
		writePrev(port, in, out)
		conns := conntrackConnections(port)
		if din > 0 || dout > 0 || conns > 0 {
			stats = append(stats, map[string]any{"ruleId": ruleID, "bytesIn": din, "bytesOut": dout, "connections": conns})
		}
	}
	if len(stats) > 0 {
		_ = post(cfg, "/api/agent/traffic", map[string]any{"stats": stats}, &map[string]any{})
	}
}

func conntrackConnections(port string) uint64 {
	cmd := fmt.Sprintf(`awk -v p="dport=%s" 'index($0,p" ")>0 {c++} END{print c+0}' /proc/net/nf_conntrack 2>/dev/null`, port)
	out, err := exec.Command("sh", "-lc", cmd).Output()
	if err != nil {
		return 0
	}
	v, _ := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
	return v
}

func iptablesBytes(chain string) uint64 {
	cmd := fmt.Sprintf(`iptables -t mangle -L %s -vnx 2>/dev/null | awk 'NR>2 {s+=$2} END{print s+0}'`, chain)
	out, err := exec.Command("sh", "-lc", cmd).Output()
	if err != nil {
		return 0
	}
	v, _ := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
	return v
}

func readPrev(port string) (uint64, uint64) {
	b, err := os.ReadFile("/var/lib/forwardx-agent/traffic_" + port + ".prev")
	if err != nil {
		return 0, 0
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) < 2 {
		return 0, 0
	}
	a, _ := strconv.ParseUint(strings.TrimSpace(lines[0]), 10, 64)
	c, _ := strconv.ParseUint(strings.TrimSpace(lines[1]), 10, 64)
	return a, c
}

func writePrev(port string, in, out uint64) {
	_ = os.WriteFile("/var/lib/forwardx-agent/traffic_"+port+".prev", []byte(fmt.Sprintf("%d\n%d\n", in, out)), 0644)
}

func delta(cur, prev uint64) uint64 {
	if cur >= prev {
		return cur - prev
	}
	return cur
}

func selfUpgrade(cfg Config, up *agentUpgrade) {
	if !atomic.CompareAndSwapInt32(&upgradeStarted, 0, 1) {
		logf("self-upgrade already started, ignoring duplicate request")
		return
	}
	panel := strings.TrimRight(up.PanelURL, "/")
	if panel == "" {
		panel = cfg.PanelURL
	}
	upgradeCmd := fmt.Sprintf(`sleep 1; curl -fsSL --max-time 30 "%s/api/agent/install.sh" | PANEL_URL="%s" bash -s -- upgrade %s`, panel, panel, shellQuote(cfg.Token))
	cmd := fmt.Sprintf(`if command -v systemd-run >/dev/null 2>&1; then systemd-run --unit=forwardx-agent-upgrade --collect /bin/sh -lc %s; else nohup sh -lc %s >/var/log/forwardx-agent/agent-upgrade.log 2>&1 < /dev/null & fi`, shellQuote(upgradeCmd), shellQuote(upgradeCmd))
	logf("self-upgrade requested target=%s", up.TargetVersion)
	_ = runShell(cmd)
}

func post(cfg Config, path string, payload any, out any) error {
	env, err := encrypt(payload, cfg.Token)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(env)
	req, err := http.NewRequest("POST", cfg.PanelURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("X-Agent-Encrypted", "1")
	client := &http.Client{Timeout: 60 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	resBody, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 300 {
		return fmt.Errorf("%s: %s", res.Status, string(resBody))
	}
	var respEnv envelope
	if err := json.Unmarshal(resBody, &respEnv); err == nil && respEnv.V == 1 {
		plain, err := decrypt(respEnv, cfg.Token)
		if err != nil {
			return err
		}
		return json.Unmarshal(plain, out)
	}
	return json.Unmarshal(resBody, out)
}

func encrypt(payload any, token string) (envelope, error) {
	plain, _ := json.Marshal(payload)
	keyEnc := sha256.Sum256([]byte(token + "|forwardx-agent-v1"))
	keyMac := sha256.Sum256([]byte(token + "|forwardx-agent-mac"))
	iv := make([]byte, aes.BlockSize)
	if _, err := rand.Read(iv); err != nil {
		return envelope{}, err
	}
	block, err := aes.NewCipher(keyEnc[:])
	if err != nil {
		return envelope{}, err
	}
	ct := make([]byte, len(plain))
	cipher.NewCTR(block, iv).XORKeyStream(ct, plain)
	ts := time.Now().UnixMilli()
	mac := calcMAC(keyMac[:], iv, ct, ts)
	return envelope{V: 1, IV: hex.EncodeToString(iv), CT: hex.EncodeToString(ct), MAC: hex.EncodeToString(mac), TS: ts}, nil
}

func decrypt(env envelope, token string) ([]byte, error) {
	keyEnc := sha256.Sum256([]byte(token + "|forwardx-agent-v1"))
	keyMac := sha256.Sum256([]byte(token + "|forwardx-agent-mac"))
	iv, err := hex.DecodeString(env.IV)
	if err != nil {
		return nil, err
	}
	ct, err := hex.DecodeString(env.CT)
	if err != nil {
		return nil, err
	}
	got, _ := hex.DecodeString(env.MAC)
	want := calcMAC(keyMac[:], iv, ct, env.TS)
	if !hmac.Equal(got, want) {
		return nil, fmt.Errorf("mac verification failed")
	}
	block, err := aes.NewCipher(keyEnc[:])
	if err != nil {
		return nil, err
	}
	plain := make([]byte, len(ct))
	cipher.NewCTR(block, iv).XORKeyStream(plain, ct)
	return plain, nil
}

func calcMAC(key, iv, ct []byte, ts int64) []byte {
	buf := bytes.NewBufferString("v1")
	buf.Write(iv)
	buf.Write(ct)
	tsb := make([]byte, 8)
	binary.BigEndian.PutUint64(tsb, uint64(ts))
	buf.Write(tsb)
	m := hmac.New(sha256.New, key)
	m.Write(buf.Bytes())
	return m.Sum(nil)
}

func runShell(cmd string) bool {
	logf("exec: %s", cmd)
	c := exec.Command("sh", "-lc", cmd)
	out, err := c.CombinedOutput()
	if len(out) > 0 {
		logf("%s", strings.TrimSpace(string(out)))
	}
	if err != nil {
		logf("exec failed: %v", err)
		return false
	}
	return true
}

func osInfo() string {
	if b, err := os.ReadFile("/etc/os-release"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(line, "PRETTY_NAME=") {
				return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"`)
			}
		}
	}
	return runtime.GOOS + "/" + runtime.GOARCH
}

func publicIP() string {
	for _, u := range []string{"https://ifconfig.me", "https://icanhazip.com"} {
		c := &http.Client{Timeout: 5 * time.Second}
		if res, err := c.Get(u); err == nil {
			b, _ := io.ReadAll(res.Body)
			res.Body.Close()
			ip := strings.TrimSpace(string(b))
			if net.ParseIP(ip) != nil {
				return ip
			}
		}
	}
	return "unknown"
}

func readMeminfo() map[string]uint64 {
	out := map[string]uint64{}
	b, _ := os.ReadFile("/proc/meminfo")
	for _, line := range strings.Split(string(b), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 {
			v, _ := strconv.ParseUint(fields[1], 10, 64)
			out[strings.TrimSuffix(fields[0], ":")] = v * 1024
		}
	}
	return out
}

func memTotal() uint64 { return readMeminfo()["MemTotal"] }
func memUsed() uint64 {
	m := readMeminfo()
	return m["MemTotal"] - m["MemAvailable"]
}
func memUsagePercent() int {
	total := memTotal()
	if total == 0 {
		return 0
	}
	return int(memUsed() * 100 / total)
}

func uptime() int64 {
	b, _ := os.ReadFile("/proc/uptime")
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	return int64(v)
}

func cpuUsage() int {
	b, _ := os.ReadFile("/proc/loadavg")
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	return int(v)
}

func netBytes(idx int) uint64 {
	b, _ := os.ReadFile("/proc/net/dev")
	var total uint64
	for _, line := range strings.Split(string(b), "\n") {
		if !strings.Contains(line, ":") || strings.Contains(line, "lo:") {
			continue
		}
		parts := strings.Fields(strings.ReplaceAll(line, ":", " "))
		if len(parts) > 9 {
			if idx == 0 {
				v, _ := strconv.ParseUint(parts[1], 10, 64)
				total += v
			} else {
				v, _ := strconv.ParseUint(parts[9], 10, 64)
				total += v
			}
		}
	}
	return total
}

func diskUsage() int {
	out, err := exec.Command("sh", "-lc", `df -P / | awk 'NR==2 {gsub("%","",$5); print $5}'`).Output()
	if err != nil {
		return 0
	}
	v, _ := strconv.Atoi(strings.TrimSpace(string(out)))
	return v
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'"
}

func logf(format string, args ...any) {
	_ = os.MkdirAll("/var/log/forwardx-agent", 0755)
	line := time.Now().Format(time.RFC3339) + " " + fmt.Sprintf(format, args...) + "\n"
	fmt.Print(line)
	f, err := os.OpenFile("/var/log/forwardx-agent/agent-go.log", os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err == nil {
		defer f.Close()
		_, _ = f.WriteString(line)
	}
}

func fatal(format string, args ...any) {
	logf(format, args...)
	os.Exit(1)
}
