import express, { type Express } from "express";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { requestLocaleHint } from "./localeHint";

export function inlineLocaleHint(html: string, hint: { country: string | null; setupLanguage: string | null }) {
  // UI hints only, never credentials or per-user data. Escape even though the
  // current allowlisted values cannot contain markup.
  const json = JSON.stringify(hint).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  return html.replace("<!--forwardx-locale-->", `<script id="forwardx-locale" type="application/json">${json}</script>`);
}

export function serveClient(app: Express, clientDist: string) {
  const indexFile = path.join(clientDist, "index.html");
  const html = existsSync(indexFile) ? readFileSync(indexFile, "utf8") : null;
  const assets = path.join(clientDist, "assets");
  const compressed = new Set(existsSync(assets) ? readdirSync(assets).filter(file => /\.(br|gz)$/.test(file)) : []);
  // Compression happens at build time, not in Node's request/event loop. Only
  // generated JS/CSS assets are immutable. HTML and API responses never are.
  app.use("/assets", (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    let decoded: string;
    try { decoded = decodeURIComponent(req.path); } catch { res.sendStatus(400); return; }
    if (decoded.includes("\\") || decoded.split("/").includes("..")) { res.sendStatus(404); return; }
    const name = req.path.slice(1);
    if (!/^[\w.-]+-[\w-]+\.(js|css)$/.test(name)) return next();
    res.vary("Accept-Encoding");
    const encoding = req.acceptsEncodings("br", "gzip", "identity");
    const extension = encoding === "br" ? ".br" : encoding === "gzip" ? ".gz" : "";
    if (!extension || !compressed.has(name + extension) || !encoding) return next();
    res.type(name.endsWith(".css") ? "text/css" : "application/javascript");
    res.setHeader("Content-Encoding", encoding);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(path.join(assets, name + extension));
  });
  app.use(express.static(clientDist, {
    index: false,
    setHeaders(res, file) {
      if (path.dirname(file) === assets && /-[\w-]+\.(js|css)$/.test(file)) {
        res.vary("Accept-Encoding");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else res.setHeader("Cache-Control", "no-cache");
    },
  }));
  app.get("*", (req, res) => {
    // Missing API/assets must not return a successful HTML response.
    if (req.path.startsWith("/api/") || req.path.startsWith("/assets/")) { res.sendStatus(404); return; }
    if (!html) { res.status(503).send("Client build unavailable"); return; }
    res.setHeader("Cache-Control", "private, no-store");
    res.type("html").send(inlineLocaleHint(html, requestLocaleHint(req)));
  });
}
