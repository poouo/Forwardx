import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync, brotliDecompressSync } from "node:zlib";

const directory = new URL("../client/dist/assets/", import.meta.url);
const html = readFileSync(new URL("../client/dist/index.html", import.meta.url), "utf8");
assert.match(html, /rel="modulepreload"[^>]+href="\/assets\/App-[^"]+\.js"/, "App must download eagerly, in parallel with startup");
assert.ok(html.includes("<!--forwardx-locale-->"), "HTML must retain the safe deployment-language injection point");
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
