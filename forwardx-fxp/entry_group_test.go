package main

import (
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestReadConfigEntryGroup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "entry-group.json")
	contents := `{
		"role":" ENTRY-GROUP ",
		"tunnelId":8,
		"entries":[{
			"role":" ENTRY ",
			"tunnelId":8,
			"ruleId":9,
			"listenHost":" 127.0.0.1 ",
			"listenPort":18080,
			"protocol":" TCP+UDP ",
			"exitHost":" 127.0.0.1 ",
			"exitPort":18081,
			"targetIp":" 127.0.0.1 ",
			"targetPort":443,
			"key":"key"
		}]
	}`
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := readConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateConfig(cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.Role != "entry-group" || len(cfg.Entries) != 1 {
		t.Fatalf("group config was not decoded: %+v", cfg)
	}
	entry := cfg.Entries[0]
	if entry.Role != "entry" || entry.Protocol != "both" || entry.ListenHost != "127.0.0.1" || entry.TargetIP != "127.0.0.1" {
		t.Fatalf("grouped entry was not normalized: %+v", entry)
	}
}

func TestValidateEntryGroupConfig(t *testing.T) {
	validEntry := func(ruleID, port int, protocol string) config {
		return normalizeConfig(config{
			Role:       "entry",
			TunnelID:   91,
			RuleID:     ruleID,
			ListenHost: "127.0.0.1",
			ListenPort: port,
			Protocol:   protocol,
			ExitHost:   "127.0.0.1",
			ExitPort:   19091,
			TargetIP:   "127.0.0.1",
			TargetPort: 443,
			Key:        "entry-group-key",
		})
	}

	tests := []struct {
		name    string
		cfg     config
		wantErr string
	}{
		{
			name:    "empty",
			cfg:     config{Role: "entry-group", TunnelID: 91},
			wantErr: "at least one entry",
		},
		{
			name: "child role",
			cfg: config{Role: "entry-group", TunnelID: 91, Entries: []config{
				{Role: "exit", TunnelID: 91},
			}},
			wantErr: "requires role entry",
		},
		{
			name: "tunnel mismatch",
			cfg: config{Role: "entry-group", TunnelID: 91, Entries: []config{
				func() config { entry := validEntry(1, 19101, "tcp"); entry.TunnelID = 92; return entry }(),
			}},
			wantErr: "does not match group tunnel",
		},
		{
			name: "invalid child",
			cfg: config{Role: "entry-group", TunnelID: 91, Entries: []config{
				func() config { entry := validEntry(1, 19101, "tcp"); entry.Key = ""; return entry }(),
			}},
			wantErr: "empty key",
		},
		{
			name: "tcp conflict",
			cfg: config{Role: "entry-group", TunnelID: 91, Entries: []config{
				validEntry(1, 19101, "tcp"),
				validEntry(2, 19101, "both"),
			}},
			wantErr: "conflict on tcp listen",
		},
		{
			name: "udp conflict",
			cfg: config{Role: "entry-group", TunnelID: 91, Entries: []config{
				func() config { entry := validEntry(1, 19101, "udp"); entry.UDPListenPort = 19103; return entry }(),
				func() config { entry := validEntry(2, 19102, "both"); entry.UDPListenPort = 19103; return entry }(),
			}},
			wantErr: "conflict on udp listen",
		},
		{
			name: "wildcard conflict",
			cfg: config{Role: "entry-group", TunnelID: 91, Entries: []config{
				func() config { entry := validEntry(1, 19101, "tcp"); entry.ListenHost = ""; return entry }(),
				validEntry(2, 19101, "tcp"),
			}},
			wantErr: "conflict on tcp listen",
		},
		{
			name: "tcp and udp same port are separate lanes",
			cfg: config{Role: "entry-group", TunnelID: 91, Entries: []config{
				validEntry(1, 19101, "tcp"),
				validEntry(2, 19101, "udp"),
			}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateConfig(tt.cfg)
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected validation error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("validation error = %v, want substring %q", err, tt.wantErr)
			}
		})
	}
}

