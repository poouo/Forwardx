import assert from "node:assert/strict";
import test from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { clientDeliveryPlugin } from "./client-delivery-plugin";

test("build eagerly preloads App and shared dependencies without executing App before locale initialization", () => {
  const code = "export const sample = 1;".repeat(100);
  const bundle: Record<string, any> = {
    "index.html": { type: "asset", source: '<head><link rel="modulepreload" crossorigin href="/assets/shared-123.js"></head>' },
    "assets/App-123.js": { type: "chunk", fileName: "assets/App-123.js", facadeModuleId: null, modules: { "D:\\project\\client\\src\\App.tsx": {} }, imports: ["assets/shared-123.js"], code },
    "assets/shared-123.js": { type: "chunk", fileName: "assets/shared-123.js", modules: {}, imports: ["assets/runtime-123.js"], code },
    "assets/runtime-123.js": { type: "chunk", fileName: "assets/runtime-123.js", modules: {}, imports: ["assets/shared-123.js"], code },
    "assets/main-123.css": { type: "asset", fileName: "assets/main-123.css", source: ":root{color:black}".repeat(100) },
  };
  const emitted: { fileName: string; source: Buffer }[] = [];
  const pluginHook = clientDeliveryPlugin().generateBundle as { order: string; handler: Function };
  assert.equal(pluginHook.order, "post", "compressed bytes must follow Vite's import rewriting");
  const hook = pluginHook.handler;
  hook.call({ emitFile: (file: any) => emitted.push(file) }, {}, bundle);
  const html = bundle["index.html"].source;
  assert.match(html, /rel="modulepreload" crossorigin href="\/assets\/App-123.js"/);
  assert.match(html, /href="\/assets\/runtime-123.js"/);
  assert.equal(html.split('href="/assets/shared-123.js"').length, 2, "shared preload is not duplicated");
  assert.doesNotMatch(html, /<script[^>]+App-/);
  for (const item of Object.values(bundle).filter(item => /\.(js|css)$/.test(item.fileName))) {
    const br = emitted.find(file => file.fileName === item.fileName + ".br")!;
    const gzip = emitted.find(file => file.fileName === item.fileName + ".gz")!;
    assert.ok(br); assert.ok(gzip);
    assert.equal(brotliDecompressSync(br.source).toString(), item.code ?? item.source);
    assert.equal(gunzipSync(gzip.source).toString(), item.code ?? item.source);
  }
});
