package main

import (
	"strings"
	"testing"
)

func TestHardenManagedSystemdUnitAddsRuntimeLimitsOnce(t *testing.T) {
	unit := strings.Join([]string{
		"[Unit]",
		"Description=ForwardX runtime",
		"",
		"[Service]",
		"Type=simple",
		"ExecStart=/usr/local/bin/forwardx-runtime -C /etc/forwardx/runtime/gost.json",
		"Restart=always",
		"",
		"[Install]",
		"WantedBy=multi-user.target",
		"",
	}, "\n")

	hardened := hardenManagedSystemdUnit(unit)
	for _, directive := range []string{"LimitCORE=0", "LogRateLimitIntervalSec=30s", "LogRateLimitBurst=200"} {
		if strings.Count(hardened, directive) != 1 {
			t.Fatalf("directive %q count=%d in %q", directive, strings.Count(hardened, directive), hardened)
		}
	}
	if again := hardenManagedSystemdUnit(hardened); again != hardened {
		t.Fatalf("systemd hardening was not idempotent\nfirst: %q\nsecond: %q", hardened, again)
	}
	if got := systemdUnitExecStart(hardened); !strings.Contains(got, "forwardx-runtime") {
		t.Fatalf("ExecStart was changed or lost: %q", got)
	}
}

func TestOpenRCAndSysVScriptsDisableCoreDumps(t *testing.T) {
	execStart := "/usr/local/bin/realm -c /etc/forwardx/realm.toml"
	for name, script := range map[string]string{
		"openrc": openRCServiceScript("forwardx-realm-1000", execStart),
		"sysv":   sysVServiceScript("forwardx-realm-1000", execStart),
	} {
		if !strings.Contains(script, "ulimit -c 0") {
			t.Fatalf("%s script does not disable core dumps: %q", name, script)
		}
		if !strings.Contains(script, execStart) {
			t.Fatalf("%s script lost ExecStart: %q", name, script)
		}
	}
}
