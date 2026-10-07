import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bilingualReleaseNotes, extractReleaseSection, normalizeReleaseVersion } from "./extract-release-notes.mjs";

const read = (file) => fs.readFileSync(new URL("../" + file, import.meta.url), "utf8");

test("release version accepts a tag or version and rejects malformed values", () => {
  assert.equal(normalizeReleaseVersion(" v2.3.282 "), "2.3.282");
  for (const value of ["", "2.3", "2.3.282-beta", "../CHANGELOG.md", "2.3.282\nextra"]) {
    assert.throws(() => normalizeReleaseVersion(value), /Invalid release version/);
  }
});

test("extract only the exact release, supporting CRLF and excluding adjacent sections", () => {
  const source = "## [Unreleased]\r\n\r\n- future\r\n\r\n## [2.3.282] - date\r\n\r\n### Fixed\r\n\r\n- target\r\n\r\n## [2.3.281] - date\r\n\r\n- older\r\n";
  assert.equal(extractReleaseSection(source, "v2.3.282"), "### Fixed\r\n\r\n- target");
  assert.throws(() => extractReleaseSection(source, "2.3.28"), /was not found/);
  assert.throws(() => extractReleaseSection("## [2.3.282]\n\n## [2.3.281]\n- old", "2.3.282"), /is empty/);
});

test("bilingual releases fail closed when either translation is missing or empty", () => {
  const zh = "## [2.3.282]\n\n- 中文\n";
  const en = "## [2.3.282]\n\n- English\n";
  assert.equal(bilingualReleaseNotes("2.3.282", zh, en), "## 简体中文\n\n- 中文\n\n---\n\n## English\n\n- English\n");
  assert.throws(() => bilingualReleaseNotes("2.3.282", zh, "## [2.3.281]\n- old"), /CHANGELOG.en.md.*not found/);
  assert.throws(() => bilingualReleaseNotes("2.3.282", zh, "## [2.3.282]\n\n"), /CHANGELOG.en.md.*empty/);
  assert.throws(() => bilingualReleaseNotes("2.3.282", "", en), /CHANGELOG.md.*not found/);
});

test("Chinese and English release histories have matching versions and dates", () => {
  const headings = (source) => [...source.matchAll(/^## \[(\d+\.\d+\.\d+)\] - ([\d-]+)$/gm)].map(m => [m[1], m[2]]);
  const chinese = read("CHANGELOG.md").replace(/\r\n/g, "\n");
  const english = read("CHANGELOG.en.md").replace(/\r\n/g, "\n");
  assert.deepEqual(headings(english), headings(chinese));
  for (const [version] of headings(chinese)) {
    assert.ok(extractReleaseSection(chinese, version));
    assert.ok(extractReleaseSection(english, version));
  }
});

test("CLI emits both languages for the current release and rejects unknown versions", () => {
  const version = JSON.parse(read("package.json")).version;
  const script = fileURLToPath(new URL("./extract-release-notes.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "v" + version], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^## 简体中文\n/);
  assert.match(result.stdout, /\n## English\n/);
  assert.ok(!result.stdout.includes("## [Unreleased]"));
  const invalid = spawnSync(process.execPath, [script, "99.99.99"], { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /was not found/);
  assert.equal(invalid.stdout, "");
});
