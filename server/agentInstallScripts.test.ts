import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
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

test("only explicit installation rotates identity; normal upgrades preserve retirement", () => {
  const script = generateInstallScript("https://panel.example.com");
  const install = scriptSection(script, "do_install() {", "do_upgrade() {");
  const upgrade = scriptSection(script, "do_upgrade() {", "# ============ 入口 ============");
  assert.match(install, /rm -f "\$CONFIG_DIR\/installation\.json"/);
  assert.doesNotMatch(upgrade, /rm -f "\$CONFIG_DIR\/installation\.json"/);
});

test("install and upgrade provision optional conntrack and verify persistent source accounting", () => {
  const script = generateInstallScript("https://panel.example.com");
  const packages = scriptSection(script, "install_conntrack_optional() {", "persist_source_accounting_setting() {");
  assert.match(packages, /apt-get install -y -qq conntrack/);
  for (const manager of ["dnf", "yum", "zypper", "apk", "pacman"]) {
    assert.match(packages, new RegExp(`${manager}[^\\n]*conntrack-tools`));
  }
  assert.match(packages, /APK SOCKS downloads are unsupported; not downloading conntrack directly/);
  assert.match(packages, /Agent 将继续安装/);
  const deps = scriptSection(script, "install_deps() {", "install_realm() {");
  assert.match(deps, /\n  install_conntrack_optional\n/);
  const install = scriptSection(script, "do_install() {", "do_upgrade() {");
  const upgrade = scriptSection(script, "do_upgrade() {", "# ============ 入口 ============");
  assert.match(install, /\n  ensure_source_accounting\n/);
  assert.match(upgrade, /\n    install_deps\n    ensure_source_accounting\n/);
  assert.doesNotMatch(install, /sysctl -p|内核参数就绪/);
  const verify = scriptSection(script, "ensure_source_accounting() {", "install_deps() {");
  assert.match(verify, /modprobe nf_conntrack/);
  assert.match(verify, /sysctl -w net.netfilter.nf_conntrack_acct=1/);
  assert.equal((verify.match(/sysctl -n net.netfilter.nf_conntrack_acct/g) || []).length, 2);
  assert.match(verify, /\/etc\/sysctl.d\/99-forwardx-source-accounting.conf/);
  assert.match(verify, /\/etc\/modules-load.d\/forwardx-source-accounting.conf/);
  assert.doesNotMatch(verify, /conntrack -(?:F|D)|systemctl restart|reboot/);
});

