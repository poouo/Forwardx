import assert from "node:assert/strict";
import test from "node:test";
import type { Request } from "express";
import { normalizePanelUrl, resolveRequestPanelUrl } from "./agentPanelUrl";

function request(headers: Record<string, string | string[] | undefined>, protocol = "http") {
  return {
    headers,
    protocol,
    get(name: string) {
      if (name.toLowerCase() === "host") return String(headers.host || "");
      return undefined;
    },
  } as unknown as Request;
}

test("configured panel URL is validated and keeps a base path", () => {
  assert.equal(normalizePanelUrl(" https://panel.example.com/forwardx/ "), "https://panel.example.com/forwardx");
  assert.equal(normalizePanelUrl("javascript:alert(1)"), "");
  assert.equal(normalizePanelUrl("https://user:pass@panel.example.com"), "");
  assert.equal(normalizePanelUrl("https://panel.example.com/?redirect=bad"), "");
});

test("request panel URL uses the first trusted proxy values", () => {
  const req = request({
    host: "127.0.0.1:9810",
    "x-forwarded-proto": "https, http",
    "x-forwarded-host": "panel.example.com, internal.local",
    "x-forwarded-port": "443",
    "x-forwarded-prefix": "/forwardx",
  });
  assert.equal(resolveRequestPanelUrl(req), "https://panel.example.com/forwardx");
});

test("request panel URL adds a non-default forwarded port", () => {
  const req = request({
    host: "internal:9810",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "panel.example.com",
    "x-forwarded-port": "8443",
  });
  assert.equal(resolveRequestPanelUrl(req), "https://panel.example.com:8443");
});

test("unsafe host and prefix values are ignored", () => {
  assert.equal(resolveRequestPanelUrl(request({ host: "panel.example.com/path" })), "");
  assert.equal(resolveRequestPanelUrl(request({ host: "panel.example.com", "x-forwarded-prefix": "/../admin" })), "http://panel.example.com");
});
