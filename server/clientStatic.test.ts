import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { request } from "node:http";
import { inlineLocaleHint, serveClient } from "./clientStatic";

test("HTML locale hints cannot inject executable markup", () => {
  const html = inlineLocaleHint("<head><!--forwardx-locale--></head>", { country: "</script><script>alert(1)</script>", setupLanguage: null });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /application\/json/);
  assert.match(html, /\\u003c/);
});

test("static delivery negotiates precompressed assets, caches only hashed assets, and never caches user HTML/APIs", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "forwardx-client-delivery-"));
  mkdirSync(path.join(directory, "assets"));
  const content = "export const hello = 'world';";
  const file = "app-ABC123.js";
  writeFileSync(path.join(directory, "assets", file), content);
  writeFileSync(path.join(directory, "assets", file + ".br"), brotliCompressSync(content));
  writeFileSync(path.join(directory, "assets", file + ".gz"), gzipSync(content));
  writeFileSync(path.join(directory, "index.html"), "<html><head><!--forwardx-locale--></head><body>App</body></html>");
  writeFileSync(path.join(directory, "favicon.svg"), "<svg/>");
  const app = express();
  app.get("/api/test", (_req, res) => { res.setHeader("Cache-Control", "no-store"); res.json({ ok: true }); });
  serveClient(app, directory);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  const get = (url: string, encoding = "identity", method = "GET") => new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    request({ hostname: "127.0.0.1", port, path: url, method, headers: { "Accept-Encoding": encoding } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", data => chunks.push(data));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject).end();
  });
  try {
    for (const [accept, encoding] of [["br, gzip", "br"], ["gzip, br;q=0", "gzip"], ["identity", undefined]] as const) {
      const result = await get(`/assets/${file}`, accept);
      assert.equal(result.status, 200);
      assert.equal(result.headers["content-encoding"], encoding);
      assert.match(result.headers["content-type"]!, /javascript/);
      assert.match(result.headers["cache-control"]!, /immutable/);
      assert.match(result.headers.vary!, /Accept-Encoding/);
      assert.deepEqual(result.body, encoding === "br" ? brotliCompressSync(content) : encoding === "gzip" ? gzipSync(content) : Buffer.from(content));
    }
    const head = await get(`/assets/${file}`, "gzip", "HEAD");
    assert.equal(head.body.length, 0);
    assert.equal(head.headers["content-encoding"], "gzip");
    for (const url of ["/", "/rules"]) {
      const result = await get(url);
      assert.equal(result.status, 200);
      assert.equal(result.headers["cache-control"], "private, no-store");
      assert.match(result.body.toString(), /id="forwardx-locale"/);
      assert.doesNotMatch(result.body.toString(), /<!--forwardx-locale-->/);
    }
    assert.equal((await get("/favicon.svg")).headers["cache-control"], "no-cache");
    assert.equal((await get("/api/test")).headers["cache-control"], "no-store");
    assert.equal((await get("/api/missing")).status, 404);
    assert.equal((await get("/assets/missing-ABC123.js")).status, 404);
    assert.equal((await get("/assets/%2e%2e%2findex.html")).status, 404);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); rmSync(directory, { recursive: true, force: true }); }
});
