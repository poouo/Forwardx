import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { generateInstallScript } from "./agentInstallScripts";
import { managementAsset } from "./managementAssets";

const bash = process.platform === "win32"
  ? ["C:/Program Files/Git/bin/bash.exe", "C:/Program Files/Git/usr/bin/bash.exe"].find(existsSync)
  : "bash";
const source = (name: string) => readFileSync(`scripts/${name}`, "utf8").replace(/\r\n/g, "\n");
const jqDirectory = process.env.FORWARDX_TEST_JQ_DIR || (process.platform === "win32" ? join(tmpdir(), "forwardx-proxy-tests") : "");
const harnessEnv = { ...process.env, MSYS_NO_PATHCONV: "1", PATH: jqDirectory ? `${jqDirectory}${delimiter}${process.env.PATH || ""}` : process.env.PATH };
function run(input: string, args = ["-s"]) {
  assert.ok(bash, "Bash required for installer regression tests");
  return spawnSync(bash, args, { input, encoding: "utf8", timeout: 15000, env: harnessEnv });
}
const hasJq = !!bash && run("command -v jq >/dev/null").status === 0;
const quote = (value: string) => `'${value.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;

test("all management scripts and the self-contained installer have valid Bash syntax", () => {
  for (const name of ["agent-proxy.sh", "install-agent.sh", "forwardx-manage.sh", "install-management.sh", "install-panel-local.sh", "install-panel-docker.sh"]) {
    const result = run(source(name), ["-n"]);
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
  const result = run(generateInstallScript("https://panel.example.com"), ["-n"]);
  assert.equal(result.status, 0, result.stderr);
});

test("proxy normalization, explicit direct and offline operations", () => {
  const result = run(`${managementAsset("agent-proxy.sh")}
