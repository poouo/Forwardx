import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { spawnSync } from "node:child_process";

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("Android asset merger excludes HTTP-precompressed assets before .gz name collisions", () => {
  const gradle = read("android/app/build.gradle");
  const patterns = gradle.match(/ignoreAssetsPattern\s*=\s*'([^']+)'/)?.[1].split(":");
  assert.ok(patterns);
  assert.ok(patterns.includes("*.gz"));
  assert.ok(patterns.includes("*.br"));
  // Keep the original web files and the pre-existing Android ignore defaults.
  for (const required of ["!.svn", "!.git", ".*", "!*~"]) assert.ok(patterns.includes(required));
  for (const forbidden of ["*.js", "*.css", "*.html", "assets", "public", "*"]) {
    assert.ok(!patterns.includes(forbidden));
  }
  // Server-side delivery must retain compression, rather than removing it globally.
  const delivery = read("scripts/client-delivery-plugin.ts");
  assert.match(delivery, /fileName: `\$\{item.fileName\}\.gz`/);
  assert.match(delivery, /fileName: `\$\{item.fileName\}\.br`/);
});

test("APK workflow checks its final contents and supports opt-in repair without moving release tags", () => {
  const workflow = read(".github/workflows/android-apk.yml");
  assert.match(workflow, /publish_release:\s*\n\s*description:[^\n]+\n\s*required: false\s*\n\s*type: boolean\s*\n\s*default: false/);
  assert.match(workflow, /MANUAL_PUBLISH_RELEASE:.*inputs.publish_release/);
  assert.match(workflow, /pnpm test:android/);
  const verify = workflow.indexOf("- name: Verify APK web assets");
  assert.ok(verify > workflow.indexOf("- name: Build debug APK"));
  assert.ok(verify < workflow.indexOf("- name: Upload APK artifact"));
  assert.match(workflow, /unzip -Z1/);
  assert.match(workflow, /APK must not include HTTP-precompressed web assets/);
  assert.match(workflow, /grep -qx 'assets\/public\/index.html'/);
  assert.doesNotMatch(workflow, /git (?:push|tag).*--force/);
});

test("repair publishes only release builds to the current panel release", t => {
  const workflow = read(".github/workflows/android-apk.yml");
  const resolve = workflow.slice(workflow.indexOf('          if [[ "$GITHUB_REF"'), workflow.indexOf("      - name: Install dependencies"));
  // Run the actual workflow branch logic, excluding version parsing and the output file.
  const commands = resolve.split("\n").filter(line => !line.includes('>> "$GITHUB_OUTPUT"')).join("\n");
  for (const example of [
    { event: "workflow_dispatch", ref: "refs/heads/main", publish: "false", type: "release", expected: "v2.4.4|false|release" },
    { event: "workflow_dispatch", ref: "refs/heads/main", publish: "true", type: "release", expected: "v2.3.286|true|release" },
    { event: "workflow_dispatch", ref: "refs/heads/main", publish: "true", type: "debug", expected: null },
    { event: "push", ref: "refs/tags/v2.3.286", publish: "false", type: "release", expected: "v2.3.286|true|release" },
  ]) {
    const gitBash = "C:/Program Files/Git/bin/bash.exe";
    const bash = process.platform === "win32" && fs.existsSync(gitBash) ? gitBash : "bash";
    const result = spawnSync(bash, ["-c", commands + '\nprintf "%s|%s|%s" "$VERSION" "$PUBLISH_RELEASE" "$BUILD_TYPE"'], {
      encoding: "utf8",
      env: { ...process.env, EVENT_NAME: example.event, GITHUB_REF: example.ref, GITHUB_REF_NAME: "v2.3.286", PANEL_VERSION: "v2.3.286", ANDROID_VERSION: "v2.4.4", MANUAL_PUBLISH_RELEASE: example.publish, MANUAL_BUILD_TYPE: example.type },
    });
    // Windows development machines may not have bash; Linux Actions always does.
    if (result.error?.code === "ENOENT") { t.skip("bash is unavailable on this development machine"); return; }
    if (example.expected === null) assert.notEqual(result.status, 0);
    else { assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), example.expected); }
  }
});
