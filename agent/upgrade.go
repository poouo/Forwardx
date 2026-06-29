package main

import (
	"fmt"
	"strings"
	"sync/atomic"
	"time"
)

func selfUpgrade(cfg Config, up *agentUpgrade) {
	now := time.Now()
	if !atomic.CompareAndSwapInt32(&upgradeStarted, 0, 1) {
		startedAt := time.Unix(atomic.LoadInt64(&upgradeStartedAt), 0)
		if startedAt.IsZero() || now.Sub(startedAt) < selfUpgradeLockTimeout {
			logf("self-upgrade already started at %s, ignoring duplicate request", startedAt.Format(time.RFC3339))
			return
		}
		logf("self-upgrade lock expired after %s, allowing retry", now.Sub(startedAt).Round(time.Second))
		atomic.StoreInt64(&upgradeStartedAt, now.Unix())
	} else {
		atomic.StoreInt64(&upgradeStartedAt, now.Unix())
	}
	panel := strings.TrimRight(up.PanelURL, "/")
	if panel == "" {
		panel = currentPanelURL(cfg)
	}
	upgradeCmd := fmt.Sprintf(`sleep 1; curl -fsSL --connect-timeout 15 --speed-limit 1024 --speed-time 60 "%s/api/agent/install.sh" | PANEL_URL=%s bash -s -- upgrade %s`, panel, shellQuote(panel), shellQuote(cfg.Token))
	cmd := fmt.Sprintf(`if command -v systemd-run >/dev/null 2>&1; then systemd-run --unit=forwardx-agent-upgrade --collect /bin/sh -lc %s; else nohup sh -lc %s >/var/log/forwardx-agent/agent-upgrade.log 2>&1 < /dev/null & fi`, shellQuote(upgradeCmd), shellQuote(upgradeCmd))
	logf("self-upgrade requested target=%s", up.TargetVersion)
	if !runShell(cmd) {
		atomic.StoreInt32(&upgradeStarted, 0)
		atomic.StoreInt64(&upgradeStartedAt, 0)
	}
}
