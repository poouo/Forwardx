package main

// Link speed tests are short-lived, isolated from desired-state/business runtimes.
// The Agent owns the payload generator and receiver; iperf3 is not required.
import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type linkSpeedComponent struct {
	Kind       string          `json:"kind"`
	Port       int             `json:"port"`
	ListenHost string          `json:"listenHost"`
	Target     string          `json:"target"`
	TLSClient  bool            `json:"tlsClient"`
	ServerName string          `json:"serverName"`
	CertPEM    string          `json:"certPem"`
	KeyPEM     string          `json:"keyPem"`
	Config     json.RawMessage `json:"config"`
}
type linkSpeedTask struct {
	TaskID     string               `json:"taskId"`
	JobID      string               `json:"jobId"`
	Op         string               `json:"op"`
	Token      string               `json:"token"`
	Protocol   string               `json:"protocol"`
	Duration   int                  `json:"duration"`
	RateMbps   float64              `json:"rateMbps"`
	ExpiresAt  int64                `json:"expiresAt"`
	Target     string               `json:"target"`
	Components []linkSpeedComponent `json:"components"`
}
type linkSpeedSession struct {
	ctx     context.Context
	cancel  context.CancelFunc
	mu      sync.Mutex
	closed  bool
	running bool
	cleanup []func()
}

var linkSpeedSessionsMu sync.Mutex
var linkSpeedSessions = map[string]*linkSpeedSession{}
var linkSpeedSeen = map[string]time.Time{}
var resolveLinkSpeedRuntime = func() string { return "/usr/local/bin/forwardx-runtime" }

