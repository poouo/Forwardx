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

test("Mimic installer applies the configured accelerator to upstream downloads", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/install-mimic.sh"), "utf8");

  // Accelerator URL is prepended to every GitHub asset download
  assert.match(script, /url="\$\{GITHUB_ACCELERATOR_URL\}\/\$\{raw_url\}"/);
  // Mirror list combines accelerator with default mirrors
  assert.match(script, /printf '%s\/,%s\\n' "\$GITHUB_ACCELERATOR_URL" "\$mirrors"/);
  // Downloads come directly from hack3ric/mimic releases (no wg-mimic-fabric wrapper)
  assert.match(script, /MIMIC_REPO="hack3ric\/mimic"/);
  assert.doesNotMatch(script, /wg-mimic-fabric/);
  assert.doesNotMatch(script, /WMF_REPO|WMF_REF|WMF_GITHUB_MIRRORS/);
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

test("Agent install and upgrade do not install or modify host time synchronization", () => {
  const script = generateInstallScript("https://panel.example.com");

  assert.doesNotMatch(script, /\btime-sync\.target\b/);
  assert.doesNotMatch(script, /\bsync_system_time\b/);
  assert.doesNotMatch(script, /\b(?:chrony|chronyd|chronyc|systemd-timesyncd|timedatectl|ntpd)\b/);
  assert.doesNotMatch(script, /\bdate\s+-s\b/);
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

  assert.match(script, /elf_binary_healthy\(\)/);
  assert.match(script, /file -b "\$BIN"/);
  assert.match(script, /MAGIC="\$\(od -An -tx1 -N4/);
  assert.match(script, /MACHINE="\$\(od -An -tx1 -j18 -N2/);
  assert.match(downloader, /elf_binary_healthy "\$TMP_FILE"/);
  assert.match(downloader, /不是当前主机可执行的 ELF 二进制/);
  assert.match(downloader, /TMP_FILE=\"\" STATUS_FILE=\"\"/);
  assert.match(downloader, /mktemp "\$\{DST\}\.tmp\.XXXXXX"/);
  assert.match(downloader, /if ! chmod 0755 "\$TMP_FILE" \|\| ! mv -f "\$TMP_FILE" "\$DST"; then/);
  assert.doesNotMatch(downloader, /install -m 0755 "\$\{DST\}\.tmp" "\$DST"/);
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

test("Agent upgrade keeps a usable existing FXP when its asset is unavailable", () => {
  const script = generateInstallScript("https://panel.example.com");
  const upgrade = scriptSection(script, "do_upgrade() {", "# ============ 入口 ============");

  assert.match(
    upgrade,
    /if ! RELEASE_VERSION="\$FXP_RELEASE_VERSION" download_release_binary "forwardx-fxp-linux-\$\{GO_ARCH\}" "\$FXP_BIN" "ForwardX FXP" "0"; then/,
  );
  assert.match(upgrade, /保留现有 runtime/);
  assert.doesNotMatch(upgrade, /download_release_binary "forwardx-fxp-linux-\$\{GO_ARCH\}" "\$FXP_BIN" "ForwardX FXP" "0" \|\| true/);
});

test("gost runtime upgrades validate a same-directory candidate before replacement", () => {
  const script = generateInstallScript("https://panel.example.com");
  const panel = scriptSection(script, "install_runtime_from_panel() {", "install_runtime_from_github() {");
  const github = scriptSection(script, "install_runtime_from_github() {", "install_runtime() {");
  const installer = scriptSection(script, "install_runtime() {", "install_go_agent() {");
  const commit = scriptSection(script, "commit_runtime_candidate() {", "nginx_self_check() {");

  assert.match(panel, /mktemp "\$\{RUNTIME_BIN\}\.candidate\.XXXXXX"/);
  assert.match(panel, /download_panel_binary "\$URL" "\$STAGED_RUNTIME" "gost runtime"/);
  assert.match(panel, /commit_runtime_candidate "\$STAGED_RUNTIME"/);
  assert.doesNotMatch(panel, /download_panel_binary "\$URL" "\$RUNTIME_BIN"/);

  assert.match(github, /install -m 0755 "\$GOST_BIN" "\$STAGED_RUNTIME"/);
  assert.match(github, /commit_runtime_candidate "\$STAGED_RUNTIME"/);
  assert.doesNotMatch(github, /install -m 0755 "\$GOST_BIN" "\$RUNTIME_BIN"/);

  assert.match(commit, /runtime_self_check "\$CANDIDATE"/);
  assert.match(commit, /mv -f "\$CANDIDATE" "\$RUNTIME_BIN"/);
  assert.doesNotMatch(installer, /rm -f "\$RUNTIME_BIN"/);
  assert.match(installer, /install -m 0755 "\$BIN" "\$STAGED_RUNTIME"/);
  assert.match(installer, /commit_runtime_candidate "\$STAGED_RUNTIME"/);
});

test("realm installer validates a staged candidate before replacing the existing binary", () => {
  const script = generateInstallScript("https://panel.example.com");
  const download = scriptSection(script, "install_realm_from_url() {", "is_github_accelerator_enabled() {");
  const commit = scriptSection(script, "commit_realm_candidate() {", "install_realm_from_url() {");
  const installer = scriptSection(script, "install_realm() {", "runtime_self_check() {");

  assert.match(download, /mktemp "\$\{REALM_PATH\}\.candidate\.XXXXXX"/);
  assert.match(download, /install -m 0755 "\$REALM_BIN" "\$STAGED_REALM"/);
  assert.match(download, /commit_realm_candidate "\$STAGED_REALM"/);
  assert.doesNotMatch(download, /install -m 0755 "\$REALM_BIN" "\$REALM_PATH"/);
  assert.doesNotMatch(download, /rm -f "\$REALM_PATH"/);
  assert.match(commit, /realm_binary_healthy "\$CANDIDATE"/);
  assert.match(commit, /mv -f "\$CANDIDATE" "\$REALM_PATH"/);
  assert.match(script, /realm health check:/);
  assert.doesNotMatch(installer, /rm -f "\$REALM_PATH"/);
});

test("realm installer pins the compatible default and preserves an explicit override", () => {
  const script = generateInstallScript("https://panel.example.com");

  assert.match(script, /FORWARDX_REALM_VERSION="\$\{FORWARDX_REALM_VERSION:-2\.9\.4\}"/);
  assert.match(script, /FORWARDX_REALM_VERSION_EXPLICIT=/);
  assert.match(script, /local VERSION="\$\{FORWARDX_REALM_VERSION:-2\.9\.4\}" LATEST_VERSION/);
  assert.match(script, /printf "%s\\n" "v\$\{VERSION#v\}"/);
  assert.match(script, /glibc2\.28 compatibility/);
  assert.match(script, /realm-\$\{REALM_ARCH\}-glibc2\.28\.tar\.gz/);
  assert.match(script, /default target applies to new installs/);
});

test("GitHub Agent entry script forwards the Realm version override", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/install-agent.sh"), "utf8");

  assert.match(script, /FORWARDX_REALM_VERSION="\$\{FORWARDX_REALM_VERSION:-2\.9\.4\}"/);
  assert.match(script, /FORWARDX_REALM_VERSION_EXPLICIT="false"/);
  assert.match(script, /FORWARDX_REALM_VERSION="\$FORWARDX_REALM_VERSION" \\\n\s+bash "\$tmp_script"/);
  assert.match(script, /FORWARDX_REALM_VERSION_EXPLICIT="\$FORWARDX_REALM_VERSION_EXPLICIT" \\\n\s+FORWARDX_REALM_VERSION=/);
});

test("nginx installer validates a staged candidate and preserves the existing runtime on failure", () => {
  const script = generateInstallScript("https://panel.example.com");
  const nginx = scriptSection(script, "install_nginx_runtime() {", "install_runtime_from_panel() {");
  const commit = scriptSection(script, "commit_nginx_candidate() {", "install_nginx_runtime() {");

  assert.match(nginx, /mktemp "\$\{NGINX_BIN\}\.candidate\.XXXXXX"/);
  assert.match(nginx, /install -m 0755 "\$BIN" "\$STAGED_NGINX"/);
  assert.match(nginx, /commit_nginx_candidate "\$STAGED_NGINX"/);
  assert.doesNotMatch(nginx, /install -m 0755 "\$BIN" "\$NGINX_BIN"/);
  assert.doesNotMatch(nginx, /rm -f "\$NGINX_BIN"/);
  assert.match(commit, /nginx_self_check "\$CANDIDATE"/);
  assert.match(commit, /mv -f "\$CANDIDATE" "\$NGINX_BIN"/);
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

test("Mimic installer uses codename-prefixed release assets", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/install-mimic.sh"), "utf8");

  assert.match(script, /detect_deb_codenames\(\)/);
  assert.match(script, /\$\{codename\}_mimic_\$\{TARGET_VERSION\}-1_\$\{arch\}\.deb/);
  assert.match(script, /\$\{codename\}_mimic-dkms_\$\{TARGET_VERSION\}-1_\$\{arch\}\.deb/);
  assert.match(script, /check_kernel_build_requirements/);
  assert.match(script, /bpftool_bin="\$\(type -P bpftool/);
  assert.match(script, /CHECKSUM_HACK=kprobe/);
  assert.doesNotMatch(script, /matching vmlinux BTF is unavailable[\s\S]*return 1/);
});

test("Mimic source fallback installs a privileged service with stale-hook cleanup", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/install-mimic.sh"), "utf8");

  assert.match(script, /ExecStartPre=-\$\{modprobe_bin\} -r mimic/);
  assert.match(script, /ExecStartPre=-\$\{ip_bin\} link set dev %i xdp off/);
  assert.match(script, /ExecStartPre=-\$\{sh_bin\} -c 'idx=/);
  assert.match(script, /CapabilityBoundingSet=.*CAP_BPF/);
  assert.match(script, /forwardx-bpf\.conf/);
  assert.doesNotMatch(script, /User=mimic/);
  assert.doesNotMatch(script, /Group=mimic/);
});

test("Agent release always builds the published FXP assets from Go", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/build-agent-release.sh"), "utf8");

  assert.match(script, /build_fxp amd64 forwardx-fxp-linux-amd64/);
  assert.match(script, /build_fxp arm64 forwardx-fxp-linux-arm64/);
  assert.match(script, /CGO_ENABLED=0 GOOS=linux GOARCH="\$goarch"/);
  assert.doesNotMatch(script, /FXP_IMPLEMENTATION|forwardx-fxp-rust|cargo|cross build/);
});
