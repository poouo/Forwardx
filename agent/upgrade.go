package main

import (
	"fmt"
	"strings"
	"sync/atomic"
	"time"
)

func selfUpgrade(cfg Config, up *agentUpgrade) {
	if isLegacyPanelMigrationUpgrade(up) {
		handleLegacyPanelMigrationUpgrade(cfg, up)
		return
	}
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
	releaseVersion := strings.TrimSpace(up.ReleaseVersion)
	installEnv := fmt.Sprintf("PANEL_URL=%s", shellQuote(panel))
	if releaseVersion != "" {
		installEnv += fmt.Sprintf(" FORWARDX_AGENT_RELEASE_VERSION=%s", shellQuote(releaseVersion))
	}
	// Download and syntax-check the installer before execution. The installer
	// reads the existing token from config.json, so it never needs to appear in
	// argv or shell history. A filesystem lock also covers duplicate upgrade
	// requests delivered to separate agent processes.
	installURL := shellQuote(panel + "/api/agent/install.sh")
	upgradeCmd := fmt.Sprintf(`sleep 1; lock=/var/lock/forwardx-agent-upgrade; if ! mkdir -p /var/lock || ! mkdir "$lock" 2>/dev/null; then exit 0; fi; tmp=$(mktemp /tmp/forwardx-agent-upgrade.XXXXXX) || exit 1; cleanup(){ rm -f "$tmp"; rmdir "$lock" 2>/dev/null || true; }; trap cleanup EXIT; if ! curl -fsSL --connect-timeout 15 --speed-limit 1024 --speed-time 60 %s -o "$tmp"; then exit 1; fi; if ! bash -n "$tmp"; then exit 1; fi; env %s bash "$tmp" upgrade`, installURL, installEnv)
	cmd := fmt.Sprintf(`if command -v systemd-run >/dev/null 2>&1; then systemd-run --unit=forwardx-agent-upgrade --collect /bin/sh -lc %s; else nohup sh -lc %s >/var/log/forwardx-agent/agent-upgrade.log 2>&1 < /dev/null & fi`, shellQuote(upgradeCmd), shellQuote(upgradeCmd))
	logf("self-upgrade requested target=%s release=%s", up.TargetVersion, releaseVersion)
	if !runShell(cmd) {
		logf("self-upgrade launcher failed; clearing upgrade lock target=%s release=%s", up.TargetVersion, releaseVersion)
		atomic.StoreInt32(&upgradeStarted, 0)
		atomic.StoreInt64(&upgradeStartedAt, 0)
	}
}

func isLegacyPanelMigrationUpgrade(up *agentUpgrade) bool {
	return up != nil && strings.TrimSpace(up.TargetVersion) == "9999.0.0" && normalizePanelURL(up.PanelURL) != ""
}

func handleLegacyPanelMigrationUpgrade(cfg Config, up *agentUpgrade) bool {
	if !isLegacyPanelMigrationUpgrade(up) {
		return false
	}
	target := normalizePanelURL(up.PanelURL)
	return handlePanelMigrationDirective(cfg, &panelMigrationDirective{
		ID:               "legacy-panel-switch:" + target,
		State:            "preparing",
		TargetPanelURL:   target,
		FallbackPanelURL: currentPanelURL(cfg),
		StartedAt:        time.Now().Unix(),
	})
}
