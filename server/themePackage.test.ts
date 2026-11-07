import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import tar from "tar-stream";
import { parseThemePackage, readThemeArchive } from "./themePackage";
import { THEME_LIMITS, themeTemplateFiles } from "../shared/themes";

const files = () => themeTemplateFiles();
const zip = (values: Record<string, string | Uint8Array>) => Buffer.from(zipSync(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, typeof value === "string" ? strToU8(value) : value]))));
async function tarball(values: Record<string, string>, symlink = false) {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const finished = new Promise<Buffer>((resolve, reject) => { pack.on("data", chunk => chunks.push(Buffer.from(chunk as Uint8Array))); pack.on("end", () => resolve(Buffer.concat(chunks))); pack.on("error", reject); });
  for (const [name, text] of Object.entries(values)) {
    if (symlink) pack.entry({ name, type: "symlink", linkname: "../outside" });
    else pack.entry({ name }, text);
  }
  pack.finalize();
  return finished;
}

// A small stored RAR4 encoder for test fixtures; no system RAR utility is needed.
function rar(values: Record<string, string>) {
  const crc = (bytes: Buffer) => {
    let value = 0xffffffff;
    for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); }
    return (value ^ 0xffffffff) >>> 0;
  };
  const header = (type: number, length: number, flags = 0) => {
    const bytes = Buffer.alloc(length); bytes[2] = type; bytes.writeUInt16LE(flags, 3); bytes.writeUInt16LE(length, 5); return bytes;
  };
  const finish = (bytes: Buffer) => { bytes.writeUInt16LE(crc(bytes.subarray(2)) & 0xffff, 0); return bytes; };
  const chunks = [Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]), finish(header(0x73, 13))];
  for (const [name, text] of Object.entries(values)) {
    const content = Buffer.from(text), filename = Buffer.from(name), bytes = header(0x74, 32 + filename.length, 0x8000);
    bytes.writeUInt32LE(content.length, 7); bytes.writeUInt32LE(content.length, 11); bytes[15] = 2;
    bytes.writeUInt32LE(crc(content), 16); bytes[24] = 20; bytes[25] = 0x30; bytes.writeUInt16LE(filename.length, 26); bytes.writeUInt32LE(0x20, 28); filename.copy(bytes, 32);
    chunks.push(finish(bytes), content);
  }
  chunks.push(finish(header(0x7b, 7)));
  return Buffer.concat(chunks);
}

test("RAR themes extract in memory and obey the same manifest and path rules", async () => {
  const result = await parseThemePackage(rar(files()));
  assert.equal(result.manifest.id, "my-teal-theme");
  assert.equal(result.revision, (await parseThemePackage(zip(files()))).revision);
  await assert.rejects(parseThemePackage(rar({ ...files(), "../bad.txt": "x" })), /不安全/);
  await assert.rejects(parseThemePackage(rar({ ...files(), "bad.js": "x" })), /不支持/);
  await assert.rejects(parseThemePackage(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])));
});

test("the downloadable starter works in ZIP, TAR and GZIP TAR, identified by content", async () => {
  const source = files();
  const tar = await tarball(source);
  const results = await Promise.all([zip(source), tar, gzipSync(tar)].map(parseThemePackage));
  for (const result of results) {
    assert.equal(result.manifest.id, "my-teal-theme");
    assert.equal(result.manifest.apiVersion, 1);
    assert.match(result.css, /data-theme-part/);
    assert.equal(result.revision, results[0].revision);
  }
});

test("rejects traversal, case collisions, executable files, symlinks and unsupported formats", async () => {
  for (const extras of [{ "../bad.txt": "x" }, { "A.txt": "a", "a.txt": "b" }, { "script.js": "alert(1)" }] as Record<string, string>[]) {
    await assert.rejects(parseThemePackage(zip({ ...files(), ...extras })), /不安全|duplicate|invalid|不支持/i);
  }
  await assert.rejects(readThemeArchive(await tarball({ "asset.txt": "" }, true)), /不安全/);
  await assert.rejects(async () => parseThemePackage(Buffer.from("not an archive")), /不支持/);
  await assert.rejects(parseThemePackage(zip({ "README.md": "missing manifest" })), /根目录/);
});

test("bounds archive, entry, entry count and decompressed TAR bytes", async () => {
  await assert.rejects(async () => readThemeArchive(Buffer.alloc(THEME_LIMITS.archiveBytes + 1)), /30MB/);
  await assert.rejects(parseThemePackage(zip({ ...files(), "big.txt": new Uint8Array(THEME_LIMITS.fileBytes + 1) })), /单文件/);
  await assert.rejects(readThemeArchive(zip(Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`${index}.txt`, ""])) )), /过多文件/);
  await assert.rejects(readThemeArchive(gzipSync(Buffer.alloc(THEME_LIMITS.expandedBytes + 100_000))), /超过限制|Unexpected end/i);
  await assert.rejects(readThemeArchive(await tarball({ "../bad.txt": "x" })), /不安全/);
});

test("manifest version, reserved IDs, variables and CSS imports cannot bypass validation", async () => {
  const original = files();
  for (const patch of [{ apiVersion: 2 }, { id: "ink" }, { stylesheet: "../theme.css" }, { variables: { light: { "--primary": "red; color: blue" } } }]) {
    const manifest = { ...JSON.parse(original["theme.json"]), ...patch };
    await assert.rejects(parseThemePackage(zip({ ...original, "theme.json": JSON.stringify(manifest) })));
  }
  for (const css of [
    '@import "https://example.com/a.css";', 'body { background: url(https://example.com/a.png) }',
    'body { background: URL("//localhost/a.png") }', 'body { background: image-set("https://example.com/a.png" 1x) }',
    String.raw`body { background: u\72l(https://example.com/x) }`, 'body { background: url(data:image/svg+xml;base64,PHN2Zz4=) }',
    'body { behavior: url(x.htc) }', 'body { background: url(assets/missing.png) }',
  ]) await assert.rejects(parseThemePackage(zip({ ...original, "theme.css": css })), css);
});

test("local asset URLs are embedded and normal child selectors/media ranges work", async () => {
  const result = await parseThemePackage(zip({ ...files(), "assets/a.png": "image bytes", "theme.css": '@media (width > 800px) { [data-theme-part="card"] > h2 { background: url("assets/a.png"); } }' }));
  assert.match(result.css, /data:image\/png;base64,/);
  assert.match(result.css, /width > 800px/);
  assert.doesNotMatch(result.css, /url\("assets/);
  const hugeReference = 'body { background: ' + Array.from({ length: 32 }, () => 'url("assets/a.png")').join(",") + '}';
  await assert.rejects(parseThemePackage(zip({ ...files(), "assets/a.png": new Uint8Array(1024 * 1024), "theme.css": hugeReference })), /展开后/);
});

test("image-heavy themes above the old archive, single-file and compiled limits can be imported", async () => {
  const image = randomBytes(8 * 1024 * 1024);
  const archive = zip({ ...files(), "assets/background.webp": image, "theme.css": 'body { background-image: url("assets/background.webp"); }' });
  assert.ok(archive.length > 3 * 1024 * 1024);
  const theme = await parseThemePackage(archive);
  const embedded = theme.css.split("base64,")[1].split('"')[0];
  assert.deepEqual(Buffer.from(embedded, "base64"), image);
  assert.ok(Buffer.byteLength(theme.css) > 10 * 1024 * 1024);
  assert.ok(Buffer.byteLength(theme.css) <= THEME_LIMITS.compiledCssBytes);
});
