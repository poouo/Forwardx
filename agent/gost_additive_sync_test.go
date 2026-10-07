package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func gostTestConfig(t *testing.T, raw string) map[string]any {
	t.Helper()
	var config map[string]any
	if err := json.Unmarshal([]byte(raw), &config); err != nil {
		t.Fatal(err)
	}
	return config
}

func TestGostAdditionPlanPreservesExistingChainsAndListeners(t *testing.T) {
	live := gostTestConfig(t, `{"services":[{"name":"fwx-1-tcp","addr":":11001","handler":{"type":"tcp","metadata":{}},"status":{"state":"ready","stats":{"inputBytes":1000}}},{"name":"fwx-2-tcp","addr":":11002"}],"chains":null,"limiters":[],"log":null}`)
	desired := gostTestConfig(t, `{"services":[{"name":"fwx-2-tcp","addr":":11002"},{"name":"fwx-1-tcp","addr":":11001","handler":{"type":"tcp"}},{"name":"fwx-3-tcp","addr":":11003","handler":{"chain":"new-chain"},"limiter":"new-limit"}],"chains":[{"name":"new-chain","hops":[]}],"limiters":[{"name":"new-limit","limits":["$ 1MB 1MB"]}]}`)
	plan, reason, err := planGostAdditions(live, desired)
	if err != nil || reason != "" {
		t.Fatalf("plan=%v reason=%s error=%v", plan, reason, err)
	}
	if len(plan) != 3 || plan[0].collection != "limiters" || plan[1].collection != "chains" || plan[2].name != "fwx-3-tcp" {
		t.Fatalf("wrong additive order: %+v", plan)
	}
	if live["services"].([]any)[0].(map[string]any)["status"] == nil {
		t.Fatal("planning mutated the live snapshot")
	}
}

func TestGostAdditionPlanDoesNotIgnoreEditsRemovalsOrUnhealthyListeners(t *testing.T) {
	for _, tc := range []struct{ live, desired, reason string }{
		{`{"services":[{"name":"fwx-1","addr":":1"}]}`, `{"services":[{"name":"fwx-1","addr":":2"}]}`, "services-changed"},
		{`{"services":[{"name":"fwx-1","addr":":1"}]}`, `{"services":[]}`, "services-removed"},
		{`{"limiters":[{"name":"limit","limits":["$ 1MB 1MB"]}]}`, `{"limiters":[{"name":"limit","limits":["$ 2MB 2MB"]}]}`, "limiters-changed"},
		{`{"services":[{"name":"fwx-1","status":{"state":"closed"}}]}`, `{"services":[{"name":"fwx-1"}]}`, "unhealthy-listener"},
		{`{"services":[],"log":{"level":"debug"}}`, `{"services":[]}`, "global-config-changed"},
		{`{"services":[{"name":"fwx-1","metadata":{"keepalive":false}}]}`, `{"services":[{"name":"fwx-1"}]}`, "services-changed"},
	} {
		_, reason, err := planGostAdditions(gostTestConfig(t, tc.live), gostTestConfig(t, tc.desired))
		if err != nil || reason != tc.reason {
			t.Fatalf("reason=%s err=%v want=%s", reason, err, tc.reason)
		}
	}
	for _, raw := range []string{`{"services":[{"name":"../escape"}]}`, `{"services":[{"name":"duplicate"},{"name":"duplicate"}]}`} {
		if _, _, err := planGostAdditions(map[string]any{}, gostTestConfig(t, raw)); err == nil {
			t.Fatal("unsafe/duplicate name accepted")
		}
	}
}

