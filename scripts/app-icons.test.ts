import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { APP_ICON_VARIANTS, DEFAULT_APP_ICON } from "../shared/appIcons";
import { FORWARDX_LOGO } from "../client/src/lib/brandLogo";
import { nativeColors, nativeIconSvg, opaquePng } from "./generate-app-icons";

const read = (file: string) => fs.readFileSync(new URL(`../${file}`, import.meta.url));
const source = (file: string) => read(file).toString("utf8");

test("native SVG uses shared logo geometry and resolved, renderer-safe palette", () => {
  assert.deepEqual(nativeColors("oklch(1 0 0)"), { primary: "#ffffff", secondary: "#b6dfdb" });
  assert.equal(nativeColors("oklch(0 0 0)").primary, "#000000");
  assert.throws(() => nativeColors("invalid"));
  for (const variant of APP_ICON_VARIANTS) {
    const svg = nativeIconSvg(variant.primary);
    assert.ok(svg.includes(FORWARDX_LOGO.body));
    assert.ok(svg.includes(FORWARDX_LOGO.chevron));
    assert.match(svg, /rx="0"/);
    assert.doesNotMatch(svg, /oklch|color-mix|var\(/);
  }
});

test("opaque PNG encoder removes alpha without changing RGB pixels", () => {
  const png = opaquePng(Uint8Array.from([10, 20, 30, 255, 50, 60, 70, 255]), 1, 2);
  assert.equal(png[25], 2);
  const size = png.readUInt32BE(33);
  assert.equal(png.subarray(37, 41).toString(), "IDAT");
  assert.deepEqual([...inflateSync(png.subarray(41, 41 + size))], [0, 10, 20, 30, 0, 50, 60, 70]);
  assert.throws(() => opaquePng(Uint8Array.from([0, 0, 0, 0]), 1, 1), /opaque/);
  assert.throws(() => opaquePng(new Uint8Array(0), 1, 1), /dimensions/);
});

test("every shipped iOS alternate is a distinct opaque 1024px icon included in Debug and Release", () => {
  const project = source("ios/App/App.xcodeproj/project.pbxproj");
  const settings = [...project.matchAll(/ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES = "([^"]+)"/g)].map(match => match[1].split(" "));
  const expected = APP_ICON_VARIANTS.filter(v => v.key !== DEFAULT_APP_ICON).map(v => v.name);
  assert.deepEqual(settings, [expected, expected]);
  const hashes = new Set<string>();
  for (const variant of APP_ICON_VARIANTS) {
    const name = variant.key === DEFAULT_APP_ICON ? "AppIcon" : variant.name;
    const base = `ios/App/App/Assets.xcassets/${name}.appiconset/`;
    const metadata = JSON.parse(source(base + "Contents.json"));
    const png = read(base + metadata.images[0].filename);
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), 1024);
    assert.equal(png.readUInt32BE(20), 1024);
    assert.equal(png[25], 2, `${name} must have no alpha channel`);
    hashes.add(createHash("sha256").update(png).digest("hex"));
  }
  assert.equal(hashes.size, APP_ICON_VARIANTS.length);
  assert.match(source("ios/App/App/Base.lproj/Main.storyboard"), /customClass="ForwardXBridgeViewController" customModule="App"/);
  assert.match(source("ios/App/App/AppDelegate.swift"), /registerPluginInstance\(ForwardXAppIconPlugin\(\)\)/);
  assert.match(source("ios/App/App/AppDelegate.swift"), /applicationState == \.active/);
  assert.doesNotMatch(source("scripts/build-ios-ipa.mjs"), /logo-light.png/);
});

test("Android aliases preserve a stable activity, exactly one default and all icon resources", () => {
  const manifest = source("android/app/src/main/AndroidManifest.xml");
  const aliases = [...manifest.matchAll(/<activity-alias\b[^>]+>[\s\S]*?<\/activity-alias>/g)].map(match => match[0]);
  assert.equal(aliases.length, APP_ICON_VARIANTS.length);
  assert.equal(aliases.filter(alias => alias.includes('android:enabled="true"')).length, 1);
  const activity = manifest.match(/<activity\b[\s\S]*?<\/activity>/)?.[0];
  assert.ok(activity);
  assert.doesNotMatch(activity, /category.LAUNCHER|android:enabled="false"/);
  for (const variant of APP_ICON_VARIANTS) {
    const alias = aliases.find(alias => alias.includes(`.${variant.launcher}"`));
    assert.ok(alias, variant.key);
    assert.match(alias, /android:targetActivity=".MainActivity"/);
    const resource = variant.key === DEFAULT_APP_ICON ? "ic_launcher" : `ic_launcher_${variant.key.replace(/-/g, "_")}`;
    assert.ok(alias.includes(`@mipmap/${resource}"`));
    for (const version of [26, 33]) {
      const adaptive = source(`android/app/src/main/res/mipmap-anydpi-v${version}/${resource}.xml`);
      assert.ok(adaptive.includes(`@drawable/${resource}_theme_background`));
      if (version === 33) assert.match(adaptive, /<monochrome/);
    }
    for (const [density, size] of [["mdpi", 48], ["hdpi", 72], ["xhdpi", 96], ["xxhdpi", 144], ["xxxhdpi", 192]] as const) {
      const png = read(`android/app/src/main/res/mipmap-${density}/${resource}.png`);
      assert.equal(png.readUInt32BE(16), size);
      assert.equal(png.readUInt32BE(20), size);
    }
  }
  const plugin = source("android/app/src/main/java/com/forwardx/app/AppIconPlugin.java");
  assert.match(plugin, /DONT_KILL_APP/);
  assert.match(plugin, /setComponentEnabledSettings\(changes\)/);
  for (const theme of new Set(APP_ICON_VARIANTS.map(v => v.theme))) assert.ok(plugin.includes(`"${theme}"`));
  assert.match(source("android/app/src/main/java/com/forwardx/app/MainActivity.java"), /registerPlugin\(AppIconPlugin.class\)/);
});
