import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

type Installer = {
  name: "local" | "docker";
  source: string;
  preludeEnd: string;
  directoryEnv: "FORWARDX_PANEL_DIR" | "FORWARDX_DOCKER_DIR";
};

const localSource = fs.readFileSync(path.join(process.cwd(), "scripts/install-panel-local.sh"), "utf8");
const dockerSource = fs.readFileSync(path.join(process.cwd(), "scripts/install-panel-docker.sh"), "utf8");
const installers: Installer[] = [
  {
    name: "local",
    source: localSource,
    preludeEnd: "read_install_port() {",
    directoryEnv: "FORWARDX_PANEL_DIR",
  },
  {
    name: "docker",
    source: dockerSource,
    preludeEnd: "get_compose_host_port() {",
    directoryEnv: "FORWARDX_DOCKER_DIR",
  },
];

function resolveBash() {
  const candidates = process.platform === "win32"
    ? ["bash", "C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"]
    : ["bash"];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (!result.error && result.status === 0) return candidate;
  }
  return "";
}

const bash = resolveBash();

function shellPath(value: string) {
  const normalized = value.replace(/\\/g, "/");
  const windowsDrive = normalized.match(/^([A-Za-z]):(\/.*)$/);
  return windowsDrive ? `/${windowsDrive[1].toLowerCase()}${windowsDrive[2]}` : normalized;
}

function sourceBefore(source: string, marker: string) {
  const index = source.indexOf(marker);
  assert.notEqual(index, -1, `missing shell marker: ${marker}`);
  return source.slice(0, index).replace(/\r\n/g, "\n");
}

