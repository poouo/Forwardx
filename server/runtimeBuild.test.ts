import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import test from "node:test";
import { createHash } from "node:crypto";
import { generateInstallScript } from "./agentInstallScripts";
import { FORWARDX_RUNTIME_VERSION, FORWARDX_RUNTIME_SOURCE_COMMIT, FORWARDX_RUNTIME_SOURCE_SHA256, FORWARDX_RUNTIME_RELEASE_TAG } from "../shared/runtimeBuild";

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
  assert.match(bundle, /bash "\$ROOT_DIR\/scripts\/fetch-runtime\.sh"/);
  assert.doesNotMatch(bundle, /bash "\$ROOT_DIR\/scripts\/build-runtime\.sh"/);
  assert.equal(FORWARDX_RUNTIME_RELEASE_TAG, `runtime-v${FORWARDX_RUNTIME_VERSION}`);
  const fetch = fs.readFileSync("scripts/fetch-runtime.sh", "utf8");
  assert.match(fetch, /github\.com\/poouo\/Forwardx\/releases\/download\/\$RELEASE_TAG/);
  assert.match(fetch, /sha256sum -c -/);
  assert.doesNotMatch(fetch, /go build|go-gost\/gost/);
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

test("pinned runtime downloads verify every artifact before replacing files and fail closed", t => {
  if (!bash) { t.skip("Bash unavailable"); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-runtime-fetch-"));
  try {
    for (const child of ["scripts", "shared", "fixtures", "bin", "out"]) fs.mkdirSync(path.join(directory, child));
    fs.copyFileSync("scripts/fetch-runtime.sh", path.join(directory, "scripts/fetch-runtime.sh"));
    const assets = [
      ["AMD64", "forwardx-runtime-linux-amd64"], ["ARM64", "forwardx-runtime-linux-arm64"],
      ["BUILD", "RUNTIME_BUILD.txt"], ["LICENSE", "RUNTIME_LICENSE.txt"],
    ];
    let pins = `export const FORWARDX_RUNTIME_VERSION = "${FORWARDX_RUNTIME_VERSION}";\n`
      + `export const FORWARDX_RUNTIME_RELEASE_TAG = "${FORWARDX_RUNTIME_RELEASE_TAG}";\n`;
    for (const [key, name] of assets) {
      const data = `fixture-${name}\n`;
      fs.writeFileSync(path.join(directory, "fixtures", name), data);
      pins += `export const FORWARDX_RUNTIME_${key}_SHA256 = "${createHash("sha256").update(data).digest("hex")}";\n`;
    }
    fs.writeFileSync(path.join(directory, "shared/runtimeBuild.ts"), pins);
    fs.writeFileSync(path.join(directory, "bin/curl"), `#!/usr/bin/env bash
set -euo pipefail
url=""; dest=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    https://*) url="$1"; shift ;;
    -o) dest="$2"; shift 2 ;;
    --proto|--proto-redir|--retry|--connect-timeout|--max-time|--max-filesize) shift 2 ;;
    *) shift ;;
  esac
done
[[ "$url" == "https://github.com/poouo/Forwardx/releases/download/${FORWARDX_RUNTIME_RELEASE_TAG}/"* ]]
file="$(basename "$url")"
[ "$file" != "$FAIL_DOWNLOAD" ] || exit 22
cp "$TEST_DIR/fixtures/$file" "$dest"
`, { mode: 0o755 });
    const run = (extra: Record<string, string> = {}, arch = "all") => spawnSync(bash, ["-s"], {
      input: 'set -e\nif command -v cygpath >/dev/null 2>&1; then TEST_DIR="$(cygpath -u "$TEST_DIR")"; export TEST_DIR; fi\nexport PATH="$TEST_DIR/bin:$PATH"\nbash "$TEST_DIR/scripts/fetch-runtime.sh" "$TEST_ARCH"\n',
      encoding: "utf8", timeout: 15000, env: { ...process.env, FAIL_DOWNLOAD: "", TEST_DIR: directory.replace(/\\/g, "/"),
        FORWARDX_RUNTIME_OUT_DIR: path.join(directory, "out").replace(/\\/g, "/"), TEST_ARCH: arch, ...extra },
    });
    const good = run();
    assert.equal(good.status, 0, good.stderr);
    for (const [, name] of assets) assert.equal(fs.readFileSync(path.join(directory, "out", name), "utf8"), `fixture-${name}\n`);
    // Keep the whole previous set intact even when only the LAST downloaded file is corrupt.
    for (const [, name] of assets) fs.writeFileSync(path.join(directory, "out", name), "previous");
    fs.appendFileSync(path.join(directory, "fixtures/RUNTIME_LICENSE.txt"), "tampered");
    const corrupt = run();
    assert.notEqual(corrupt.status, 0);
    assert.match(corrupt.stderr, /checksum did NOT match/);
    for (const [, name] of assets) assert.equal(fs.readFileSync(path.join(directory, "out", name), "utf8"), "previous");
    assert.notEqual(run({ FAIL_DOWNLOAD: "forwardx-runtime-linux-arm64" }).status, 0);
    assert.notEqual(run({}, "mips").status, 0);
    assert.deepEqual(fs.readdirSync(path.join(directory, "out")).sort(), assets.map(([, name]) => name).sort(),
      "failed downloads must leave no staging files");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
