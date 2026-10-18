import type { Plugin } from "vite";
import { brotliCompressSync, gzipSync, constants } from "node:zlib";

/** Eager network preload, not route/component lazy loading. Locale is still
 * resolved before App evaluation to preserve module-level translated labels. */
export function clientDeliveryPlugin(): Plugin {
  return {
    name: "forwardx-client-delivery",
    apply: "build",
    enforce: "post",
    // Vite finalizes import-preload code in its normal generateBundle hooks.
    // Compress only the final bytes, never the intermediate __VITE_PRELOAD__ code.
    generateBundle: { order: "post", handler(_options, bundle) {
      const app = Object.values(bundle).find(item => item.type === "chunk" &&
        [item.facadeModuleId, ...Object.keys(item.modules)].some(id => id?.replace(/\\/g, "/").endsWith("/client/src/App.tsx")));
      const html = bundle["index.html"];
      if (app?.type === "chunk" && html?.type === "asset") {
        const files = new Set<string>();
        const visit = (name: string) => {
          if (files.has(name)) return;
          files.add(name);
          const chunk = bundle[name];
          if (chunk?.type === "chunk") chunk.imports.forEach(visit);
        };
        visit(app.fileName);
        const source = String(html.source);
        const links = [...files].filter(name => !source.includes(`href="/${name}"`) && !source.includes(`src="/${name}"`))
          .map(name => `<link rel="modulepreload" crossorigin href="/${name}">`).join("\n    ");
        html.source = source.replace("</head>", `${links}\n  </head>`);
      }
      for (const item of Object.values(bundle)) {
        if (!/\.(js|css)$/.test(item.fileName)) continue;
        const content = item.type === "chunk" ? item.code : item.source;
        const data = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
        if (data.length < 1024) continue;
        this.emitFile({ type: "asset", fileName: `${item.fileName}.gz`, source: gzipSync(data, { level: 9 }) });
        this.emitFile({ type: "asset", fileName: `${item.fileName}.br`, source: brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }) });
      }
    } },
  };
}