function section(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing section: ${start}`);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

function runHarness(options: {
  installer: Installer;
  endMarker?: string;
  body: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  prepare?: (directory: string) => void;
}) {
  assert.ok(bash, "bash is required for panel installer regression tests");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `forwardx-${options.installer.name}-installer-`));
  const harness = path.join(directory, "harness.sh");
  const callLog = path.join(directory, "calls.log");
  const outputFile = path.join(directory, "download.out");
  options.prepare?.(directory);
  fs.writeFileSync(
    harness,
    `${sourceBefore(options.installer.source, options.endMarker || options.installer.preludeEnd)}\n${options.body}\n`,
  );
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    [options.installer.directoryEnv]: shellPath(directory),
    CALL_LOG: shellPath(callLog),
    OUTPUT_FILE: shellPath(outputFile),
  };
  delete childEnv.FORWARDX_GITHUB_ACCELERATOR_URL;
  Object.assign(childEnv, options.env || {});
  const result = spawnSync(bash, [harness, ...(options.args || [])], {
    encoding: "utf8",
    env: childEnv,
  });
  const calls = fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8").trim().split(/\r?\n/) : [];
  const output = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : "";
  fs.rmSync(directory, { recursive: true, force: true });
  return { ...result, calls, output };
}

test("local and Docker installers parse both GitHub accelerator argument forms", { skip: !bash }, () => {
  for (const installer of installers) {
    for (const args of [
      ["upgrade", "--github-accelerator", "https://mirror.example.com///"],
      ["upgrade", "--github-accelerator=https://mirror.example.com///"],
    ]) {
      const result = runHarness({
        installer,
        args,
        body: `
resolve_github_accelerator
printf 'ACTION=%s\\nURL=%s\\nEXPLICIT=%s\\n' "$ACTION" "$GITHUB_ACCELERATOR_URL" "$GITHUB_ACCELERATOR_EXPLICIT"
`,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /ACTION=upgrade/);
      assert.match(result.stdout, /URL=https:\/\/mirror\.example\.com/);
      assert.match(result.stdout, /EXPLICIT=true/);
    }
  }
});

test("local and Docker installers accept the accelerator environment variable and reject invalid protocols", { skip: !bash }, () => {
  for (const installer of installers) {
    const fromEnvironment = runHarness({
      installer,
      args: ["upgrade"],
      env: { FORWARDX_GITHUB_ACCELERATOR_URL: " https://env-mirror.example.com/// " },
      body: `
resolve_github_accelerator
printf '%s\\n' "$GITHUB_ACCELERATOR_URL"
`,
    });
    assert.equal(fromEnvironment.status, 0, fromEnvironment.stderr);
    assert.equal(fromEnvironment.stdout.trim(), "https://env-mirror.example.com");

    const invalid = runHarness({
      installer,
      args: ["upgrade", "--github-accelerator=ftp://mirror.example.com"],
      body: "resolve_github_accelerator",
    });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Invalid GitHub accelerator URL/);

    const unsupportedSuffix = runHarness({
      installer,
      args: ["upgrade", "--github-accelerator=https://mirror.example.com/prefix?token=1"],
      body: "resolve_github_accelerator",
    });
    assert.notEqual(unsupportedSuffix.status, 0);
    assert.match(unsupportedSuffix.stderr, /Invalid GitHub accelerator URL/);
  }
});

test("upgrades inherit the persisted GitHub accelerator when no explicit option is provided", { skip: !bash }, () => {
  for (const installer of installers) {
    const result = runHarness({
      installer,
      args: ["upgrade"],
      prepare: (directory) => {
        fs.writeFileSync(path.join(directory, ".env"), 'FORWARDX_GITHUB_ACCELERATOR_URL="https://saved-mirror.example.com///"\n');
      },
      body: `
resolve_github_accelerator
printf '%s\\n' "$GITHUB_ACCELERATOR_URL"
`,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "https://saved-mirror.example.com");
  }
});

test("an explicitly empty accelerator environment disables a persisted installer value", { skip: !bash }, () => {
  for (const installer of installers) {
    const result = runHarness({
      installer,
      args: ["upgrade"],
      env: { FORWARDX_GITHUB_ACCELERATOR_URL: "" },
      prepare: (directory) => {
        fs.writeFileSync(path.join(directory, ".env"), 'FORWARDX_GITHUB_ACCELERATOR_URL="https://saved-mirror.example.com"\n');
      },
      body: `
resolve_github_accelerator
printf 'URL=%s\\nEXPLICIT=%s\\n' "$GITHUB_ACCELERATOR_URL" "$GITHUB_ACCELERATOR_EXPLICIT"
`,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "URL=\nEXPLICIT=true\n");
  }
});

test("local and Docker version checks fall back from the accelerator to GitHub", { skip: !bash }, () => {
  for (const installer of installers) {
    const result = runHarness({
      installer,
      endMarker: "resolve_release_version() {",
      args: ["upgrade", "--github-accelerator=https://mirror.example.com"],
      body: `
resolve_github_accelerator
curl() {
  local url="\${!#}"
  printf '%s\\n' "$url" >> "$CALL_LOG"
  case "$url" in
    "$GITHUB_ACCELERATOR_URL"/*) return 22 ;;
    https://api.github.com/*) printf '%s\\n' '{"tag_name":"v9.8.7"}'; return 0 ;;
    *) return 22 ;;
  esac
}
latest_release_version
`,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "9.8.7");
    assert.deepEqual(result.calls, [
      "https://mirror.example.com/https://api.github.com/repos/poouo/Forwardx/releases/latest",
      "https://api.github.com/repos/poouo/Forwardx/releases/latest",
    ]);
    assert.match(result.stderr, /falling back to GitHub/);
  }
});

test("local release downloads reject an accelerator HTTP 200 error page and fall back to GitHub", { skip: !bash }, () => {
  const installer = installers[0];
  const result = runHarness({
    installer,
    args: ["upgrade", "--github-accelerator=https://mirror.example.com"],
    body: `
resolve_github_accelerator
curl() {
  local output=""
  local url=""
  local expect_output="false"
  local arg=""
  for arg in "$@"; do
    if [ "$expect_output" = "true" ]; then
      output="$arg"
      expect_output="false"
      continue
    fi
    case "$arg" in
      --output|-o) expect_output="true" ;;
      http://*|https://*) url="$arg" ;;
    esac
  done
  printf '%s\\n' "$url" >> "$CALL_LOG"
  case "$url" in
    "$GITHUB_ACCELERATOR_URL"/*) printf '<html>mirror error</html>' > "$output"; printf '200'; return 0 ;;
    https://github.com/*) tar -czf "$output" --files-from /dev/null; printf '200'; return 0 ;;
    *) printf '000'; return 22 ;;
  esac
}
code="$(download_github_archive 'https://github.com/poouo/Forwardx/releases/download/v9.8.7/forwardx-panel-v9.8.7.tar.gz' "$OUTPUT_FILE")"
printf 'CODE=%s\\n' "$code"
`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "CODE=200");
  assert.notEqual(result.output, "<html>mirror error</html>");
  assert.deepEqual(result.calls, [
    "https://mirror.example.com/https://github.com/poouo/Forwardx/releases/download/v9.8.7/forwardx-panel-v9.8.7.tar.gz",
    "https://github.com/poouo/Forwardx/releases/download/v9.8.7/forwardx-panel-v9.8.7.tar.gz",
  ]);
  assert.match(result.stderr, /invalid-archive/);
});

test("both installers persist the accelerator and Docker keeps GHCR image pulls unchanged", () => {
  for (const installer of installers) {
    assert.match(installer.source, /FORWARDX_GITHUB_ACCELERATOR_URL="\$GITHUB_ACCELERATOR_URL"/);
  }

  const imageResolver = section(dockerSource, "resolve_image_selection() {", "install_base_deps() {");
  const panelStarter = section(dockerSource, "start_panel() {", "install_panel() {");
  assert.match(imageResolver, /RESOLVED_IMAGE="\$\{IMAGE_REPO\}:v\$\{version\}"/);
  assert.match(panelStarter, /docker pull "\$image"/);
  assert.doesNotMatch(imageResolver, /accelerated_github_url/);
  assert.doesNotMatch(panelStarter, /GITHUB_ACCELERATOR_URL/);
});

test("the local upgrade command delegates to the installer script", { skip: !bash }, () => {
  const result = runHarness({
    installer: installers[0],
    endMarker: "install_panel() {",
    args: ["upgrade"],
    body: `
JWT_SECRET=test-secret
write_env
set -a
. "$APP_DIR/.env"
set +a
printf 'UPGRADE=%s\\n' "$FORWARDX_UPGRADE_COMMAND"
`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /UPGRADE=\/bin\/bash .*scripts\/install-panel-local\.sh upgrade/);
  assert.doesNotMatch(result.stdout, /SCRIPT|DIRECT_URL|mktemp/);
});

test("the local installer validates the complete archive before removing the current panel", () => {
  const downloader = section(localSource, "download_github_archive() {", "read_install_port() {");
  const installBundle = section(localSource, "download_panel_bundle() {", "install_runtime_dependencies() {");
  assert.match(downloader, /tar -tzf "\$output"/);
  assert.match(downloader, /invalid-archive/);
  const validation = installBundle.indexOf('download_github_archive "$url" "$archive"');
  const removal = installBundle.indexOf('rm -rf "$APP_DIR/dist"');
  assert.notEqual(validation, -1);
  assert.notEqual(removal, -1);
  assert.ok(validation < removal);
});

test("both installers expose a password reset action without accepting password arguments", () => {
  for (const installer of installers) {
    assert.match(installer.source, /reset-admin\|reset-password\)/);
    assert.match(installer.source, /dist\/reset-admin-password\.js/);
    assert.match(installer.source, /--enable-account/);
    assert.doesNotMatch(installer.source, /--password/);
  }
  assert.match(dockerSource, /Password reset CLI is missing from the running container/);
  assert.match(dockerSource, /docker exec -it "\$CONTAINER_NAME" node dist\/reset-admin-password\.js/);
  assert.match(localSource, /Password reset CLI is missing from \$APP_DIR/);
});

test("local password reset lets the CLI load dotenv without sourcing executable .env content", () => {
  const reset = section(localSource, "reset_admin_password() {", "case \"$ACTION\" in");
  const nonSystemdServices = section(localSource, "write_openrc_service() {", "write_service() {");

  // reset-admin runs the Node CLI from APP_DIR, where dotenv/config reads .env.
  // Sourcing the whole file here evaluates FORWARDX_UPGRADE_COMMAND and its
  // literal $SCRIPT under set -u, aborting before the password reset starts.
  assert.match(reset, /cd "\$APP_DIR" \\|\\| exit 1/);
  assert.doesNotMatch(reset, /(^|\n)\s*\.\s+"\$APP_DIR\/\.env"/);
  assert.doesNotMatch(reset, /set -a[\s\S]*\.\s+"\$APP_DIR\/\.env"/);
  assert.match(reset, /dist\/reset-admin-password\.js/);
  assert.match(reset, /DOTENV_CONFIG_PATH="\$APP_DIR\/\.env"/);
  assert.match(reset, /DOTENV_CONFIG_OVERRIDE=true/);
  assert.doesNotMatch(nonSystemdServices, /\.\s+\"\$APP_DIR\/\.env\"/);
  assert.match(nonSystemdServices, /DOTENV_CONFIG_PATH=\\"\$APP_DIR\/\.env\\"/g);
  assert.equal(nonSystemdServices.match(/DOTENV_CONFIG_OVERRIDE=true/g)?.length, 2);
});
