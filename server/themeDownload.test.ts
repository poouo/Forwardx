import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { downloadThemeArchive } from "./themeDownload";
import { THEME_LIMITS } from "../shared/themes";

function response(status: number, headers: Record<string, string> = {}, chunks: Buffer[] = []) {
  return Object.assign(Readable.from(chunks), { statusCode: status, headers }) as unknown as IncomingMessage;
}

test("remote import streams a bounded download and follows checked redirects", async () => {
  const checked: string[] = [];
  const result = await downloadThemeArchive("https://themes.example/start", {
    validate: async url => { checked.push(url); return new URL(url); },
    request: async url => url.pathname === "/start" ? response(302, { location: "/theme.rar" }) : response(200, {}, [Buffer.from("archive")]),
  });
  assert.equal(result.toString(), "archive");
  assert.deepEqual(checked, ["https://themes.example/start", "https://themes.example/theme.rar"]);
});

test("local destinations, embedded credentials and redirect-to-private URLs are rejected", async () => {
  for (const url of ["http://127.0.0.1/theme.zip", "http://[::1]/theme.zip", "http://169.254.169.254/", "file:///tmp/theme.zip", "http://user:pass@8.8.8.8/theme.zip"]) {
    await assert.rejects(downloadThemeArchive(url, { request: async () => { throw new Error("should never be requested"); } }), /不允许|仅支持/);
  }
  let requests = 0;
  await assert.rejects(downloadThemeArchive("https://8.8.8.8/start", {
    request: async () => { requests++; return response(302, { location: "http://127.0.0.1/private" }); },
  }), /受限地址/);
  assert.equal(requests, 1);
});

test("header and streamed sizes, status errors and redirect loops are bounded", async () => {
  const validate = async (url: string) => new URL(url);
  for (const res of [response(200, { "content-length": String(THEME_LIMITS.archiveBytes + 1) }), response(200, {}, [Buffer.alloc(THEME_LIMITS.archiveBytes), Buffer.from("x")])]) {
    await assert.rejects(downloadThemeArchive("https://themes.example/a", { validate, request: async () => res }), /3MB/);
  }
  await assert.rejects(downloadThemeArchive("https://themes.example/a", { validate, request: async () => response(404) }), /HTTP 404/);
  await assert.rejects(downloadThemeArchive("https://themes.example/a", { validate, request: async () => response(302, { location: "/a" }) }), /重定向/);
  await assert.rejects(downloadThemeArchive("https://themes.example/a", { validate, request: async () => response(200, { "content-encoding": "gzip" }) }), /identity/);
  await assert.rejects(downloadThemeArchive("https://themes.example/a", { signal: AbortSignal.abort() }), /超时|取消/);
});

test("the total deadline also covers a stalled DNS/address validation", async () => {
  const controller = new AbortController();
  const pending = downloadThemeArchive("https://themes.example/a", { signal: controller.signal, validate: () => new Promise(() => {}) });
  controller.abort();
  await assert.rejects(pending, /超时|取消/);
});
