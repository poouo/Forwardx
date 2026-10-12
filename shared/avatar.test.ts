import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import {
  BUILTIN_AVATARS, builtinAvatarForSeed, builtinAvatarPath, builtinAvatarValue,
  isBuiltinAvatarValue, isValidAvatarValue, migrateLegacyAvatarValue,
  normalizeAvatarValue, randomBuiltinAvatarValue,
} from "./avatar";

test("twenty unique presets have small, local WebP assets", () => {
  assert.equal(BUILTIN_AVATARS.length, 20);
  assert.equal(new Set(BUILTIN_AVATARS.map((avatar) => avatar.id)).size, 20);
  assert.equal(readdirSync("client/public/avatars").filter((file) => file.endsWith(".webp")).length, 20);
  for (const avatar of BUILTIN_AVATARS) {
    const value = builtinAvatarValue(avatar.id);
    assert.equal(isBuiltinAvatarValue(value), true);
    assert.equal(normalizeAvatarValue(value), value);
    assert.match(avatar.name, /\p{Script=Han}/u);
    assert.doesNotMatch(avatar.nameEn, /\p{Script=Han}/u);
    const path = builtinAvatarPath(value);
    assert.equal(path, `/avatars/${avatar.id}.webp`);
    const image = readFileSync(`client/public${path}`);
    assert.equal(image.subarray(8, 12).toString(), "WEBP");
    assert.ok(image.length < 50 * 1024);
  }
});

test("preset validation rejects arbitrary paths and unsafe image sources", () => {
  for (const value of ["builtin:unknown", "builtin:../panda", "builtin:panda.webp", "/avatars/panda.webp", "https://example.com/a.png", "data:image/svg+xml;base64,PHN2Zz4=", "builtin:PANDA"]) {
    assert.equal(isValidAvatarValue(value), false, value);
    assert.equal(normalizeAvatarValue(value), null);
    assert.match(builtinAvatarPath(value, 1), /^\/avatars\/[a-z-]+\.webp$/);
  }
});

test("old generated avatars map stably, without losing uploaded avatars", () => {
  for (const old of ["avataaars:old-user", "multiavatar:old-user", "preset:old-user"]) {
    assert.equal(isBuiltinAvatarValue(migrateLegacyAvatarValue(old)), true);
    assert.equal(builtinAvatarPath(old), builtinAvatarPath(migrateLegacyAvatarValue(old)));
    assert.equal(migrateLegacyAvatarValue(old), builtinAvatarForSeed("old-user"));
  }
  assert.equal(migrateLegacyAvatarValue(null, "user-10"), builtinAvatarForSeed("user-10"));
  for (const type of ["png", "jpeg", "webp", "gif"]) {
    const uploaded = `data:image/${type};base64,YQ==`;
    assert.equal(migrateLegacyAvatarValue(uploaded, 10), uploaded);
    assert.equal(normalizeAvatarValue(uploaded), uploaded);
  }
  assert.equal(isValidAvatarValue(`data:image/png;base64,${"YQ==".repeat(20_000)}`), false);
});

test("random selection only uses the twenty presets and excludes current selection", () => {
  for (const preset of BUILTIN_AVATARS) {
    const current = builtinAvatarValue(preset.id);
    for (let i = 0; i < 50; i++) {
      const next = randomBuiltinAvatarValue(current);
      assert.equal(isBuiltinAvatarValue(next), true);
      assert.notEqual(next, current);
    }
  }
});
