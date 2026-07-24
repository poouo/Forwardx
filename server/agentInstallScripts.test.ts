import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { generateInstallScript } from "./agentInstallScripts";
import { hardenManagedServiceUnit } from "./agentActionCommands";

function scriptSection(script: string, start: string, end: string) {
  const startIndex = script.indexOf(start);
  const endIndex = script.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing script section start: ${start}`);
  assert.notEqual(endIndex, -1, `missing script section end: ${end}`);
  return script.slice(startIndex, endIndex);
}

test("panel GitHub accelerator settings reach the Mimic installer", () => {
  const script = generateInstallScript("https://panel.example.com", {
    githubAcceleratorEnabled: true,
    githubAcceleratorUrl: "https://proxy.example.com/",
  });

  assert.match(script, /GITHUB_ACCELERATOR_DEFAULT_ENABLED="true"/);
  assert.match(script, /GITHUB_ACCELERATOR_DEFAULT_URL='https:\/\/proxy\.example\.com'/);
  assert.match(
    script,
    /GITHUB_ACCELERATOR_ENABLED="\$GITHUB_ACCELERATOR_ENABLED" GITHUB_ACCELERATOR_URL="\$GITHUB_ACCELERATOR_URL" FORWARDX_MIMIC_VERSION=/,
  );
});

test("GitHub entry script preserves panel defaults unless explicitly overridden", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/install-agent.sh"), "utf8");

  assert.match(script, /GITHUB_ACCELERATOR_URL="\$\{GITHUB_ACCELERATOR_URL:-\}"/);
  assert.match(script, /GITHUB_ACCELERATOR_ENABLED="\$\{GITHUB_ACCELERATOR_ENABLED:-\}"/);
  assert.doesNotMatch(script, /GITHUB_ACCELERATOR_ENABLED="\$\{GITHUB_ACCELERATOR_ENABLED:-false\}"/);
});

test("Mimic installer applies the configured accelerator to wrapper and upstream downloads", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/install-mimic.sh"), "utf8");

  assert.match(script, /url="\$\{GITHUB_ACCELERATOR_URL\}\/\$\{raw_url\}"/);
  assert.match(script, /WMF_GITHUB_MIRRORS="\$github_mirrors" MIMIC_UPSTREAM_TAG=/);
  assert.match(script, /printf '%s\/,%s\\n' "\$GITHUB_ACCELERATOR_URL" "\$mirrors"/);
});

test("Agent services avoid duplicate logs and disable core dumps", () => {
  const script = generateInstallScript("https://panel.example.com");

  assert.match(script, /LimitCORE=0/);
  assert.match(script, /StandardOutput=null/);
  assert.match(script, /LogRateLimitBurst=200/);
  assert.match(script, /output_log="\/dev\/null"/);
  assert.match(script, /error_log="\/var\/log\/forwardx-agent\/\$SERVICE_NAME-stderr\.log"/);
  assert.match(script, /ulimit -c 0 2>\/dev\/null \|\| true; exec \$GO_AGENT_BIN/);
  assert.doesNotMatch(script, /output_log="\/var\/log\/forwardx-agent\/\$SERVICE_NAME\.log"/);
});

test("Agent upgrade atomically normalizes config before replacing and restarting the service", () => {
  const script = generateInstallScript("https://panel.example.com");
  const upgrade = scriptSection(script, "do_upgrade() {", "# ============ 入口 ============");

  const runtimeIndex = upgrade.indexOf("if ! install_runtime; then");
  const configIndex = upgrade.indexOf("if ! normalize_upgrade_agent_config; then");
  const serviceIndex = upgrade.indexOf("    write_agent_service");
  const restartIndex = upgrade.indexOf("    start_agent_service");
  const registerIndex = upgrade.indexOf("    if ! register_agent_once; then");

  assert.ok(runtimeIndex >= 0, "upgrade must finish runtime dependencies before config normalization");
  assert.ok(configIndex > runtimeIndex, "config normalization must follow dependency installation");
  assert.ok(serviceIndex > configIndex, "service definition must be replaced after config normalization");
  assert.ok(restartIndex > serviceIndex, "service restart must follow service definition replacement");
  assert.ok(registerIndex > restartIndex, "upgrade must re-register after the new service is running");
  assert.doesNotMatch(upgrade, /\n\s*migrate_legacy_config\s*\n/);
});

test("Agent binary downloads fail when the downloaded file cannot be installed", () => {
  const script = generateInstallScript("https://panel.example.com");
  const downloader = scriptSection(script, "download_url_binary() {", "download_github_binary() {");

  assert.match(downloader, /if ! install -m 0755 "\$\{DST\}\.tmp" "\$DST"; then/);
  assert.match(downloader, /echo "\[警告\] \$LABEL 安装失败: \$DST"/);
  assert.match(downloader, /return 1/);
});

test("Agent upgrade config normalization preserves unknown fields and applies migration state", () => {
  const script = generateInstallScript("https://panel.example.com", {
    migrationFallbackPanelUrl: "https://old-panel.example.com",
    panelMigrationId: "migration-1",
    panelMigrationStartedAt: 123456,
  });
  const normalizer = scriptSection(script, "normalize_upgrade_agent_config() {", "migrate_legacy_config() {");

  assert.match(normalizer, /SOURCE="\$CONFIG_DIR\/config\.json"/);
  assert.match(normalizer, /SOURCE="\$LEGACY_CONFIG_DIR\/config\.json"/);
  assert.match(normalizer, /mktemp "\$CONFIG_DIR\/config\.json\.tmp\.XXXXXX"/);
  assert.match(normalizer, /if ! jq -e /);
  assert.match(normalizer, /if ! jq -n -e /);
  assert.match(normalizer, /\.panelUrl = \$panelUrl \| \.token = \$token \| \.interval = 30/);
  assert.match(normalizer, /\.migrationFallbackPanelUrl = \$fallback/);
  assert.match(normalizer, /del\(\.migrationFallbackPanelUrl, \.panelMigrationId, \.panelMigrationStartedAt\)/);
  assert.doesNotMatch(normalizer, /\{\s*panelUrl\s*:/);
  assert.match(normalizer, /if ! chmod 600 "\$TMP"; then/);
  assert.match(normalizer, /if ! mv -f "\$TMP" "\$CONFIG_DIR\/config\.json"; then/);
});

test("Managed systemd units receive bounded logging defaults idempotently", () => {
  const unit = [
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
  ].join("\n");

  const hardened = hardenManagedServiceUnit(unit);
  assert.match(hardened, /LimitCORE=0/);
  assert.match(hardened, /LogRateLimitIntervalSec=30s/);
  assert.match(hardened, /LogRateLimitBurst=200/);
  assert.equal(hardenManagedServiceUnit(hardened), hardened);
});

test("Mimic installer provisions the NIC offload management dependency", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/install-mimic.sh"), "utf8");

  assert.match(script, /ensure_ethtool\(\)/);
  assert.match(script, /apt-get install -y ethtool/);
  assert.match(script, /ensure_ethtool \|\| log/);
});

test("Agent release always builds the published FXP assets from Go", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/build-agent-release.sh"), "utf8");

  assert.match(script, /build_fxp amd64 forwardx-fxp-linux-amd64/);
  assert.match(script, /build_fxp arm64 forwardx-fxp-linux-arm64/);
  assert.match(script, /CGO_ENABLED=0 GOOS=linux GOARCH="\$goarch"/);
  assert.doesNotMatch(script, /FXP_IMPLEMENTATION|forwardx-fxp-rust|cargo|cross build/);
});