func (s *linkSpeedSession) addCleanup(fn func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		fn()
	} else {
		s.cleanup = append(s.cleanup, fn)
	}
}
func (s *linkSpeedSession) close() {
	s.cancel()
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	cleanup := s.cleanup
	s.cleanup = nil
	s.mu.Unlock()
	for i := len(cleanup) - 1; i >= 0; i-- {
		cleanup[i]()
	}
}
func speedReport(cfg Config, task linkSpeedTask, result map[string]any) error {
	result["taskId"], result["jobId"] = task.TaskID, task.JobID
	return post(cfg, "/api/agent/link-speed-result", map[string]any{"result": result}, &map[string]any{})
}
func speedReportFinal(cfg Config, task linkSpeedTask, result map[string]any) {
	for i := 0; i < 3; i++ {
		if speedReport(cfg, task, result) == nil {
			return
		}
	}
}
func validateLinkSpeedTask(task linkSpeedTask) error {
	if len(task.JobID) != 36 || len(task.TaskID) != 36 || len(task.Token) != 64 {
		return errors.New("invalid speed test identifiers")
	}
	if task.Protocol != "tcp" && task.Protocol != "udp" {
		return errors.New("unsupported speed test protocol")
	}
	if task.Duration < 3 || task.Duration > 30 || task.RateMbps < 0 || task.RateMbps > 1_000_000 {
		return errors.New("invalid speed test limits")
	}
	if task.Protocol == "udp" && (task.RateMbps < 1 || task.RateMbps > 1000) {
		return errors.New("UDP speed test rate must be 1-1000 Mbps")
	}
	if task.ExpiresAt <= time.Now().UnixMilli() || task.ExpiresAt > time.Now().Add(3*time.Minute).UnixMilli() {
		return errors.New("speed test lease expired")
	}
	if task.Op != "prepare" && task.Op != "run" && task.Op != "stop" {
		return errors.New("unsupported speed test operation")
	}
	if len(task.Components) > 80 {
		return errors.New("too many speed test listeners")
	}
	return nil
}
func handleLinkSpeedTask(cfg Config, task linkSpeedTask) {
	if err := validateLinkSpeedTask(task); err != nil {
		speedReportFinal(cfg, task, map[string]any{"state": "error", "error": err.Error()})
		return
	}
	var claim struct {
		Allowed bool `json:"allowed"`
	}
	if err := post(cfg, "/api/agent/link-speed-claim", map[string]any{"jobId": task.JobID, "taskId": task.TaskID}, &claim); err != nil || !claim.Allowed {
		return
	}
	linkSpeedSessionsMu.Lock()
	for id, at := range linkSpeedSeen {
		if time.Since(at) > 4*time.Minute {
			delete(linkSpeedSeen, id)
		}
	}
	if _, seen := linkSpeedSeen[task.TaskID]; seen {
		linkSpeedSessionsMu.Unlock()
		return
	}
	linkSpeedSeen[task.TaskID] = time.Now()
	session := linkSpeedSessions[task.JobID]
	if task.Op == "stop" {
		if session == nil {
			ctx, cancel := context.WithCancel(context.Background())
			session = &linkSpeedSession{ctx: ctx, cancel: cancel}
			linkSpeedSessions[task.JobID] = session
			time.AfterFunc(3*time.Minute, func() {
				linkSpeedSessionsMu.Lock()
				if linkSpeedSessions[task.JobID] == session {
					delete(linkSpeedSessions, task.JobID)
				}
				linkSpeedSessionsMu.Unlock()
			})
		}
		linkSpeedSessionsMu.Unlock()
		session.close()
		speedReportFinal(cfg, task, map[string]any{"state": "stopped"})
		return
	}
	if task.Op == "prepare" {
		if session != nil {
			linkSpeedSessionsMu.Unlock()
			return
		}
		ctx, cancel := context.WithDeadline(context.Background(), time.UnixMilli(task.ExpiresAt))
		session = &linkSpeedSession{ctx: ctx, cancel: cancel}
		linkSpeedSessions[task.JobID] = session
		go func() {
			<-ctx.Done()
			session.close()
			time.AfterFunc(3*time.Minute, func() {
				linkSpeedSessionsMu.Lock()
				if linkSpeedSessions[task.JobID] == session {
					delete(linkSpeedSessions, task.JobID)
				}
				linkSpeedSessionsMu.Unlock()
			})
		}()
	}
	linkSpeedSessionsMu.Unlock()
	if session == nil {
		speedReportFinal(cfg, task, map[string]any{"state": "error", "error": "测速端点尚未准备完成"})
		return
	}
	fail := func(err error) {
		session.close()
		speedReportFinal(cfg, task, map[string]any{"state": "error", "error": err.Error()})
	}
	if task.Op == "prepare" {
		for _, component := range task.Components {
			if err := prepareLinkSpeedComponent(cfg, session, task, component); err != nil {
				fail(err)
				return
			}
		}
		if session.ctx.Err() == nil {
			speedReportFinal(cfg, task, map[string]any{"state": "ready"})
		}
		return
	}
	session.mu.Lock()
	if session.closed || session.running {
		session.mu.Unlock()
		return
	}
	session.running = true
	session.mu.Unlock()
	updates := make(chan speedSample, 8)
	var updatesMu sync.Mutex
	updatesClosed := false
	reportsDone := make(chan struct{})
	go func() {
		defer close(reportsDone)
		for sample := range updates {
			_ = speedReport(cfg, task, map[string]any{"sample": sample})
		}
	}()
	emit := func(sample speedSample) {
		updatesMu.Lock()
		defer updatesMu.Unlock()
		if updatesClosed {
			return
		}
		select {
		case updates <- sample:
		default:
		}
	}
	upload, download, err := runLinkSpeed(session.ctx, task, emit, func(direction string, result speedMeasurement) {
		_ = speedReport(cfg, task, map[string]any{direction: result})
	})
	updatesMu.Lock()
	updatesClosed = true
	close(updates)
	updatesMu.Unlock()
	// Progress reporting must never slow down the payload stream.
	select {
	case <-reportsDone:
	case <-time.After(3 * time.Second):
	}
	if err != nil {
		fail(err)
		return
	}
	speedReportFinal(cfg, task, map[string]any{"state": "completed", "upload": upload, "download": download})
}

