import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync, brotliDecompressSync } from "node:zlib";

const directory = new URL("../client/dist/assets/", import.meta.url);
const html = readFileSync(new URL("../client/dist/index.html", import.meta.url), "utf8");
assert.match(html, /rel="modulepreload"[^>]+href="\/assets\/App-[^"]+\.js"/, "App must download eagerly, in parallel with startup");
assert.ok(html.includes("<!--forwardx-locale-->"), "HTML must retain the safe deployment-language injection point");
assert.match(html, /data-forwardx-route-preload/, "Current route must download in parallel without evaluating before locale initialization");
const manifest = JSON.parse(readFileSync(new URL("../client/dist/.vite/manifest.json", import.meta.url), "utf8"));
const shell = new Set();
function visit(key) {
  if (shell.has(key)) return;
  shell.add(key);
  for (const dependency of manifest[key]?.imports || []) visit(dependency);
}
const appKey = Object.keys(manifest).find(key => manifest[key].name === "App");
assert.ok(appKey, "App shell must exist");
visit(appKey);
for (const name of ["Home", "Login", "Rules", "Hosts", "Settings", "Operations"]) {
  const key = Object.keys(manifest).find(key => manifest[key].name === name);
  assert.ok(key, `Missing page chunk: ${name}`);
  assert.ok(!shell.has(key), `${name} must not be part of every page's startup shell`);
}
let checked = 0;
for (const name of readdirSync(directory).filter(name => /\.(js|css)$/.test(name))) {
  const original = readFileSync(new URL(name, directory));
  if (original.length < 1024) continue;
  for (const [extension, decode] of [[".gz", gunzipSync], [".br", brotliDecompressSync]]) {
    assert.ok(original.equals(decode(readFileSync(new URL(name + extension, directory)))), `Compressed bytes differ from final build: ${name}${extension}`);
    checked++;
  }
}
console.log(`Client delivery verified: eager App preload and ${checked} compressed assets match final build.`);
