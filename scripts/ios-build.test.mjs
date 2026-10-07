import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { iosBuildArguments, readIOSVersion, buildIOSIPA } from "./build-ios-ipa.mjs";

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("icon rendering uses a supported opaque 32-bit CoreGraphics context", () => {
  const script = read("scripts/ios-icon.swift");
  assert.match(script, /CGContext\(/);
  assert.match(script, /bytesPerRow: dimension \* 4/);
  assert.match(script, /CGImageAlphaInfo.noneSkipLast/);
  assert.doesNotMatch(script, /NSBitmapImageRep|NSGraphicsContext|fatalError\(/);
});

test("macOS renders a 1024px opaque RGB PNG and reports bad input without crashing", { skip: process.platform !== "darwin" }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-ios-icon-"));
  try {
    const script = fileURLToPath(new URL("./ios-icon.swift", import.meta.url));
    const source = fileURLToPath(new URL("../client/public/logo-light.png", import.meta.url));
    const output = path.join(directory, "icon.png");
    const result = spawnSync("swift", [script, source, output], { encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr);
    const png = fs.readFileSync(output);
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), 1024);
    assert.equal(png.readUInt32BE(20), 1024);
    assert.equal(png[24], 8, "8 bits per channel");
    assert.equal(png[25], 2, "opaque truecolor, no alpha channel");
    const invalid = spawnSync("swift", [script, path.join(directory, "missing.png"), output], { encoding: "utf8", timeout: 60_000 });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /iOS icon: Cannot decode source logo/);
    assert.doesNotMatch(invalid.stderr, /Fatal error|Stack dump/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("IPA version comes from shared iOS version, never panel/Android", () => {
  assert.equal(readIOSVersion('export const APP_VERSION = "2.3.281"; export const IOS_APP_VERSION = "1.0.2";'), "1.0.2");
  assert.throws(() => readIOSVersion('export const IOS_APP_VERSION = "1.0";'));
  assert.throws(() => readIOSVersion('export const ANDROID_APP_VERSION = "2.3.98";'));
  assert.match(readIOSVersion(), /^\d+\.\d+\.\d+$/);
});

test("build targets a Release arm64 physical device with signing disabled", () => {
  const args = iosBuildArguments("1.0.2", "/tmp/ios-derived");
  for (const expected of ["Release", "iphoneos", "generic/platform=iOS", "ARCHS=arm64", "CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO", "MARKETING_VERSION=1.0.2", "CURRENT_PROJECT_VERSION=1.0.2"]) {
    assert.ok(args.includes(expected), expected);
  }
  assert.ok(!args.includes("-exportArchive"));
  assert.ok(!args.includes("-allowProvisioningUpdates"));
  assert.throws(() => iosBuildArguments("1.0.0; arbitrary command", "/tmp/ios-derived"));
});

test("non-macOS build fails with actionable instructions before writing files", { skip: process.platform === "darwin" }, () => {
  assert.throws(() => buildIOSIPA(), /macOS and Xcode.*GitHub Actions/);
});

test("iOS project permits HTTP WebView and LAN without disabling TLS trust", () => {
  const plist = read("ios/App/App/Info.plist");
  assert.match(plist, /NSAllowsArbitraryLoadsInWebContent<\/key>\s*<true\/>/);
  assert.match(plist, /NSLocalNetworkUsageDescription/);
  assert.doesNotMatch(plist, /<key>NSAllowsArbitraryLoads<\/key>/);
  const privacy = read("ios/App/App/PrivacyInfo.xcprivacy");
  assert.match(privacy, /NSPrivacyAccessedAPICategoryUserDefaults/);
  assert.match(privacy, /CA92.1/);
  assert.match(read("ios/App/App.xcodeproj/project.pbxproj"), /PrivacyInfo.xcprivacy in Resources/);
  assert.match(read("server/index.ts"), /"capacitor:\/\/localhost"/);
});

test("SPM project has all mobile plugins and IPA workflow is independent", () => {
  const spm = read("ios/App/CapApp-SPM/Package.swift");
  for (const name of ["CapacitorApp", "CapacitorBrowser", "CapacitorLocalNotifications", "CapacitorPreferences"]) {
    assert.match(spm, new RegExp(`product\\(name: "${name}"`));
  }
  const workflow = read(".github/workflows/ios-ipa.yml");
  assert.match(workflow, /runs-on: macos-15/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /pnpm mobile:ipa/);
  assert.match(workflow, /gh release upload/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(read(".github/workflows/release-panel.yml"), /needs:.*ios/);
});
