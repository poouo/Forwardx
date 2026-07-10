import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import zlib from "zlib";

const root = process.cwd();
const pluginsRoot = path.join(root, "plugins");
const packagesRoot = path.join(pluginsRoot, "packages");
const manifestName = "forwardx-plugin.json";
const allowedExtensions = new Set([
  ".conf",
  ".csv",
  ".css",
  ".dat",
  ".html",
  ".htm",
  ".json",
  ".list",
  ".md",
  ".svg",
  ".sh",
  ".tsv",
  ".txt",
  ".py",
  ".yaml",
  ".yml",
]);

function normalizeEntryPath(value) {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

function isPackableFile(relativePath) {
  const clean = normalizeEntryPath(relativePath);
  if (!clean || clean.includes("..") || clean.startsWith(".")) return false;
  if (clean === manifestName || clean === "README.md") return true;
  return allowedExtensions.has(path.extname(clean).toLowerCase());
}

async function collectFiles(dir, relativeDir = "") {
  const entries = await fs.readdir(path.join(dir, relativeDir), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = normalizeEntryPath(path.posix.join(relativeDir.replace(/\\/g, "/"), entry.name));
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") continue;
      files.push(...await collectFiles(dir, relativePath));
      continue;
    }
    if (!entry.isFile() || !isPackableFile(relativePath)) continue;
    files.push(relativePath);
  }
  return files.sort((a, b) => a.localeCompare(b, "en"));
}

function octal(value, length) {
  const text = Math.floor(value).toString(8);
  return text.padStart(length - 1, "0").slice(-(length - 1)) + "\0";
}

function writeString(buffer, offset, length, value) {
  buffer.write(String(value).slice(0, length), offset, length, "utf8");
}

function tarHeader(name, size, mtime) {
  const header = Buffer.alloc(512, 0);
  let fileName = name;
  let prefix = "";
  if (Buffer.byteLength(fileName) > 100) {
    const slash = fileName.lastIndexOf("/");
    prefix = slash > 0 ? fileName.slice(0, slash) : "";
    fileName = slash > 0 ? fileName.slice(slash + 1) : fileName;
  }
  if (Buffer.byteLength(fileName) > 100 || Buffer.byteLength(prefix) > 155) {
    throw new Error(`Plugin package path is too long: ${name}`);
  }
  writeString(header, 0, 100, fileName);
  writeString(header, 100, 8, octal(0o644, 8));
  writeString(header, 108, 8, octal(0, 8));
  writeString(header, 116, 8, octal(0, 8));
  writeString(header, 124, 12, octal(size, 12));
  writeString(header, 136, 12, octal(mtime, 12));
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, "0");
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  if (prefix) writeString(header, 345, 155, prefix);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeString(header, 148, 8, octal(checksum, 8));
  return header;
}

async function createTarGz(sourceDir, outputFile) {
  const files = await collectFiles(sourceDir);
  if (!files.includes(manifestName)) {
    throw new Error(`Missing ${manifestName}: ${sourceDir}`);
  }
  const chunks = [];
  for (const file of files) {
    const absolutePath = path.join(sourceDir, file);
    const content = await fs.readFile(absolutePath);
    const stat = await fs.stat(absolutePath);
    chunks.push(tarHeader(file, content.byteLength, Math.floor(stat.mtimeMs / 1000)));
    chunks.push(content);
    const padding = (512 - (content.byteLength % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  const archive = Buffer.concat(chunks);
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await fs.writeFile(outputFile, zlib.gzipSync(archive, { level: 9 }));
  const digest = crypto.createHash("sha256").update(await fs.readFile(outputFile)).digest("hex");
  return { files: files.length, bytes: (await fs.stat(outputFile)).size, digest };
}

async function main() {
  await fs.mkdir(packagesRoot, { recursive: true });
  const entries = await fs.readdir(pluginsRoot, { withFileTypes: true });
  const pluginDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name !== "packages")
    .map((entry) => path.join(pluginsRoot, entry.name));
  for (const pluginDir of pluginDirs) {
    const manifestPath = path.join(pluginDir, manifestName);
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      const pluginId = String(manifest.id || path.basename(pluginDir)).trim();
      if (!/^[a-z0-9][a-z0-9._-]{1,127}$/.test(pluginId)) {
        throw new Error(`Invalid plugin id: ${pluginId}`);
      }
      const outputFile = path.join(packagesRoot, `${pluginId}.tar.gz`);
      const result = await createTarGz(pluginDir, outputFile);
      console.log(`${path.relative(root, outputFile)} ${result.bytes} bytes ${result.files} files sha256=${result.digest}`);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
