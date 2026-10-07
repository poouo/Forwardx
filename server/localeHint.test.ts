import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initialSetupLanguage, localeCountryHint, registerLocaleHintRoute } from "./localeHint";
import { hasLocalSetupCompleteMarker } from "./setupState";

test("installation language is whitelisted and no longer used after setup completes", () => {
  for (const value of ["zh-CN", "en"] as const) {
    assert.equal(initialSetupLanguage(value, false), value);
    assert.equal(initialSetupLanguage(value, true), null);
  }
  for (const value of [undefined, "", "auto", "zh", "EN", "fr", "<script>", ["en"]]) {
    assert.equal(initialSetupLanguage(value, false), null);
  }
});

test("country headers are advisory and ignored from untrusted clients", () => {
  assert.equal(localeCountryHint(null, "US", false), null);
  assert.equal(localeCountryHint(null, "US", true), "US");
  assert.equal(localeCountryHint("CN", "US", true), "CN");
  for (const value of ["XX", "T1", "USA", "", ["US"], "US\nCN"]) assert.equal(localeCountryHint(null, value, true), null);
});

test("locale route needs neither database queries nor third-party lookups", () => {
  let handler: any;
  registerLocaleHintRoute({ get(path: string, callback: any) { assert.equal(path, "/api/locale"); handler = callback; } } as any);
  let result: unknown;
  const headers = new Map<string, string>();
  handler({ app: { get: () => () => false }, socket: { remoteAddress: "127.0.0.1" }, ip: "127.0.0.1", headers: { "cf-ipcountry": "US" } }, {
    setHeader(key: string, value: string) { headers.set(key, value); }, json(value: unknown) { result = value; },
  });
  assert.deepEqual(result, { country: null, setupLanguage: initialSetupLanguage(process.env.FORWARDX_SETUP_LANGUAGE, hasLocalSetupCompleteMarker()) });
  assert.equal(headers.get("Cache-Control"), "private, no-store");
});

test("locale route exposes installation language before initialization without a database", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-setup-language-"));
  const marker = process.env.FORWARDX_SETUP_COMPLETE_MARKER;
  const language = process.env.FORWARDX_SETUP_LANGUAGE;
  try {
    process.env.FORWARDX_SETUP_COMPLETE_MARKER = path.join(directory, "complete");
    process.env.FORWARDX_SETUP_LANGUAGE = "en";
    let handler: any;
    registerLocaleHintRoute({ get(_path: string, callback: any) { handler = callback; } } as any);
    const req = { app: { get: () => () => false }, socket: { remoteAddress: "127.0.0.1" }, ip: "127.0.0.1", headers: {} };
    let result: unknown;
    const res = { setHeader() {}, json(value: unknown) { result = value; } };
    handler(req, res);
    assert.deepEqual(result, { country: null, setupLanguage: "en" });
    fs.writeFileSync(process.env.FORWARDX_SETUP_COMPLETE_MARKER, "complete");
    handler(req, res);
    assert.deepEqual(result, { country: null, setupLanguage: null });
  } finally {
    if (marker === undefined) delete process.env.FORWARDX_SETUP_COMPLETE_MARKER;
    else process.env.FORWARDX_SETUP_COMPLETE_MARKER = marker;
    if (language === undefined) delete process.env.FORWARDX_SETUP_LANGUAGE;
    else process.env.FORWARDX_SETUP_LANGUAGE = language;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