func TestGostAdditionPlanNormalizesTypedDurationsButNotMetadata(t *testing.T) {
	live := gostTestConfig(t, `{"chains":[{"name":"existing","hops":[{"name":"hop","selector":{"strategy":"fifo","maxFails":0,"failTimeout":5000000000},"nodes":[]}]}]}`)
	desired := gostTestConfig(t, `{"chains":[{"name":"existing","hops":[{"name":"hop","selector":{"strategy":"fifo","failTimeout":"5s"}}]}],"services":[{"name":"new","addr":":2"}]}`)
	plan, reason, err := planGostAdditions(live, desired)
	if err != nil || reason != "" || len(plan) != 1 {
		t.Fatalf("plan=%v reason=%s err=%v", plan, reason, err)
	}
}

func TestGostAddFailureRollsBackOnlyAttemptedAdditions(t *testing.T) {
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.Path)
		if r.Method == "POST" && r.URL.Path == "/config/services" {
			w.WriteHeader(500)
			_, _ = io.WriteString(w, `{"code":40003,"msg":"secret must not appear in log"}`)
			return
		}
		if r.Method == "DELETE" && strings.HasSuffix(r.URL.Path, "new-service") {
			w.WriteHeader(400)
			_, _ = io.WriteString(w, `{"code":40004}`)
			return
		}
		_, _ = io.WriteString(w, `{"msg":"OK"}`)
	}))
	defer server.Close()
	api := gostAPIClient{server.Client(), server.URL}
	var restore func() bool
	err := applyGostAdditions(context.Background(), api, []gostAddition{
		{"limiters", "new-limit", map[string]any{"name": "new-limit"}},
		{"chains", "new-chain", map[string]any{"name": "new-chain"}},
		{"services", "new-service", map[string]any{"name": "new-service"}},
	}, func(fn func() bool) { restore = fn })
	if err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("unsafe or missing API failure: %v", err)
	}
	if restore == nil || !restore() {
		t.Fatal("incremental rollback failed")
	}
	want := "POST /config/limiters|POST /config/chains|POST /config/services|DELETE /config/services/new-service|DELETE /config/chains/new-chain|DELETE /config/limiters/new-limit"
	if strings.Join(requests, "|") != want {
		t.Fatalf("requests=%v", requests)
	}
}

func TestGostDuplicateCreationDoesNotDeleteOtherOperatorsListener(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "DELETE" {
			t.Error("deleted an object that was not created by this transaction")
		}
		w.WriteHeader(400)
		_, _ = io.WriteString(w, `{"code":40002}`)
	}))
	defer server.Close()
	var restore func() bool
	err := applyGostAdditions(context.Background(), gostAPIClient{server.Client(), server.URL}, []gostAddition{{"services", "new", map[string]any{"name": "new"}}}, func(fn func() bool) { restore = fn })
	if err == nil || !restore() {
		t.Fatalf("duplicate rollback error=%v", err)
	}
}

func TestGostIncrementalRollbackRestoresDiskWithoutSharedRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "gost.json")
	old := []byte(`{"services":[]}`)
	if err := os.WriteFile(path, old, 0644); err != nil {
		t.Fatal(err)
	}
	tx, err := applyManagedConfigs([]managedConfigSpec{{Path: path, ServiceName: "must-not-restart", Format: "json", ContentBase64: base64.StdEncoding.EncodeToString([]byte(`{"services":[{"name":"new"}]}`))}})
	if err != nil {
		t.Fatal(err)
	}
	restored := 0
	tx.setRuntimeRestore(path, func() bool { restored++; return true })
	if !tx.rollback() || !tx.rollback() || restored != 1 {
		t.Fatalf("restore calls=%d", restored)
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != string(old) {
		t.Fatalf("disk config not restored: %s", raw)
	}
}

func TestGostSyncMarkerRejectsUnexpectedTargetsBeforeShell(t *testing.T) {
	for _, command := range []string{gostAdditiveSyncMarker + "other /tmp/config\nexit 0", gostAdditiveSyncMarker + runtimeServiceName + " /tmp/config\nexit 0", gostAdditiveSyncMarker + runtimeServiceName + " " + runtimeConfigPath} {
		if runGostAdditiveSyncCommands([]string{command}, nil, newActionMessage()) {
			t.Fatal("invalid marker accepted")
		}
	}
}

