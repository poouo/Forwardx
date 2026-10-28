import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import test from "node:test";
import { generateInstallScript } from "./agentInstallScripts";
import { FORWARDX_RUNTIME_VERSION, FORWARDX_RUNTIME_SOURCE_COMMIT, FORWARDX_RUNTIME_SOURCE_SHA256 } from "../shared/runtimeBuild";

const script = generateInstallScript("https://panel.example.com");
function section(start: string, end: string) {
  const first = script.indexOf(start), last = script.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first);
  return script.slice(first, last);
}
const bash = ["bash", "C:/Program Files/Git/bin/bash.exe"].find(binary =>
  spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 5000 }).status === 0);

test("runtime builds use pinned source, checksums, transparent identity and the original license", () => {
  assert.match(FORWARDX_RUNTIME_SOURCE_COMMIT, /^[a-f0-9]{40}$/);
  assert.match(FORWARDX_RUNTIME_SOURCE_SHA256, /^[a-f0-9]{64}$/);
  const build = fs.readFileSync("scripts/build-runtime.sh", "utf8");
  const bundle = fs.readFileSync("scripts/build-agent-release.sh", "utf8");
  assert.ok(build.indexOf("sha256sum -c -") < build.indexOf("tar -xzf"));
  assert.match(build, /codeload\.github\.com\/go-gost\/gost\/tar\.gz\/\$SOURCE_COMMIT/);
  assert.match(build, /go build -mod=readonly -trimpath -buildvcs=false/);
  assert.match(build, /-X main\.version=\$RUNTIME_VERSION/);
  assert.match(build, /forwardx-runtime %s/);
  assert.match(build, /648f19f1688c7cd851593d7f9ed6110a/);
  assert.match(build, /72b04e24f8133035d10b651664a055df/);
  assert.match(build, /cp "\$SOURCE_DIR\/LICENSE" "\$OUT_DIR\/RUNTIME_LICENSE\.txt"/);
  assert.match(build, /RUNTIME_BUILD\.txt/);
  assert.doesNotMatch(build + bundle, /gost_\$\{GOST_VERSION\}_linux_|download_gost_runtime|upx -|openssl rand/);
  assert.match(bundle, /bash "\$ROOT_DIR\/scripts\/build-runtime\.sh"/);
  const release = fs.readFileSync(".github/workflows/release-agent.yml", "utf8");
  assert.match(release, /dist\/agent\/RUNTIME_LICENSE\.txt/);
  assert.match(release, /dist\/agent\/RUNTIME_BUILD\.txt/);
});

test("runtime installer rejects upstream and stale builds, atomically installs branded builds and preserves files on failure", t => {
  if (!bash) { t.skip("Bash unavailable"); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-runtime-install-"));
  const shellDir = directory.replace(/\\/g, "/");
  const helpers = section("runtime_self_check() {", "nginx_self_check() {")
    + section("install_runtime_from_panel() {", "install_go_agent() {");
  const original = '#!/bin/sh\ncase "$1" in -V) echo "gost 3.2.6 (upstream)";; -h) echo "-L service -F chain";; esac\n';
  const branded = original.replace("gost 3.2.6", `forwardx-runtime ${FORWARDX_RUNTIME_VERSION}`);
  const existing = path.join(directory, "runtime"), fixture = path.join(directory, "fixture");
  const harness = `
    set -e
    ${helpers}
    detect_arch() { echo amd64; }
    is_enabled_value() { [ "$1" = true ]; }
    download_panel_binary() { return 1; }
    download_github_binary() { printf '%s\\n' "$1" >> "$TEST_DIR/downloads"; cp "$TEST_DIR/fixture" "$2"; chmod +x "$2"; }
    RUNTIME_BIN="$TEST_DIR/runtime"
    RELEASE_VERSION=2.3.292
    if install_runtime; then echo INSTALLED; else echo PRESERVED; fi
  `;
  try {
    for (const [name, source, expected] of [
      ["source build", branded, "INSTALLED"],
      ["upstream fallback", original, "PRESERVED"],
      ["stale branded fallback", branded.replace(FORWARDX_RUNTIME_VERSION, "3.2.6-forwardx.0"), "PRESERVED"],
      ["invalid payload", "not executable content", "PRESERVED"],
    ]) {
      fs.writeFileSync(existing, original, { mode: 0o755 });
      fs.writeFileSync(fixture, source, { mode: 0o755 });
      fs.writeFileSync(path.join(directory, "downloads"), "");
      const result: SpawnSyncReturns<string> = spawnSync(bash, ["-s"], { input: harness, encoding: "utf8", timeout: 10000,
        env: { ...process.env, TEST_DIR: shellDir } });
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(expected), name);
      assert.equal(fs.readFileSync(existing, "utf8"), expected === "INSTALLED" ? branded : original, name);
      const downloads = fs.readFileSync(path.join(directory, "downloads"), "utf8");
      assert.match(downloads, /github\.com\/poouo\/Forwardx\/releases\/download\/v2\.3\.292\/forwardx-runtime-linux-amd64/);
      assert.doesNotMatch(downloads, /go-gost\/gost/);
      assert.equal(fs.readdirSync(directory).filter(name => name.includes("candidate.")).length, 0);
    }
    fs.writeFileSync(existing, branded, { mode: 0o755 });
    fs.writeFileSync(path.join(directory, "downloads"), "");
    const already = spawnSync(bash, ["-s"], { input: harness, encoding: "utf8", timeout: 10000,
      env: { ...process.env, TEST_DIR: shellDir } });
    assert.equal(already.status, 0, already.stderr);
    assert.match(already.stdout, /INSTALLED/);
    assert.equal(fs.readFileSync(path.join(directory, "downloads"), "utf8"), "");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
