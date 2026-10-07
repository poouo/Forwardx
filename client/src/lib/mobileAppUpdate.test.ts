import assert from "node:assert/strict";
import test from "node:test";
import { compareMobileVersions, extractMobilePackageVersion, latestMobilePackage } from "./mobileAppUpdate";

test("mobile updates only match the current platform's release package", () => {
  assert.equal(extractMobilePackageVersion("forwardx-ios-v1.0.0-unsigned.ipa", "ios"), "1.0.0");
  assert.equal(extractMobilePackageVersion("forwardx-ios-v1.0.0-unsigned.ipa.sha256", "ios"), null);
  assert.equal(extractMobilePackageVersion("forwardx-android-v2.3.98.apk", "android"), "2.3.98");
  assert.equal(extractMobilePackageVersion("forwardx-android-v9.0.0-debug.apk", "android"), null);
  assert.equal(extractMobilePackageVersion("forwardx-ios-v1.0.0-unsigned.ipa", "android"), null);
  assert.equal(extractMobilePackageVersion("forwardx-android-v9.0.0.apk", "ios"), null);
});

test("a new Android package on the same panel release is detected as an update", () => {
  const latest = latestMobilePackage([
    { html_url: "https://github.com/poouo/Forwardx/releases/tag/v2.3.282", assets: [
      { name: "forwardx-android-v2.3.99.apk" },
      { name: "forwardx-android-v2.4.0.apk" },
    ] },
  ], "android");
  assert.equal(latest?.version, "2.4.0");
  assert.ok(compareMobileVersions(latest!.version, "2.3.99") > 0);
});

test("IPA update version is independent of panel/APK versions and excludes prereleases", () => {
  const releases = [
    { html_url: "https://github.com/poouo/Forwardx/releases/tag/v2.3.283", assets: [{ name: "forwardx-ios-v1.0.2-unsigned.ipa" }] },
    { html_url: "https://github.com/poouo/Forwardx/releases/tag/v2.3.282", assets: [{ name: "forwardx-android-v2.3.99.apk" }, { name: "forwardx-ios-v1.0.10-unsigned.ipa" }] },
    { prerelease: true, assets: [{ name: "forwardx-ios-v9.0.0-unsigned.ipa" }] },
    { draft: true, assets: [{ name: "forwardx-ios-v10.0.0-unsigned.ipa" }] },
    null,
  ];
  assert.equal(latestMobilePackage(releases, "ios")?.version, "1.0.10");
  assert.equal(latestMobilePackage(releases, "android")?.version, "2.3.99");
  assert.equal(latestMobilePackage([], "ios"), undefined);
  assert.equal(latestMobilePackage(null, "ios"), undefined);
  assert.ok(compareMobileVersions("1.0.10", "1.0.2") > 0);
  assert.equal(compareMobileVersions("v1.0.0", "1.0.0"), 0);
});
