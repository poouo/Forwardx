import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { iosBuildArguments, readIOSVersion, buildIOSIPA } from "./build-ios-ipa.mjs";

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

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
