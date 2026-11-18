import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const bash = ["bash", "C:/Program Files/Git/bin/bash.exe"].find(command =>
  spawnSync(command, ["--version"], { encoding: "utf8", timeout: 5000 }).status === 0);
const jqDirectory = process.env.FORWARDX_TEST_JQ_DIR || (process.platform === "win32" ? path.join(os.tmpdir(), "forwardx-proxy-tests") : "");
const env = { ...process.env, MSYS_NO_PATHCONV: "1", PATH: jqDirectory ? `${jqDirectory}${path.delimiter}${process.env.PATH || ""}` : process.env.PATH };
const hasJq = !!bash && spawnSync(bash, ["-c", "command -v jq"], { env, timeout: 5000 }).status === 0;
const script = fs.readFileSync(new URL("../scripts/agent-proxy.sh", import.meta.url), "utf8").replace(/\r\n/g, "\n")
  + "\n" + fs.readFileSync(new URL("../scripts/agent-discovery.sh", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("discovery bootstrap is valid Bash", { skip: !bash }, () => {
  const result = spawnSync(bash!, ["-n"], { input: script, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});

// Only curl and root detection are stubbed. All state serialization, jq,
// credential selection, shell execution and retry behavior run unchanged.
const harness = `
id() { printf '0\\n'; }
curl() {
  local url='' output='' payload='' auth=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -o) output="$2"; shift 2 ;;
      --data-binary) payload="\${2#@}"; shift 2 ;;
      --config) auth="$2"; shift 2 ;;
      --connect-timeout|--max-time|-H) shift 2 ;;
      http://*|https://*) url="$1"; shift ;;
      *) shift ;;
    esac
  done
  case "$url" in
    */install.sh)
      [ "\${TEST_MODE:-}" != download-failure ] || return 22
      if [ "\${TEST_MODE:-}" = invalid-installer ]; then printf 'if broken syntax' > "$output"; return 0; fi
      printf '%s\\n' '#!/bin/bash' 'printf "%s|%s|%s|%s\\n" "$1" "$2" "$FORWARDX_AGENT_PROXY" "$FORWARDX_INSTALL_MIMIC" >> "$TEST_DIR/installed"' '[ "\${TEST_MODE:-}" != install-failure ]' > "$output"
      ;;
    */discover)
      [ -n "$auth" ] && [ -f "$auth" ] || return 90
      grep -q "Authorization: Bearer $TEST_KEY" "$auth" || return 91
      jq -c . "$payload" >> "$TEST_DIR/requests"
      if [ "\${TEST_MODE:-}" = response-failure ]; then return 52; fi
      if [ "\${TEST_MODE:-}" = invalid-response ]; then printf '{"token":"bad"}' > "$output"; return 0; fi
      printf '{"token":"%s"}' "$TEST_TOKEN" > "$output"
      ;;
    *) return 92 ;;
  esac
}
${script}
`;

test("bootstrap retries preserve identity, cache independent credentials and reuse legacy recovery tokens", { skip: !hasJq }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-discovery-shell-"));
  const config = path.join(directory, "config");
  const shellPath = (value: string) => value.replace(/\\/g, "/");
  const key = "a".repeat(64), token = "b".repeat(64);
  const stateFile = path.join(config, "discovery.json");
  const run = (mode = "", args: string[] = []) => spawnSync(bash!, ["-s", "--", key, ...args], {
    input: harness, encoding: "utf8", timeout: 15000,
    env: { ...env, PANEL_URL: "https://panel.example.test", TEST_DIR: shellPath(directory),
      TEST_MODE: mode, TEST_KEY: key, TEST_TOKEN: token, FORWARDX_AGENT_PROXY: "", FORWARDX_INSTALL_MIMIC: "ask",
      FORWARDX_DISCOVERY_CONFIG_DIR: shellPath(config), FORWARDX_DISCOVERY_LEGACY_CONFIG_DIR: shellPath(path.join(directory, "legacy")) },
  });
  try {
    for (const mode of ["download-failure", "invalid-installer"]) {
      assert.notEqual(run(mode).status, 0);
      assert.equal(fs.existsSync(stateFile), false, "failed downloads must not reserve an identity");
    }
    assert.notEqual(run("response-failure").status, 0);
    const initial = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.match(initial.registrationId, /^[a-f0-9]{64}$/);
    assert.equal(initial.token, undefined);
    assert.notEqual(run("invalid-response").status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")), initial);
    assert.notEqual(run("install-failure").status, 0);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).token, token, "installer failures retain the reserved credential");
    const retry = run();
    assert.equal(retry.status, 0, retry.stderr);
    const requests = fs.readFileSync(path.join(directory, "requests"), "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(requests.length, 3, "cached token retry must not enroll again");
    assert.ok(requests.every(request => request.registrationId === initial.registrationId));
    assert.equal(fs.readFileSync(path.join(directory, "installed"), "utf8").trim().split(/\r?\n/).length, 2);
    for (const [choice, normalized] of [["y", "yes"], ["n", "no"]]) {
      const selected = run("", ["--mimic", choice]);
      assert.equal(selected.status, 0, selected.stderr);
      assert.equal(fs.readFileSync(path.join(directory, "installed"), "utf8").trim().split(/\r?\n/).at(-1), `install|${token}||${normalized}`);
    }
    // The persistent flock inode must remain: unlinking it would let another
    // installer lock a new inode while the original installation is running.
    assert.equal(fs.readdirSync(config).filter(name => name.startsWith(".discovery.") && name !== ".discovery.lock").length, 0, "temporary credentials must be cleaned up");
    // A manually installed pre-discovery Agent takes precedence over state.
    fs.writeFileSync(path.join(config, "config.json"), JSON.stringify({ panelUrl: "https://panel.example.test", token: "original-legacy-token" }));
    const recovered = run();
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(fs.readFileSync(path.join(directory, "installed"), "utf8"), /install\|original-legacy-token\|/);
    assert.equal(fs.readFileSync(path.join(directory, "requests"), "utf8").trim().split(/\r?\n/).length, 3);
    if (process.platform !== "win32") assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
