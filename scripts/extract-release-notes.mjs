import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function normalizeReleaseVersion(value) {
  const version = String(value || "").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("Invalid release version: " + (value || "<empty>"));
  }
  return version;
}

export function extractReleaseSection(changelog, versionArg, fileName = "CHANGELOG.md") {
  const version = normalizeReleaseVersion(versionArg);
  const heading = new RegExp("^## \\[" + version.replace(/\./g, "\\.") + "\\][^\\n]*\\n", "m");
  const match = heading.exec(changelog);
  if (!match) throw new Error(fileName + " section for " + version + " was not found");
  const rest = changelog.slice(match.index + match[0].length);
  const next = rest.search(/^## \[/m);
  const body = (next >= 0 ? rest.slice(0, next) : rest).trim();
  if (!body) throw new Error(fileName + " section for " + version + " is empty");
  return body;
}

export function bilingualReleaseNotes(version, chinese, english) {
  const zh = extractReleaseSection(chinese, version, "CHANGELOG.md");
  const en = extractReleaseSection(english, version, "CHANGELOG.en.md");
  return "## 简体中文\n\n" + zh + "\n\n---\n\n## English\n\n" + en + "\n";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const version = normalizeReleaseVersion(process.argv[2]);
    const read = (file) => fs.readFileSync(new URL("../" + file, import.meta.url), "utf8");
    process.stdout.write(bilingualReleaseNotes(version, read("CHANGELOG.md"), read("CHANGELOG.en.md")));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Failed to prepare bilingual release notes");
    process.exitCode = 1;
  }
}