func TestGostAPISocketRequiresUnixScheme(t *testing.T) {
	for _, addr := range []string{"127.0.0.1:1234", "0.0.0.0:1234", gostAPIDir + "/" + runtimeServiceName + ".sock"} {
		if gostAPISocket(map[string]any{"api": map[string]any{"addr": addr}}) != "" {
			t.Fatal("non-Unix API accepted")
		}
	}
}

// Opt-in real-runtime coverage. CI uses the same upstream GOST 3.2.6 binary
// bundled with the Agent. This proves two established TCP connections survive
// adding a third rule and a subsequent port-conflict rollback, not just that
// the generated command text looks correct.
func TestGostRealRuntimeAddAndPortConflictPreserveEstablishedConnections(t *testing.T) {
	binary := os.Getenv("FORWARDX_TEST_GOST_BINARY")
	if binary == "" {
		t.Skip("set FORWARDX_TEST_GOST_BINARY to exercise upstream GOST")
	}
	dir, err := os.MkdirTemp("", "fwx-gost-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	socket := filepath.Join(dir, "api.sock")
	api, closeIdle := localGostAPI(socket)
	defer closeIdle()
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			conn, err := echo.Accept()
			if err != nil {
				return
			}
			go func() { defer conn.Close(); _, _ = io.Copy(conn, conn) }()
		}
	}()
	freeAddress := func() string {
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		addr := l.Addr().String()
		l.Close()
		return addr
	}
	service := func(name, addr string) map[string]any {
		return map[string]any{"name": name, "addr": addr, "handler": map[string]any{"type": "tcp"}, "listener": map[string]any{"type": "tcp"}, "forwarder": map[string]any{"nodes": []any{map[string]any{"name": name + "-target", "addr": echo.Addr().String(), "connector": map[string]any{"type": "tcp"}, "dialer": map[string]any{"type": "tcp"}}}}}
	}
	udpEcho, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer udpEcho.Close()
	go func() {
		buffer := make([]byte, 2048)
		for {
			size, addr, err := udpEcho.ReadFrom(buffer)
			if err != nil {
				return
			}
			_, _ = udpEcho.WriteTo(buffer[:size], addr)
		}
	}()
	udpPort, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	udpAddr := udpPort.LocalAddr().String()
	udpPort.Close()
	udpService := map[string]any{"name": "fwx-udp", "addr": udpAddr, "handler": map[string]any{"type": "udp"}, "listener": map[string]any{"type": "udp"}, "forwarder": map[string]any{"nodes": []any{map[string]any{"name": "udp-target", "addr": udpEcho.LocalAddr().String(), "connector": map[string]any{"type": "udp"}, "dialer": map[string]any{"type": "udp"}}}}}
	addr1, addr2 := freeAddress(), freeAddress()
	config := map[string]any{"services": []any{service("fwx-1", addr1), service("fwx-2", addr2), udpService}, "api": map[string]any{"addr": "unix://" + socket}}
	path := filepath.Join(dir, "gost.json")
	raw, _ := json.Marshal(config)
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(dir, "gost.log")
	logFile, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	defer logFile.Close()
	cmd := exec.Command(binary, "-C", path)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var liveData []byte
	for {
		liveData, err = api.request(ctx, "GET", "", nil)
		if err == nil {
			break
		}
		if ctx.Err() != nil {
			log, _ := os.ReadFile(logPath)
			t.Fatalf("GOST API not ready: %v\n%s", err, log)
		}
		time.Sleep(50 * time.Millisecond)
	}
	connect := func(addr string) net.Conn {
		var conn net.Conn
		var err error
		for i := 0; i < 60; i++ {
			conn, err = net.DialTimeout("tcp", addr, 100*time.Millisecond)
			if err == nil {
				return conn
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatal(err)
		return nil
	}
	c1, c2 := connect(addr1), connect(addr2)
	defer c1.Close()
	defer c2.Close()
	check := func(conn net.Conn) {
		t.Helper()
		_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
		if _, err := conn.Write([]byte("still-connected")); err != nil {
			t.Fatal(err)
		}
		data := make([]byte, 15)
		if _, err := io.ReadFull(conn, data); err != nil {
			t.Fatal(err)
		}
		if string(data) != "still-connected" {
			t.Fatalf("unexpected echo %q", data)
		}
	}
	check(c1)
	check(c2)
	udp, err := net.Dial("udp", udpAddr)
	if err != nil {
		t.Fatal(err)
	}
	defer udp.Close()
	checkUDP := func() {
		t.Helper()
		_ = udp.SetDeadline(time.Now().Add(3 * time.Second))
		if _, err := udp.Write([]byte("udp-alive")); err != nil {
			t.Fatal(err)
		}
		buffer := make([]byte, 32)
		size, err := udp.Read(buffer)
		if err != nil || string(buffer[:size]) != "udp-alive" {
			t.Fatalf("UDP echo size=%d err=%v", size, err)
		}
	}
	checkUDP()
	var live map[string]any
	if err := json.Unmarshal(liveData, &live); err != nil {
		t.Fatal(err)
	}
	addr3 := freeAddress()
	config["services"] = append(config["services"].([]any), service("fwx-3", addr3))
	plan, reason, err := planGostAdditions(live, config)
	if err != nil || reason != "" || len(plan) != 1 {
		t.Fatalf("actual runtime plan reason=%s error=%v plan=%v live=%s", reason, err, plan, liveData)
	}
	newData, _ := json.Marshal(config)
	tx, err := applyManagedConfigs([]managedConfigSpec{{Path: path, ServiceName: "must-not-restart", Format: "json", ContentBase64: base64.StdEncoding.EncodeToString(newData)}})
	if err != nil {
		t.Fatal(err)
	}
	if err := applyGostAdditions(ctx, api, plan, func(fn func() bool) { tx.setRuntimeRestore(path, fn) }); err != nil {
		t.Fatal(err)
	}
	tx.commit()
	c3 := connect(addr3)
	defer c3.Close()
	check(c3)
	check(c1)
	check(c2)
	checkUDP()
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	failedData, _ := json.Marshal(map[string]any{"services": append(config["services"].([]any), service("fwx-4", freeAddress()), service("fwx-conflict", occupied.Addr().String())), "api": config["api"]})
	failedTx, err := applyManagedConfigs([]managedConfigSpec{{Path: path, ServiceName: "must-not-restart", Format: "json", ContentBase64: base64.StdEncoding.EncodeToString(failedData)}})
	if err != nil {
		t.Fatal(err)
	}
	conflict := gostAddition{"services", "fwx-conflict", service("fwx-conflict", occupied.Addr().String())}
	addedBeforeConflict := gostAddition{"services", "fwx-4", service("fwx-4", freeAddress())}
	if err := applyGostAdditions(ctx, api, []gostAddition{addedBeforeConflict, conflict}, func(fn func() bool) { failedTx.setRuntimeRestore(path, fn) }); err == nil {
		t.Fatal("expected actual port conflict")
	}
	if !failedTx.rollback() {
		t.Fatal("actual rollback failed")
	}
	restoredData, _ := os.ReadFile(path)
	if string(restoredData) != string(newData) {
		t.Fatal("port-conflict rollback did not restore committed config")
	}
	liveAfter, _ := api.request(ctx, "GET", "", nil)
	var after map[string]any
	_ = json.Unmarshal(liveAfter, &after)
	objects, err := gostObjects(after, "services")
	if err != nil || objects["fwx-4"] != nil || objects["fwx-conflict"] != nil {
		t.Fatalf("rollback left added listeners: %v %v", objects, err)
	}
	check(c1)
	check(c2)
	check(c3)
	checkUDP()
	t.Log(fmt.Sprintf("GOST PID %d retained all three established connections after add and conflict", cmd.Process.Pid))
}
