import type { Plugin } from "vite";
import { brotliCompressSync, gzipSync, constants } from "node:zlib";
import { clientRoutes } from "../shared/clientRoutes";

/** Download the shell and current route in parallel without evaluating them
 * before locale initialization. Other pages are fetched only on intent/use. */
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

        const routeFiles: Record<string, { js: string[]; css: string[] }> = {};
        for (const page of new Set([...clientRoutes.map(route => route.page), "HostMonitor"])) {
          const entry = Object.values(bundle).find(item => item.type === "chunk" &&
            [item.facadeModuleId, ...Object.keys(item.modules)].some(id => id?.replace(/\\/g, "/").endsWith(`/client/src/pages/${page}.tsx`)));
          if (entry?.type !== "chunk") continue;
          const js = new Set<string>();
          const css = new Set<string>();
          const visitPage = (name: string) => {
            if (js.has(name)) return;
            js.add(name);
            const chunk = bundle[name];
            if (chunk?.type !== "chunk") return;
            for (const file of (chunk as typeof chunk & { viteMetadata?: { importedCss?: Set<string> } }).viteMetadata?.importedCss || []) css.add(file);
            chunk.imports.forEach(visitPage);
          };
          visitPage(entry.fileName);
          routeFiles[page] = { js: [...js], css: [...css] };
        }
        // Network hints only: never import/evaluate here (module-scope labels
        // rely on main.tsx having initialized the selected language first).
        const data = JSON.stringify({ routes: clientRoutes, files: routeFiles }).replace(/</g, "\\u003c");
        const preload = `<script data-forwardx-route-preload>(()=>{const d=${data};const p=location.pathname;const r=d.routes.find(r=>r.prefix?p.startsWith(r.path)&&/^[^/]+$/.test(p.slice(r.path.length)):p===r.path);const page=r?r.page:(p!=="/404"&&/^\\/[^/]+$/.test(p)?"HostMonitor":null);const f=d.files[page];if(!f)return;for(const [kind,files] of Object.entries(f))for(const file of files){const href="/"+file;if(document.querySelector('link[href="'+href+'"],script[src="'+href+'"]'))continue;const l=document.createElement("link");l.rel=kind==="js"?"modulepreload":"preload";if(kind==="css")l.as="style";l.crossOrigin="";l.href=href;document.head.appendChild(l)}})();</script>`;
        html.source = String(html.source).replace("</head>", `${preload}\n</head>`);
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
