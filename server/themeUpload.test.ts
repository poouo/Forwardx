import assert from "node:assert/strict";
import http from "node:http";
import { once, EventEmitter } from "node:events";
import { gzipSync } from "node:zlib";
import test from "node:test";
import express from "express";
import { THEME_LIMITS } from "../shared/themes";
import { createBoundedBodyParser } from "./requestBodyParser";
import { createThemeUploadBodyParser, THEME_UPLOAD_BODY_BYTES } from "./themeUpload";

const headers = { "Content-Type": "application/json", "x-test-role": "admin" };
async function fixture() {
  const app = express();
  const events = new EventEmitter();
  app.use((_req, res, next) => { res.once("close", () => events.emit("closed")); next(); });
  app.use(createThemeUploadBodyParser(createBoundedBodyParser(), async req => {
    const role = req.headers["x-test-role"];
    if (role === "disabled") return { role: "admin", accountEnabled: false };
    return typeof role === "string" ? { role } : null;
  }));
  app.post("/api/trpc/themes.install", (req, res) => {
    if (req.query.hold) events.emit("holding", res);
    else res.json({ size: req.body?.archiveBase64?.length || 0 });
  });
  app.post("/other", (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as import("node:net").AddressInfo;
  return { url: `http://127.0.0.1:${address.port}`, events,
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

async function sendDeclared(url: string, size: number, role?: string) {
  const request = http.request(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": String(size), ...(role ? { "x-test-role": role } : {}) } });
  request.on("error", () => {});
  const result = once(request, "response");
  request.flushHeaders();
  const [response] = await result;
  response.resume();
  await once(response, "end");
  request.destroy();
  return response.statusCode;
}

test("only authenticated enabled administrators receive the larger theme upload budget", async () => {
  const f = await fixture();
  try {
    const route = `${f.url}/api/trpc/themes.install?batch=1`;
    for (const [role, status] of [[undefined, 401], ["user", 403], ["disabled", 401]] as const) {
      assert.equal(await sendDeclared(route, THEME_UPLOAD_BODY_BYTES, role), status);
    }
    const encodedLength = 4 * Math.ceil(THEME_LIMITS.archiveBytes / 3);
    const response = await fetch(route, { method: "POST", headers, body: JSON.stringify({ archiveBase64: "A".repeat(encodedLength) }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { size: encodedLength });
  } finally { await f.close(); }
});

test("the upload cap and original limits on other routes and mixed batches are enforced before reading", async () => {
  const f = await fixture();
  try {
    assert.equal(await sendDeclared(`${f.url}/api/trpc/themes.install`, THEME_UPLOAD_BODY_BYTES + 1, "admin"), 413);
    for (const path of ["/other", "/api/trpc/themes.install,auth.login", "/api/trpc/themes.install.fake"]) {
      assert.equal(await sendDeclared(`${f.url}${path}`, 10 * 1024 * 1024 + 1, "admin"), 413);
    }
  } finally { await f.close(); }
});

test("a theme upload holds its single slot through installation while ordinary requests continue", async () => {
  const f = await fixture();
  try {
    const holding = once(f.events, "holding");
    const pending = fetch(`${f.url}/api/trpc/themes.install?hold=1`, { method: "POST", headers, body: JSON.stringify({ archiveBase64: "A".repeat(1024 * 1024 + 1) }) });
    const [held] = await holding;
    assert.equal(await sendDeclared(`${f.url}/api/trpc/themes.install`, 100, "admin"), 429);
    assert.equal((await fetch(`${f.url}/other`, { method: "POST", headers, body: "{}" })).status, 200);
    held.json({ ok: true });
    await (await pending).text();
    assert.equal((await fetch(`${f.url}/api/trpc/themes.install`, { method: "POST", headers, body: "{}" })).status, 200);
  } finally { await f.close(); }
});

test("compressed and chunked theme uploads cannot bypass the body cap", async () => {
  const f = await fixture();
  try {
    const body = JSON.stringify({ archiveBase64: "A".repeat(THEME_UPLOAD_BODY_BYTES) });
    for (const compressed of [false, true]) {
      const request = http.request(`${f.url}/api/trpc/themes.install`, { method: "POST", headers: { ...headers, "Transfer-Encoding": "chunked", ...(compressed ? { "Content-Encoding": "gzip" } : {}) } });
      request.on("error", () => {});
      const result = once(request, "response");
      request.end(compressed ? gzipSync(body) : body);
      const [response] = await result;
      response.resume();
      await once(response, "end");
      request.destroy();
      assert.equal(response.statusCode, 413);
    }
  } finally { await f.close(); }
});
