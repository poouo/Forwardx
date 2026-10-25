import assert from "node:assert/strict";
import http from "node:http";
import { once, EventEmitter } from "node:events";
import { gzipSync } from "node:zlib";
import test from "node:test";
import express from "express";
import { createBoundedBodyParser } from "./requestBodyParser";

async function fixture(options: Parameters<typeof createBoundedBodyParser>[0] = {}) {
  const app = express();
  const events = new EventEmitter();
  app.use((req, res, next) => {
    res.once("close", () => events.emit("closed"));
    setImmediate(() => events.emit("arrived"));
    next();
  });
  app.use(createBoundedBodyParser(options));
  app.post("/hold", (_req, res) => {
    events.emit("holding", res);
  });
  app.post("/", (req, res) => res.json({ size: req.body?.content?.length || 0 }));
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as import("node:net").AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/`, events,
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

const jsonHeaders = { "Content-Type": "application/json" };
const largeBody = JSON.stringify({ content: "x".repeat(1024 * 1024 + 1) });

async function holdBody(f: Awaited<ReturnType<typeof fixture>>) {
  const arrived = once(f.events, "arrived");
  const request = http.request(f.url, { method: "POST", headers: { ...jsonHeaders, "Content-Length": "100" } });
  request.on("error", () => {});
  request.write("{");
  await arrived;
  return request;
}

async function rejectedWithoutUpload(url: string, size: number) {
  const request = http.request(url, { method: "POST", headers: { ...jsonHeaders, "Content-Length": String(size) } });
  request.on("error", () => {});
  const result = once(request, "response");
  request.flushHeaders();
  const [response] = await result;
  const incoming = response as http.IncomingMessage;
  incoming.resume();
  await once(incoming, "end");
  request.destroy();
  return incoming.statusCode;
}

test("valid large uploads work; parse/size failures do not leak slots", async () => {
  const f = await fixture({ maxConcurrent: 1 });
  try {
    let response = await fetch(f.url, { method: "POST", headers: jsonHeaders, body: largeBody });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { size: 1024 * 1024 + 1 });
    response = await fetch(f.url, { method: "POST", headers: jsonHeaders, body: "{" });
    assert.equal(response.status, 400);
    // The server must reject the declared size without waiting for its body.
    assert.equal(await rejectedWithoutUpload(f.url, 10 * 1024 * 1024 + 1), 413);
    response = await fetch(f.url, { method: "POST", headers: jsonHeaders, body: "{}" });
    assert.equal(response.status, 200);
  } finally { await f.close(); }
});

test("in-flight body limit rejects before reading and releases on disconnect", async () => {
  const f = await fixture({ maxConcurrent: 1 });
  try {
    const held = await holdBody(f);
    const response = await fetch(f.url, { method: "POST", headers: jsonHeaders, body: "{}" });
    assert.equal(response.status, 429);
    await response.text();
    const closed = once(f.events, "closed");
    held.destroy();
    await closed;
    assert.equal((await fetch(f.url, { method: "POST", headers: jsonHeaders, body: "{}" })).status, 200);
  } finally { await f.close(); }
});

test("slow body timeout terminates reader and frees capacity", async () => {
  const f = await fixture({ maxConcurrent: 1, timeoutMs: 60 });
  try {
    const held = await holdBody(f);
    const result = once(held, "response");
    const closed = once(f.events, "closed");
    const [response] = await result;
    assert.equal((response as http.IncomingMessage).statusCode, 408);
    (response as http.IncomingMessage).resume();
    await closed;
    assert.equal((await fetch(f.url, { method: "POST", headers: jsonHeaders, body: "{}" })).status, 200);
  } finally { await f.close(); }
});

test("large-body rate budget resets and does not throttle small Agent reports", async () => {
  let time = 1;
  const f = await fixture({ largeBodyLimit: 1, now: () => time });
  try {
    assert.equal((await fetch(f.url, { method: "POST", headers: jsonHeaders, body: largeBody })).status, 200);
    assert.equal(await rejectedWithoutUpload(f.url, Buffer.byteLength(largeBody)), 429);
    assert.equal((await fetch(f.url, { method: "POST", headers: jsonHeaders, body: "{}" })).status, 200);
    time += 60_000;
    assert.equal((await fetch(f.url, { method: "POST", headers: jsonHeaders, body: largeBody })).status, 200);
  } finally { await f.close(); }
});

test("chunked/compressed bodies cannot bypass the large JSON parse budget", async () => {
  for (const compressed of [false, true]) {
    const f = await fixture({ largeBodyLimit: 1 });
    const send = async (upload = true) => {
      const request = http.request(f.url, { method: "POST", headers: { ...jsonHeaders, "Transfer-Encoding": "chunked", ...(compressed ? { "Content-Encoding": "gzip" } : {}) } });
      const result = once(request, "response");
      request.on("error", () => {});
      // write() before end() deliberately forces chunked transfer encoding.
      if (upload) {
        request.write(compressed ? gzipSync(largeBody) : largeBody);
        request.end();
      } else {
        request.flushHeaders();
      }
      const [response] = await result;
      const incoming = response as http.IncomingMessage;
      incoming.resume();
      await once(incoming, "end");
      request.destroy();
      return incoming.statusCode;
    };
    try {
      assert.equal(await send(), 200);
      assert.equal(await send(false), 429, "exhausted budget must reject before reading/inflating another body");
    } finally { await f.close(); }
  }
});

test("large parsed bodies remain bounded while route handlers are awaiting work", async () => {
  const f = await fixture({ maxLargeRequests: 1 });
  try {
    const holding = once(f.events, "holding");
    const pending = fetch(`${f.url}hold`, { method: "POST", headers: jsonHeaders, body: largeBody });
    const [heldResponse] = await holding;
    assert.equal(await rejectedWithoutUpload(f.url, Buffer.byteLength(largeBody)), 429);
    assert.equal((await fetch(f.url, { method: "POST", headers: jsonHeaders, body: "{}" })).status, 200);
    (heldResponse as express.Response).json({ ok: true });
    await (await pending).text();
    assert.equal((await fetch(f.url, { method: "POST", headers: jsonHeaders, body: largeBody })).status, 200);
  } finally { await f.close(); }
});
