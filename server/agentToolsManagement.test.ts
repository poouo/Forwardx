import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { generateInstallScript } from "./agentInstallScripts";

const bash = process.platform === "win32" ? ["C:/Program Files/Git/bin/bash.exe", "C:/Program Files/Git/usr/bin/bash.exe"].find(existsSync) : "bash";
const source = (name: string) => readFileSync(`scripts/${name}`, "utf8").replace(/\r\n/g, "\n");
const quote = (value: string) => `'${value.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
const jqDirectory = process.env.FORWARDX_TEST_JQ_DIR || (process.platform === "win32" ? join(tmpdir(), "forwardx-proxy-tests") : "");
function run(input: string, args = ["-e", "-s"]) {
  assert.ok(bash, "Bash required for management command tests");
  return spawnSync(bash, args, { input, encoding: "utf8", timeout: 15000,
    env: { ...process.env, MSYS_NO_PATHCONV: "1", PATH: jqDirectory ? `${jqDirectory}${delimiter}${process.env.PATH || ""}` : process.env.PATH } });
}
const hasJq = !!bash && run("command -v jq >/dev/null").status === 0;
const generated = generateInstallScript("https://panel.example.com");
const selective = generated.slice(generated.indexOf("install_forward_tool_package() {"), generated.indexOf("# ============ 安装 ============"));

test("tool discovery matches Agent executable paths without executing tools or reading registration", () => {
  const directory = mkdtempSync(join(tmpdir(), "forwardx-tools-discovery-"));
  try {
    mkdirSync(join(directory, "bin"));
    writeFileSync(join(directory, "bin/realm"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    writeFileSync(join(directory, "bin/socat"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    const manager = source("forwardx-manage.sh");
    const helpers = manager.slice(manager.indexOf("agent_tool_path() {"), manager.indexOf("agent_tools() {"))
      .replaceAll("/usr/local/bin/", `${directory.replace(/\\/g, "/")}/bin/`)
      .replaceAll("/usr/bin/socat", `${directory.replace(/\\/g, "/")}/bin/socat`)
      .replaceAll("/usr/sbin/nginx", "/nonexistent-forwardx-test/nginx")
      .replaceAll("/usr/local/nginx/sbin/nginx", "/nonexistent-forwardx-test/nginx");
    const result = run(`command() { if [ "$1" = -v ]; then return 1; fi; builtin command "$@"; }\n${helpers}\nagent_tools_status`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /realm\s+已检测到/);
    assert.match(result.stdout, /socat\s+已检测到/);
    assert.match(result.stdout, /ForwardX Runtime \(GOST\)\s+未检测到/);
    assert.match(result.stdout, /CAP_NET_ADMIN/);
    assert.doesNotMatch(helpers, /json_value|--version|systemctl|curl|source /);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("fwxm offers Agent-only environment menu, selective installs, aliases and safe cancellation", { skip: !hasJq }, () => {
  const directory = mkdtempSync(join(tmpdir(), "forwardx-tools-menu-"));
  const config = join(directory, "config.json");
  const argumentsFile = join(directory, "args");
  const original = JSON.stringify({ panelUrl: "https://edge.example.com:8443", proxyUrl: "socks5h://user:secret@localhost:1080", token: "keep-token", custom: true });
  try {
    writeFileSync(config, original);
    writeFileSync(join(directory, "agent-proxy.sh"), source("agent-proxy.sh"));
    writeFileSync(join(directory, "install-agent.sh"), `#!/bin/bash\nprintf '%s\\n' "$@" > ${quote(argumentsFile)}\nprintf '%s\\n' "$PANEL_URL" "$FORWARDX_AGENT_PROXY" >> ${quote(argumentsFile)}\n`);
    const manager = source("forwardx-manage.sh").replaceAll("/dev/tty", "/dev/null");
    const setup = `id() { echo 0; }\nexport FORWARDX_MANAGE_DIR=${quote(directory)} FORWARDX_AGENT_CONFIG=${quote(config)}\n`;
    for (const [name, expected] of [["realm", "realm"], ["gost", "gost"], ["runtime", "gost"], ["nft", "nftables"], ["iptables", "iptables"], ["socat", "socat"], ["nginx", "nginx"]]) {
      const result = run(setup + manager, ["-e", "-s", "--", "agent", "tools", "install", name]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(argumentsFile, "utf8"), `install-tool\n${expected}\nhttps://edge.example.com:8443\nsocks5h://user:secret@localhost:1080\n`);
      assert.equal(readFileSync(config, "utf8"), original);
      assert.doesNotMatch(result.stdout + result.stderr, /keep-token|user:secret/);
    }
    rmSync(argumentsFile);
    const bad = run(setup + manager, ["-e", "-s", "--", "agent", "tools", "install", "realm;echo unsafe"]);
    assert.notEqual(bad.status, 0);
    assert.ok(!existsSync(argumentsFile));
    // Mock TTY reads in order: Agent menu -> environment menu -> Realm selection.
    const menu = (choices: number[]) => manager.replace('ROLE="${1:-}";', `choices=(${choices.join(" ")})\nread_index=0\nread() { choice="\${choices[$read_index]}"; read_index=$((read_index + 1)); }\nROLE="\${1:-}";`);
    const interactive = run(setup + menu([9, 1, 1]), ["-e", "-s", "--", "agent"]);
    assert.equal(interactive.status, 0, interactive.stderr);
    assert.match(interactive.stdout, /9\) 转发环境/);
    assert.match(readFileSync(argumentsFile, "utf8"), /^install-tool\nrealm\n/);
    rmSync(argumentsFile);
    const cancelled = run(setup + menu([9, 0]), ["-e", "-s", "--", "agent"]);
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.ok(!existsSync(argumentsFile));
    writeFileSync(join(directory, "panel-kind"), "local\n");
    const panel = run(setup + menu([0]), ["-e", "-s", "--", "panel"]);
    assert.equal(panel.status, 0, panel.stderr);
    assert.match(panel.stdout, /9\) 重置管理员密码/);
    assert.doesNotMatch(panel.stdout, /9\) 转发环境/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("bootstrap forwards install-tool without a Token, preserving panel URL and proxy", () => {
  const bootstrap = source("install-agent.sh");
  const injected = bootstrap.replace('configure_proxy "$@" ||', `
require_root() { :; }
read_existing_config() { EXISTING_PANEL_URL=https://custom.example.com:8443; EXISTING_TOKEN=never-print-token; }
run_panel_installer() { printf 'DISPATCH %s %s %s %s\\n' "$1" "$2" "$PANEL_URL" "$FORWARDX_AGENT_PROXY"; return "\${TEST_FAILURE:-0}"; }
do_install() { echo WRONG_FULL_INSTALL; exit 99; }
do_upgrade() { echo WRONG_UPGRADE; exit 99; }
export FORWARDX_AGENT_PROXY=http://localhost:1080
configure_proxy "$@" ||`);
  const success = run(injected, ["-e", "-s", "--", "install-tool", "realm"]);
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /DISPATCH install-tool realm https:\/\/custom.example.com:8443 http:\/\/localhost:1080/);
  assert.doesNotMatch(success.stdout, /never-print-token|WRONG_/);
  const failed = run(`TEST_FAILURE=1\n${injected}`, ["-e", "-s", "--", "install-tool", "realm"]);
  assert.notEqual(failed.status, 0);
  assert.doesNotMatch(failed.stdout, /WRONG_/);
  const unknown = run(injected, ["-e", "-s", "--", "install-tool", "unknown"]);
  assert.notEqual(unknown.status, 0);
  assert.doesNotMatch(unknown.stdout, /DISPATCH/);
});

