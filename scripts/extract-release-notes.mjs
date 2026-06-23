import fs from "node:fs";

const versionArg = process.argv[2] || "";
const version = versionArg.trim().replace(/^v/i, "");
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Invalid release version: ${versionArg || "<empty>"}`);
  process.exit(1);
}

const changelog = fs.readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const heading = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\][^\\n]*\\n`, "m");
const match = heading.exec(changelog);
if (!match) {
  console.error(`CHANGELOG section for ${version} was not found`);
  process.exit(1);
}

const start = match.index + match[0].length;
const rest = changelog.slice(start);
const next = rest.search(/^## \[/m);
const body = (next >= 0 ? rest.slice(0, next) : rest).trim();
if (!body) {
  console.error(`CHANGELOG section for ${version} is empty`);
  process.exit(1);
}

process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
