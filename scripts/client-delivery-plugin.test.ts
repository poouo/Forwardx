import assert from "node:assert/strict";
import test from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { runInNewContext } from "node:vm";
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

test("HTML preloads only the current page and its static closure, without evaluating route code", () => {
  const chunk = (fileName: string, page?: string, imports: string[] = [], dynamicImports: string[] = []) => ({
    type: "chunk", fileName, facadeModuleId: page ? `/project/client/src/${page}.tsx` : null,
    modules: {}, imports, dynamicImports, code: "export default null;",
    viteMetadata: { importedCss: new Set(page === "pages/Rules" ? ["assets/rules.css"] : []) },
  });
  const bundle: Record<string, any> = {
    "index.html": { type: "asset", source: "<head></head>" },
    "assets/App.js": chunk("assets/App.js", "App", ["assets/shared.js"], ["assets/Rules.js", "assets/Hosts.js"]),
    "assets/shared.js": chunk("assets/shared.js"),
    "assets/Rules.js": chunk("assets/Rules.js", "pages/Rules", ["assets/rule-dep.js"]),
    "assets/rule-dep.js": chunk("assets/rule-dep.js", undefined, ["assets/Rules.js"]),
    "assets/Hosts.js": chunk("assets/Hosts.js", "pages/Hosts"),
    "assets/Home.js": chunk("assets/Home.js", "pages/Home"),
    "assets/Plugins.js": chunk("assets/Plugins.js", "pages/Plugins"),
    "assets/Custom.js": chunk("assets/Custom.js", "pages/CustomSidebarPage"),
    "assets/Monitor.js": chunk("assets/Monitor.js", "pages/HostMonitor"),
  };
  const hook = clientDeliveryPlugin().generateBundle as { handler: Function };
  hook.handler.call({ emitFile() {} }, {}, bundle);
  const html: string = bundle["index.html"].source;
  assert.doesNotMatch(html, /<link[^>]+Rules.js/);
  assert.doesNotMatch(html, /import\(/);
  const script = html.match(/<script data-forwardx-route-preload>([\s\S]*?)<\/script>/)![1];
  const forPath = (pathname: string) => {
    const links: any[] = [];
    runInNewContext(script, {
      location: { pathname },
      document: { querySelector: () => null, createElement: () => ({}), head: { appendChild: (link: any) => links.push(link) } },
    });
    return links;
  };
  const rules = forPath("/rules");
  assert.deepEqual(rules.map(link => link.href).sort(), ["/assets/Rules.js", "/assets/rule-dep.js", "/assets/rules.css"].sort());
  assert.equal(rules.find(link => link.href.endsWith(".css")).as, "style");
  assert.deepEqual(forPath("/hosts").map(link => link.href), ["/assets/Hosts.js"]);
  assert.deepEqual(forPath("/plugins/sidebar/123").map(link => link.href), ["/assets/Plugins.js"]);
  assert.deepEqual(forPath("/custom-pages/example").map(link => link.href), ["/assets/Custom.js"]);
  assert.deepEqual(forPath("/monitor").map(link => link.href), ["/assets/Monitor.js"]);
  assert.deepEqual(forPath("/404"), []);
  assert.deepEqual(forPath("/invalid/nested"), []);
});