test("selective installer dispatches only requested download and never configures/restarts Agent", () => {
  const directory = mkdtempSync(join(tmpdir(), "forwardx-tools-install-"));
  try {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    for (const name of ["realm", "forwardx-runtime", "forwardx-nginx", "socat"]) writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const helpers = selective.replaceAll("/usr/local/bin/realm", `${bin.replace(/\\/g, "/")}/realm`).replaceAll("/usr/bin/socat", `${bin.replace(/\\/g, "/")}/socat`);
    const setup = `${helpers}
id() { echo 0; }
uname() { echo Linux; }
install_realm() { echo ONLY_REALM; }
install_runtime() { echo ONLY_RUNTIME; }
install_nginx_runtime() { echo ONLY_NGINX; }
install_forward_tool_package() { echo ONLY_PACKAGE_"$1"; }
install_deps() { echo WRONG_DEPS; exit 99; }
start_agent_service() { echo WRONG_RESTART; exit 99; }
fwx_agent_proxy_save() { echo WRONG_CONFIG; exit 99; }
RUNTIME_BIN=${quote(join(bin, "forwardx-runtime"))}
NGINX_BIN=${quote(join(bin, "forwardx-nginx"))}
`;
    for (const [tool, marker] of [["realm", "ONLY_REALM"], ["gost", "ONLY_RUNTIME"], ["nginx", "ONLY_NGINX"]]) {
      const result = run(`${setup}\ndo_install_tool ${tool}`);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.split("\n").filter(line => line.startsWith("ONLY_")).join(""), marker);
      assert.doesNotMatch(result.stdout, /WRONG_/);
    }
    const failed = run(`${setup}\ninstall_realm() { return 1; }\ndo_install_tool realm`);
    assert.notEqual(failed.status, 0);
    assert.doesNotMatch(failed.stdout, /\[完成\]/);
    const unknown = run(`${setup}\ndo_install_tool 'realm; echo unsafe'`);
    assert.notEqual(unknown.status, 0);
    assert.doesNotMatch(unknown.stdout, /ONLY_|unsafe/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
  assert.doesNotMatch(selective, /fwx_agent_proxy_save|normalize_upgrade_agent_config|write_agent_service|start_agent_service|register_agent_once|install_go_agent|ensure_source_accounting/);
});

test("system package mapping installs only selected tools, rejects APK SOCKS and preserves errors", () => {
  const packages = selective.slice(0, selective.indexOf("do_install_tool() {"));
  const managers = ["apt-get", "dnf", "yum", "zypper", "apk", "pacman"];
  for (const manager of managers) {
    const setup = `${packages}
command() { if [ "$1" = -v ]; then [ "$2" = ${quote(manager)} ]; else builtin command "$@"; fi; }
${manager}() { printf 'PACKAGE %s\\n' "$*"; return "\${FAIL_PACKAGE:-0}"; }
FORWARDX_AGENT_PROXY=''
`;
    const socat = run(`${setup}\ninstall_forward_tool_package socat`);
    assert.equal(socat.status, 0, socat.stderr);
    assert.match(socat.stdout, /PACKAGE .*socat/);
    assert.doesNotMatch(socat.stdout, /realm|nginx|nftables|iptables/);
    const nginx = run(`${setup}\ninstall_forward_tool_package nginx`);
    assert.equal(nginx.status, 0, nginx.stderr);
    assert.match(nginx.stdout, manager === "pacman" ? /PACKAGE .*nginx/ : /PACKAGE .*nginx.*stream/);
    const failed = run(`${setup}\nFAIL_PACKAGE=1\ninstall_forward_tool_package socat`);
    assert.notEqual(failed.status, 0);
    if (manager === "apk") {
      const socks = run(`${setup}\nFORWARDX_AGENT_PROXY=socks5h://localhost:1080\ninstall_forward_tool_package socat`);
      assert.notEqual(socks.status, 0);
      assert.doesNotMatch(socks.stdout, /PACKAGE /);
    }
  }
});