set -eu
[ "$(fwx_proxy_normalize socks5://user:pass@localhost:1080)" = socks5h://user:pass@localhost:1080 ]
for bad in socks4://host:1 socks5://host:0 socks5://host:65536 http://host http://host:80/path; do
  if fwx_proxy_normalize "$bad" >/dev/null 2>&1; then exit 10; fi
done
export HTTP_PROXY=http://inherited:8080 NO_PROXY='*'
fwx_proxy_environment ''
[ -z "$HTTP_PROXY" ] && [ -z "$ALL_PROXY" ] && [ -z "$NO_PROXY" ]
CONFIG_DIR=/not-existing-forwardx-test LEGACY_CONFIG_DIR=/not-existing-forwardx-test
fwx_agent_proxy_args install token --proxy socks5://localhost:1080
[ "$ACTION" = install ] && [ "$TOKEN" = token ] && [ "$https_proxy" = socks5h://localhost:1080 ]
fwx_agent_proxy_args upgrade --no-proxy
[ -z "$FORWARDX_AGENT_PROXY" ] && [ -z "$https_proxy" ]
unset CONFIG_DIR LEGACY_CONFIG_DIR
fwx_agent_proxy_args uninstall
fwx_agent_proxy_args --help
`);
  assert.equal(result.status, 0, result.stderr);
});

test("bootstrap proxy reaches child without appearing in curl argv; help needs no config", () => {
  const script = source("install-agent.sh");
  const setup = script.slice(0, script.indexOf("show_help() {"));
  const result = run(`${setup}
set -eu
configure_proxy install token --proxy socks5://localhost:1080
[ "$FORWARDX_AGENT_PROXY" = socks5h://localhost:1080 ] && [ "$HTTPS_PROXY" = "$FORWARDX_AGENT_PROXY" ]
configure_proxy upgrade --no-proxy
[ -z "$FORWARDX_AGENT_PROXY" ]
configure_proxy --help
`);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(script, /curl[^\n]*--proxy/);
});

test("generated installer persists proxy before starting and bundles offline management", () => {
  const script = generateInstallScript("https://panel.example.com");
  assert.match(script, /proxyUrl:\$proxy/);
  const upgrade = script.slice(script.indexOf("do_upgrade() {"), script.indexOf("# ============ 入口"));
  assert.ok(upgrade.indexOf("fwx_agent_proxy_save") < upgrade.indexOf("start_agent_service"));
  assert.match(script, /install -m 755 .*\/usr\/local\/bin\/fwxm/);
  assert.doesNotMatch(script, /rm -rf [^\n]*\/etc\/forwardx /);
  assert.match(source("install-panel-docker.sh"), /docker cp "\$CONTAINER_NAME:\/app\/dist\/management\/\."/);
  assert.match(source("forwardx-manage.sh"), /reset-admin/);
  assert.match(source("forwardx-manage.sh"), /\$PANEL_DIR\/data\/panel.log/);
  assert.match(source("install-management.sh"), /chmod 700 "\$dir"/);
});

test("bare fwxm opens the appropriate interactive menu for Agent, panel and co-located roles", () => {
  const directory = mkdtempSync(join(tmpdir(), "forwardx-manager-menu-"));
  const config = join(directory, "config.json");
  const terminal = join(directory, "terminal");
  try {
    writeFileSync(join(directory, "agent-proxy.sh"), managementAsset("agent-proxy.sh"));
    writeFileSync(config, "{}");
    writeFileSync(terminal, "0\n");
    // Use a mock SSH terminal: show the prompts without touching a real TTY.
    const script = source("forwardx-manage.sh")
      .replace(/> \/dev\/tty/g, "> /dev/null")
      .replace(/< \/dev\/tty/g, `< ${quote(terminal)}`);
    const setup = `id() { echo 0; }\nexport FORWARDX_MANAGE_DIR=${quote(directory)} FORWARDX_AGENT_CONFIG=${quote(config)}\n`;
    const agent = run(setup + script);
    assert.equal(agent.status, 0, agent.stderr);
    assert.match(agent.stdout, /ForwardX agent 管理/);
    assert.doesNotMatch(agent.stdout, /9\) 重置管理员密码/);
    rmSync(config);
    writeFileSync(join(directory, "panel-kind"), "docker\n");
    const panel = run(setup + script);
    assert.equal(panel.status, 0, panel.stderr);
    assert.match(panel.stdout, /ForwardX panel 管理/);
    assert.match(panel.stdout, /9\) 重置管理员密码/);
    writeFileSync(config, "{}");
    // The first menu selects Agent; use status/info-free exit on the next read.
    const coLocatedScript = script.replace("ROLE=\"${1:-}\";", `read() { menu_reads=$((menu_reads + 1)); if [ "$menu_reads" = 1 ]; then choice=1; else choice=0; fi; }\nmenu_reads=0\nROLE="\${1:-}";`);
    const both = run(setup + coLocatedScript);
    assert.equal(both.status, 0, both.stderr);
    assert.match(both.stdout, /ForwardX agent 管理/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("real jq config persistence preserves registration and rejects invalid proxy types", { skip: !hasJq }, () => {
  const directory = mkdtempSync(join(tmpdir(), "forwardx-proxy-config-"));
  const config = join(directory, "config.json");
  const original = { panelUrl: "https://panel.example.com", token: "preserved-token", interval: 30, panelMigrationId: "keep", custom: { nested: true }, proxyUrl: "socks5://user:secret@localhost:1080" };
  try {
    writeFileSync(config, JSON.stringify(original));
    const result = run(`${managementAsset("agent-proxy.sh")}
set -eu
unset FORWARDX_AGENT_PROXY
CONFIG_DIR=${quote(directory)} LEGACY_CONFIG_DIR=/no-such-forwardx-test
fwx_agent_proxy_args upgrade
[ "$FORWARDX_AGENT_PROXY" = socks5h://user:secret@localhost:1080 ]
fwx_agent_proxy_args upgrade --no-proxy
fwx_agent_proxy_save
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { ...original, proxyUrl: "" });
    for (const value of [false, 12, {}, []]) {
      writeFileSync(config, JSON.stringify({ ...original, proxyUrl: value }));
      const rejected = run(`${managementAsset("agent-proxy.sh")}
unset FORWARDX_AGENT_PROXY
CONFIG_DIR=${quote(directory)} LEGACY_CONFIG_DIR=/no-such-forwardx-test
fwx_agent_proxy_args upgrade
`);
      assert.notEqual(rejected.status, 0);
      assert.doesNotMatch(rejected.stderr, /preserved-token|secret/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("interactive status and restart target the selected Agent, local panel or Docker panel", () => {
  const directory = mkdtempSync(join(tmpdir(), "forwardx-manager-actions-"));
  const config = join(directory, "config.json");
  const terminal = join(directory, "terminal");
  try {
    writeFileSync(join(directory, "agent-proxy.sh"), managementAsset("agent-proxy.sh"));
    writeFileSync(config, "{}");
    writeFileSync(join(directory, "panel-service"), "custom-panel-service\n");
    writeFileSync(join(directory, "panel-container"), "custom-panel-container\n");
    const script = source("forwardx-manage.sh")
      .replace(/> \/dev\/tty/g, "> /dev/null")
      .replace(/< \/dev\/tty/g, `< ${quote(terminal)}`);
    const setup = `id() { echo 0; }
systemctl() { printf 'SERVICE %s\\n' "$*"; }
rc-service() { printf 'SERVICE %s\\n' "$*"; }
docker() { printf 'DOCKER %s\\n' "$*"; }
export FORWARDX_MANAGE_DIR=${quote(directory)} FORWARDX_AGENT_CONFIG=${quote(config)}
`;
    for (const kind of ["agent", "local", "docker"]) {
      writeFileSync(join(directory, "panel-kind"), `${kind === "agent" ? "local" : kind}\n`);
      for (const [choice, action] of [["2", "status"], ["4", "restart"]]) {
        writeFileSync(terminal, `${choice}\n`);
        const result = run(setup + script, ["-s", "--", kind === "agent" ? "agent" : "panel"]);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /2\) 运行状态/);
        assert.match(result.stdout, /4\) 重启面板或 Agent/);
        if (kind === "docker") {
          assert.match(result.stdout, new RegExp(`DOCKER ${action === "status" ? "inspect" : "restart"} .*custom-panel-container`));
        } else {
          assert.match(result.stdout, /SERVICE/);
          assert.match(result.stdout, new RegExp(kind === "agent" ? "forwardx-agent" : "custom-panel-service"));
          assert.match(result.stdout, new RegExp(action));
        }
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("fwxm saves Agent proxy, redacts credentials and routes Docker commands by metadata", { skip: !hasJq }, () => {
  const directory = mkdtempSync(join(tmpdir(), "forwardx-manager-"));
  const config = join(directory, "config.json");
  try {
    writeFileSync(join(directory, "agent-proxy.sh"), managementAsset("agent-proxy.sh"));
    writeFileSync(config, JSON.stringify({ token: "never-display-token", panelUrl: "https://panel.example.com", custom: true }));
    const setup = `id() { echo 0; }
rc-service() { printf 'SERVICE %s %s\\n' "$1" "$2"; }
systemctl() { printf 'SERVICE %s %s\\n' "$1" "$2"; }
docker() { printf 'DOCKER %s\\n' "$*"; }
export FORWARDX_MANAGE_DIR=${quote(directory)} FORWARDX_AGENT_CONFIG=${quote(config)}
`;
    const saved = run(setup + source("forwardx-manage.sh"), ["-s", "--", "agent", "proxy", "set", "socks5://user:secret@localhost:1080"]);
    assert.equal(saved.status, 0, saved.stderr);
    const stored = JSON.parse(readFileSync(config, "utf8"));
    assert.equal(stored.proxyUrl, "socks5h://user:secret@localhost:1080");
    assert.equal(stored.token, "never-display-token");
    assert.equal(stored.custom, true);
    const shown = run(setup + source("forwardx-manage.sh"), ["-s", "--", "agent", "proxy", "show"]);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /socks5h:\/\/\*\*\*@localhost:1080/);
    assert.doesNotMatch(saved.stdout + shown.stdout, /user:secret|never-display-token/);
    writeFileSync(join(directory, "panel-kind"), "docker\n");
    writeFileSync(join(directory, "panel-container"), "custom-panel-container\n");
    const docker = run(setup + source("forwardx-manage.sh"), ["-s", "--", "panel", "restart"]);
    assert.equal(docker.status, 0, docker.stderr);
    assert.match(docker.stdout, /DOCKER restart custom-panel-container/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