func prepareLinkSpeedComponent(cfg Config, s *linkSpeedSession, task linkSpeedTask, c linkSpeedComponent) error {
	if c.Port < 1 || c.Port > 65535 {
		return errors.New("invalid test listener port")
	}
	if c.ListenHost != "" && c.ListenHost != "127.0.0.1" {
		return errors.New("invalid test listener host")
	}
	if s.ctx.Err() != nil {
		return s.ctx.Err()
	}
	switch c.Kind {
	case "receiver":
		if task.Protocol == "udp" {
			return startSpeedUDPReceiver(s, task, c)
		}
		ln, err := net.Listen("tcp", net.JoinHostPort(c.ListenHost, strconv.Itoa(c.Port)))
		if err != nil {
			return fmt.Errorf("测速接收端口 %d: %w", c.Port, err)
		}
		s.addCleanup(func() { _ = ln.Close() })
		go acceptSpeedConnections(ln, func(conn net.Conn) { serveSpeedTCP(s.ctx, task, conn) })
		return nil
	case "proxy":
		return startSpeedProxy(s, task.Protocol, c)
	case "gost", "fxp":
		directory, err := os.MkdirTemp("", "forwardx-speed-")
		if err != nil {
			return err
		}
		s.addCleanup(func() { _ = os.RemoveAll(directory) })
		config := []byte(c.Config)
		binary := resolveLinkSpeedRuntime()
		args := []string{"-C"}
		if c.Kind == "fxp" {
			var spec fxpSpec
			if err := json.Unmarshal(config, &spec); err != nil {
				return err
			}
			if spec.TransportVersion == forwardXWireGuardVersion {
				ref := "speed-" + task.JobID + "-" + strconv.Itoa(c.Port)
				prepared, err := prepareFXPWireGuard(spec, ref)
				if err != nil {
					return fmt.Errorf("WireGuard 测速通道: %w", err)
				}
				s.addCleanup(func() { releaseWireGuardRuntimeRef(spec.TunnelID, ref) })
				spec = prepared
			}
			// Test payloads are accounted as host network traffic, never as a
			// business rule. Do not enable FXP's rule-stat reporter for this process.
			spec.PanelURL, spec.Token, spec.InstallationID = "", "", ""
			config, err = json.Marshal(spec)
			if err != nil {
				return err
			}
			binary, err = resolveFXPRuntimeExecutable()
			if err != nil {
				return err
			}
			args = []string{"-config"}
		}
		configPath := filepath.Join(directory, "config.json")
		if err := os.WriteFile(configPath, config, 0600); err != nil {
			return err
		}
		cmd := exec.CommandContext(s.ctx, binary, append(args, configPath)...)
		configureSpeedProcess(cmd)
		var output speedProcessOutput
		cmd.Stdout = &output
		cmd.Stderr = &output
		if err := cmd.Start(); err != nil {
			return fmt.Errorf("启动测速转发组件失败: %w", err)
		}
		done := make(chan error, 1)
		exited := make(chan struct{})
		go func() { done <- cmd.Wait(); close(exited) }()
		s.addCleanup(func() {
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
			select {
			case <-exited:
			case <-time.After(2 * time.Second):
			}
		})
		// UDP listeners cannot be probed by connect(): verify the owning process
		// survives startup; the subsequent authenticated end-to-end probe verifies data.
		select {
		case err := <-done:
			return fmt.Errorf("测速转发组件退出: %v %s", err, output.String())
		case <-s.ctx.Done():
			return s.ctx.Err()
		case <-time.After(350 * time.Millisecond):
			return nil
		}
	default:
		return errors.New("unsupported speed test component")
	}
}

type speedProcessOutput struct {
	mu   sync.Mutex
	text string
}

func (w *speedProcessOutput) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.text) < 2000 {
		n := 2000 - len(w.text)
		if n > len(p) {
			n = len(p)
		}
		w.text += string(p[:n])
	}
	return len(p), nil
}
func (w *speedProcessOutput) String() string { w.mu.Lock(); defer w.mu.Unlock(); return w.text }

func acceptSpeedConnections(ln net.Listener, handle func(net.Conn)) {
	slots := make(chan struct{}, 8)
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		select {
		case slots <- struct{}{}:
			go func() { defer func() { <-slots }(); handle(conn) }()
		default:
			_ = conn.Close()
		}
	}
}