test("source accounting shell enables, reads back and persists, while restricted kernels only warn", t => {
  const bash = ["bash", "C:/Program Files/Git/bin/bash.exe"].find(candidate =>
    spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 5000 }).status === 0);
  if (!bash) { t.skip("Bash unavailable for shell execution tests"); return; }
  const generated = generateInstallScript("https://panel.example.com");
  const syntax = spawnSync(bash, ["-n"], { input: generated, encoding: "utf8", timeout: 10000 });
  assert.equal(syntax.status, 0, syntax.stderr);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-accounting-"));
  try {
    const shellDirectory = directory.replace(/\\/g, "/");
    const script = generateInstallScript("https://panel.example.com");
    const helpers = scriptSection(script, "persist_source_accounting_setting() {", "install_deps() {")
      .replaceAll("/etc/sysctl.d", `${shellDirectory}/sysctl.d`)
      .replaceAll("/etc/modules-load.d", `${shellDirectory}/modules-load.d`);
    const harness = `
      sysctl() {
        if [ "$1" = "-n" ]; then cat "$TEST_DIR/state"; return 0; fi
        printf 'write\\n' >> "$TEST_DIR/writes"
        if [ "$TEST_MODE" = "denied" ]; then echo 'permission denied' >&2; return 1; fi
        if [ "$TEST_MODE" != "ineffective" ]; then printf '1' > "$TEST_DIR/state"; fi
      }
      modprobe() { return 0; }
      ${helpers}
      ensure_source_accounting
      ensure_source_accounting
      echo 'INSTALL_CONTINUED'
    `;
    for (const mode of ["success", "denied", "ineffective"]) {
      fs.writeFileSync(path.join(directory, "state"), "0");
      fs.writeFileSync(path.join(directory, "writes"), "");
      const result: SpawnSyncReturns<string> = spawnSync(bash, ["-e", "-s"], { input: harness, encoding: "utf8", timeout: 10000,
        env: { ...process.env, TEST_DIR: shellDirectory, TEST_MODE: mode } });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /INSTALL_CONTINUED/);
      if (mode === "success") {
        assert.match(result.stdout, /已验证 nf_conntrack_acct=1/);
        assert.equal(fs.readFileSync(path.join(directory, "sysctl.d/99-forwardx-source-accounting.conf"), "utf8"), "net.netfilter.nf_conntrack_acct=1\n");
        assert.equal(fs.readFileSync(path.join(directory, "modules-load.d/forwardx-source-accounting.conf"), "utf8"), "nf_conntrack\n");
        assert.equal(fs.readFileSync(path.join(directory, "writes"), "utf8"), "write\n", "already-enabled accounting is not repeatedly changed");
      } else {
        assert.match(result.stdout, /来源流量计数未开启/);
        assert.doesNotMatch(result.stdout, /已验证 nf_conntrack_acct=1/);
      }
    }
    // Persistence failure must not hide that the live setting succeeded.
    fs.writeFileSync(path.join(directory, "state"), "1");
    const failure = spawnSync(bash, ["-e", "-s"], { input: `${helpers}\nsysctl() { printf '1'; }\npersist_source_accounting_setting() { return 1; }\nensure_source_accounting\necho INSTALL_CONTINUED`,
      encoding: "utf8", timeout: 10000, env: { ...process.env, TEST_DIR: shellDirectory } });
    assert.equal(failure.status, 0, failure.stderr);
    assert.match(failure.stdout, /启动配置保存失败/);
    assert.match(failure.stdout, /INSTALL_CONTINUED/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("Agent uninstall removes pre-DNAT limit hooks with full selectors before deleting counter chains", () => {
  const script = generateInstallScript("https://panel.example.com");
  assert.match(script, /for BASE in PREROUTING OUTPUT; do/);
  assert.match(script, /grep -E -- "-j FWX_PD_\[0-9a-f\]\{20\}\$"/);
  assert.match(script, /FWX_P\[DC\]_\[0-9a-f\]\{20\}/);
  assert.match(script, /\$BIN -w 5 -t mangle \$RULE/);
  const flush = script.indexOf('for CH in $LIMIT_CHAINS; do $BIN -w 5 -t mangle -F');
  const remove = script.indexOf('for CH in $LIMIT_CHAINS; do $BIN -w 5 -t mangle -X');
  assert.ok(flush > 0 && remove > flush);
});

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

test("Agent installer uses one service-start function for all supported init systems", () => {
  const script = generateInstallScript("https://panel.example.com");
  assert.doesNotMatch(script, /start_agent_service_systemd_unused/);
  assert.equal((script.match(/^start_agent_service\(\) \{/gm) || []).length, 1);
  const start = scriptSection(script, "start_agent_service() {", "remove_service_by_name() {");
  assert.match(start, /systemctl restart/);
  assert.match(start, /systemctl is-active --quiet/);
  assert.match(start, /rc-service "\$SERVICE_NAME" restart/);
  assert.match(start, /"\/etc\/init\.d\/\$SERVICE_NAME" restart/);
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

test("iperf3 is optional and cannot abort Agent installation", () => {
  const script = generateInstallScript("https://panel.example.com");
  const start = script.indexOf("install_deps() {");
  const end = script.indexOf("install_realm() {", start);
  assert.ok(start >= 0 && end > start, "missing dependency installation section");
  const deps = script.slice(start, end);

  // Core dependency validation must not treat the optional Looking Glass
  // component as a hard requirement.
  assert.match(deps, /for B in curl jq iptables od; do/);
  assert.doesNotMatch(deps, /for B in curl jq iptables iperf3 od; do/);
  assert.match(deps, /单独安装，失败不得阻断 Agent 主流程/);
  assert.match(deps, /未能安装可选依赖: iperf3/);
  assert.match(deps, /Agent 将继续安装/);
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
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/install-agent.sh"), "utf8").replace(/\r\n/g, "\n");

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