func TestNormalizeConfigNormalizesGroupedEntries(t *testing.T) {
	cfg := normalizeConfig(config{
		Role:     " ENTRY-GROUP ",
		TunnelID: 8,
		Entries: []config{{
			Role:       " ENTRY ",
			TunnelID:   8,
			ListenPort: 18080,
			Protocol:   " TCP+UDP ",
			ExitHost:   " 127.0.0.1 ",
			ExitPort:   18081,
			Key:        "key",
		}},
	})
	if cfg.Role != "entry-group" || len(cfg.Entries) != 1 {
		t.Fatalf("group was not normalized: %+v", cfg)
	}
	entry := cfg.Entries[0]
	if entry.Role != "entry" || entry.Protocol != "both" || entry.ExitHost != "127.0.0.1" {
		t.Fatalf("entry was not recursively normalized: %+v", entry)
	}
	if entry.UDPListenPort != entry.ListenPort || entry.UDPExitPort != entry.ExitPort {
		t.Fatalf("entry UDP defaults were not recursively applied: %+v", entry)
	}
}

func TestRunEntryClosesTCPListenerWhenUDPBindFails(t *testing.T) {
	tcpPort := freeTCPPort(t)
	occupiedUDP, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer occupiedUDP.Close()
	udpPort := occupiedUDP.LocalAddr().(*net.UDPAddr).Port

	err = runEntry(make(chan struct{}), config{
		Role:          "entry",
		TunnelID:      92,
		RuleID:        1,
		ListenHost:    "127.0.0.1",
		ListenPort:    tcpPort,
		UDPListenPort: udpPort,
		Protocol:      "both",
		ExitHost:      "127.0.0.1",
		ExitPort:      19092,
		UDPExitPort:   19092,
		TargetIP:      "127.0.0.1",
		TargetPort:    443,
		Key:           "entry-bind-cleanup-key",
	})
	if err == nil {
		t.Fatal("expected occupied UDP port to fail")
	}
	ln, listenErr := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(tcpPort)))
	if listenErr != nil {
		t.Fatalf("TCP listener leaked after UDP bind failure: %v", listenErr)
	}
	_ = ln.Close()
}

func TestRunEntryGroupListensOnManyEntriesInOneRuntime(t *testing.T) {
	ports := uniqueFreeTCPPorts(t, 128)
	exitPort := freeTCPPort(t)
	for containsInt(ports, exitPort) {
		exitPort = freeTCPPort(t)
	}
	entries := make([]config, 0, len(ports))
	for i, port := range ports {
		entries = append(entries, normalizeConfig(config{
			Role:       "entry",
			TunnelID:   93,
			RuleID:     i + 1,
			ListenHost: "127.0.0.1",
			ListenPort: port,
			Protocol:   "tcp",
			ExitHost:   "127.0.0.1",
			ExitPort:   exitPort,
			TargetIP:   "127.0.0.1",
			TargetPort: 443,
			Key:        "many-entry-group-key",
		}))
	}
	cfg := config{Role: "entry-group", TunnelID: 93, Entries: entries}
	if err := validateConfig(cfg); err != nil {
		t.Fatal(err)
	}

	done := make(chan struct{})
	result := make(chan error, 1)
	go func() { result <- runEntryGroup(done, cfg) }()
	for _, port := range ports {
		waitForTCP(t, port)
	}
	close(done)
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("entry group shutdown failed: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("entry group did not stop all entries")
	}
}

func TestRunEntryGroupStopsOtherEntriesOnRuntimeError(t *testing.T) {
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	badPort := occupied.Addr().(*net.TCPAddr).Port
	defer occupied.Close()
	goodPort := freeTCPPort(t)
	entry := func(ruleID, port int) config {
		return normalizeConfig(config{
			Role:       "entry",
			TunnelID:   94,
			RuleID:     ruleID,
			ListenHost: "127.0.0.1",
			ListenPort: port,
			Protocol:   "tcp",
			ExitHost:   "127.0.0.1",
			ExitPort:   19094,
			TargetIP:   "127.0.0.1",
			TargetPort: 443,
			Key:        "entry-runtime-error-key",
		})
	}

	err = runEntryGroup(make(chan struct{}), config{
		Role:     "entry-group",
		TunnelID: 94,
		Entries:  []config{entry(1, goodPort), entry(2, badPort)},
	})
	if err == nil || !strings.Contains(err.Error(), "entry-group entry") {
		t.Fatalf("expected grouped runtime error, got %v", err)
	}
	ln, listenErr := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(goodPort)))
	if listenErr != nil {
		t.Fatalf("sibling entry remained open after group error: %v", listenErr)
	}
	_ = ln.Close()
}

func uniqueFreeTCPPorts(t *testing.T, count int) []int {
	t.Helper()
	ports := make([]int, 0, count)
	seen := make(map[int]bool, count)
	for len(ports) < count {
		port := freeTCPPort(t)
		if !seen[port] {
			seen[port] = true
			ports = append(ports, port)
		}
	}
	return ports
}

func containsInt(values []int, target int) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