func startSpeedProxy(s *linkSpeedSession, protocol string, c linkSpeedComponent) error {
	address := net.JoinHostPort(c.ListenHost, strconv.Itoa(c.Port))
	if protocol == "udp" {
		return startSpeedUDPProxy(s, address, c.Target)
	}
	ln, err := net.Listen("tcp", address)
	if err != nil {
		return fmt.Errorf("测速中转端口 %d: %w", c.Port, err)
	}
	if c.CertPEM != "" {
		pair, err := tls.X509KeyPair([]byte(c.CertPEM), []byte(c.KeyPEM))
		if err != nil {
			_ = ln.Close()
			return err
		}
		ln = tls.NewListener(ln, &tls.Config{Certificates: []tls.Certificate{pair}, MinVersion: tls.VersionTLS12})
	}
	s.addCleanup(func() { _ = ln.Close() })
	go acceptSpeedConnections(ln, func(client net.Conn) {
		defer client.Close()
		_ = client.SetDeadline(time.Now().Add(100 * time.Second))
		var upstream net.Conn
		var err error
		if c.TLSClient {
			d := tls.Dialer{NetDialer: &net.Dialer{Timeout: 5 * time.Second}, Config: &tls.Config{InsecureSkipVerify: true, ServerName: c.ServerName, MinVersion: tls.VersionTLS12}}
			upstream, err = d.DialContext(s.ctx, "tcp", c.Target)
		} else {
			upstream, err = (&net.Dialer{Timeout: 5 * time.Second}).DialContext(s.ctx, "tcp", c.Target)
		}
		if err != nil {
			return
		}
		defer upstream.Close()
		stop := context.AfterFunc(s.ctx, func() { _ = client.Close(); _ = upstream.Close() })
		defer stop()
		done := make(chan struct{})
		go func() {
			_, _ = io.Copy(upstream, client)
			if half, ok := upstream.(interface{ CloseWrite() error }); ok {
				_ = half.CloseWrite()
			}
			close(done)
		}()
		_, _ = io.Copy(client, upstream)
		_ = client.Close()
		_ = upstream.Close()
		<-done
	})
	return nil
}
func startSpeedUDPProxy(s *linkSpeedSession, address, target string) error {
	addr, err := net.ResolveUDPAddr("udp", address)
	if err != nil {
		return err
	}
	conn, err := net.ListenUDP("udp", addr)
	if err != nil {
		return err
	}
	targetAddr, err := net.ResolveUDPAddr("udp", target)
	if err != nil {
		conn.Close()
		return err
	}
	s.addCleanup(func() { _ = conn.Close() })
	// A test has a single source socket; cap sessions so an exposed temporary
	// listener cannot create unbounded outbound sockets before the lease expires.
	go func() {
		sessions := map[string]*net.UDPConn{}
		defer func() {
			for _, c := range sessions {
				_ = c.Close()
			}
		}()
		buffer := make([]byte, 65535)
		for {
			n, peer, err := conn.ReadFromUDP(buffer)
			if err != nil {
				return
			}
			key := peer.String()
			out := sessions[key]
			if out == nil {
				if len(sessions) >= 4 {
					continue
				}
				out, err = net.DialUDP("udp", nil, targetAddr)
				if err != nil {
					continue
				}
				sessions[key] = out
				s.addCleanup(func() { _ = out.Close() })
				go func(out *net.UDPConn, peer *net.UDPAddr) {
					b := make([]byte, 65535)
					for {
						n, err := out.Read(b)
						if err != nil {
							return
						}
						_, _ = conn.WriteToUDP(b[:n], peer)
					}
				}(out, peer)
			}
			_, _ = out.Write(buffer[:n])
		}
	}()
	return nil
}
func runLinkSpeed(ctx context.Context, task linkSpeedTask, emit func(speedSample), complete func(string, speedMeasurement)) (speedMeasurement, speedMeasurement, error) {
	var upload, download speedMeasurement
	for _, direction := range []string{"upload", "download"} {
		if ctx.Err() != nil {
			return upload, download, ctx.Err()
		}
		var result speedMeasurement
		emit(speedSample{Direction: direction})
		var err error
		if task.Protocol == "udp" {
			result, err = runSpeedUDP(ctx, task, direction, emit)
		} else {
			result, err = runSpeedTCP(ctx, task, direction, emit)
		}
		if err != nil {
			label := "上传"
			if direction == "download" {
				label = "下载"
			}
			return upload, download, fmt.Errorf("%s测速失败: %w", label, err)
		}
		if direction == "upload" {
			upload = result
		} else {
			download = result
		}
		if complete != nil {
			complete(direction, result)
		}
	}
	return upload, download, nil
}
func speedPayload(size int) []byte { b := make([]byte, size); _, _ = rand.Read(b); return b }
func speedWait(ctx context.Context, until time.Time) error {
	delay := time.Until(until)
	if delay <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func speedAddressValid(target string) bool {
	h, p, err := net.SplitHostPort(target)
	n, _ := strconv.Atoi(p)
	return err == nil && strings.TrimSpace(h) != "" && n > 0 && n <= 65535
}
