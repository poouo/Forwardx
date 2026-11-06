import { createRequire as createRarRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { THEME_LIMITS } from "../shared/themes";

const rarRequire = createRarRequire(import.meta.url);
let activeRarReaders = 0;

// Run WASM off the request thread. Terminating the worker also releases the
// extractor's native objects if validation interrupts a lazy archive iterator.
const reader = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  const { createExtractorFromData } = require(workerData.modulePath);
  const limits = workerData.limits;
  const extractor = await createExtractorFromData({ data: workerData.archive });
  const list = extractor.getFileList();
  if (list.arcHeader.flags.volume || list.arcHeader.flags.headerEncrypted) throw new Error("不支持加密或分卷 RAR 主题");
  const names = new Set();
  let count = 0, declared = 0;
  for (const entry of list.fileHeaders) {
    const normalized = entry.name.replace(/\\/g, "/");
    const name = entry.flags.directory ? normalized.replace(/\/$/, "") : normalized;
    if (++count > limits.files || name.length > 200 || !/^[a-zA-Z0-9_./-]+$/.test(name)
      || name.startsWith("/") || name.split("/").some(p => !p || p === "." || p === "..") || names.has(name.toLowerCase())) throw new Error("RAR 主题含不安全、重复路径或过多文件");
    names.add(name.toLowerCase());
    if (entry.flags.encrypted) throw new Error("不支持加密 RAR 主题");
    if (entry.flags.directory) continue;
    if (name !== "theme.json" && !/\.(css|md|txt|png|jpe?g|webp|gif|woff2?)$/i.test(name)) throw new Error("RAR 主题包含不支持的文件：" + name);
    declared += entry.unpSize;
    if (!Number.isSafeInteger(entry.unpSize) || entry.unpSize < 0 || entry.unpSize > limits.fileBytes || declared > limits.expandedBytes) throw new Error("RAR 主题解压数据超过限制");
  }
  // The in-memory writer is bounded as well as the declared header sizes.
  const write = extractor.write.bind(extractor);
  const sizes = new Map();
  let total = 0;
  extractor.write = function(fd, pointer, size) {
    const current = (sizes.get(fd) || 0) + size;
    total += size;
    if (current > limits.fileBytes || total > limits.expandedBytes) throw new Error("RAR 主题解压数据超过限制");
    sizes.set(fd, current);
    return write(fd, pointer, size);
  };
  const result = [];
  for (const file of extractor.extract().files) {
    if (file.fileHeader.flags.directory) continue;
    if (!file.extraction || file.extraction.length > limits.fileBytes) throw new Error("RAR 主题文件解压失败");
    result.push([file.fileHeader.name.replace(/\\/g, "/"), file.extraction]);
  }
  parentPort.postMessage({ files: result });
})().catch(error => parentPort.postMessage({ error: "RAR 主题解压失败：" + error.message }));
`;

export async function readRarThemeArchive(buffer: Buffer): Promise<Map<string, Buffer>> {
  if (activeRarReaders >= 2) throw new Error("RAR 主题解压繁忙，请稍后重试");
  const archive = Uint8Array.from(buffer).buffer;
  const worker = new Worker(reader, {
    eval: true, execArgv: [], workerData: { archive, limits: THEME_LIMITS, modulePath: rarRequire.resolve("node-unrar-js") },
    transferList: [archive], resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
  });
  activeRarReaders++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Map<string, Buffer>>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("RAR 主题解压超时")), 10_000);
      worker.once("error", reject);
      worker.once("exit", code => reject(new Error(`RAR 主题解压进程退出（${code}）`)));
      worker.once("message", (message: { error?: string; files: Array<[string, Uint8Array]> }) => {
        if (message.error) reject(new Error(message.error));
        else resolve(new Map(message.files.map(([name, bytes]) => [name, Buffer.from(bytes)])));
      });
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
    activeRarReaders--;
  }
}
