import http from "node:http";
import https from "node:https";
import type { RequestHandler } from "express";
import { getSeamlessMigrationState } from "./seamlessMigrationState";

const hopHeaders = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authorization", "proxy-authenticate", "te", "trailer", "cookie", "set-cookie"]);
let requests = 0;
let streams = 0;
let lastRelayWarningAt = 0;

function warnRelay(id: string, reason: string) {
  if (Date.now() - lastRelayWarningAt < 60_000) return;
  lastRelayWarningAt = Date.now();
  console.warn(`[MigrationRelay] id=${id} reason=${reason} requests=${requests} streams=${streams}; forwarding processes remain running`);
}

// Mount BEFORE body parsers. Authentication proofs cover the original bytes;
// parsing/reserializing, following redirects, or buffering SSE is not allowed.
export const seamlessAgentProxy: RequestHandler = (req, res, next) => {
  const state = getSeamlessMigrationState();
  const agentPath = req.path.startsWith("/api/agent/") || req.path === "/api/sync" || req.path === "/api/stream" || req.path.startsWith("/api/payment/");
  if (state?.role !== "source" || !["forwarding", "archived"].includes(state.phase) || !agentPath) return next();
  const stream = req.path === "/api/stream";
  if (req.headers["x-forwardx-migration-hop"] || (stream ? streams >= 2048 : requests >= 256)) {
    warnRelay(state.id, req.headers["x-forwardx-migration-hop"] ? "relay-loop-rejected" : "capacity-exceeded");
    res.setHeader("Retry-After", "5");
    res.status(503).json({ error: "Migration relay unavailable or busy" });
    return;
  }
  if (stream) streams++; else requests++;
  let released = false;
  const release = () => { if (!released) { released = true; if (stream) streams--; else requests--; } };
  const target = new URL(state.targetUrl);
  target.pathname = `${target.pathname.replace(/\/$/, "")}${req.path}`;
  target.search = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  const headers: http.OutgoingHttpHeaders = {};
  const connectionHeaders = new Set(String(req.headers.connection || "").toLowerCase().split(",").map((value) => value.trim()));
  for (const [key, value] of Object.entries(req.headers)) {
    if (!hopHeaders.has(key) && !connectionHeaders.has(key) && !key.startsWith("x-forwarded-")) headers[key] = value;
  }
  headers["x-forwardx-migration-hop"] = state.id;
  headers["x-forwardx-migration-relay"] = state.tokenHash; // private relay credential; target never returns it
  const upstream = (target.protocol === "https:" ? https : http).request(target, { method: req.method, headers }, (response) => {
    res.status(response.statusCode || 502);
    const responseConnectionHeaders = new Set(String(response.headers.connection || "").toLowerCase().split(",").map((value) => value.trim()));
    for (const [key, value] of Object.entries(response.headers)) {
      if (value !== undefined && !hopHeaders.has(key) && !responseConnectionHeaders.has(key) && !key.startsWith("x-forwardx-migration-")) res.setHeader(key, value);
    }
    if (stream) { res.setHeader("X-Accel-Buffering", "no"); res.flushHeaders(); }
    response.on("error", () => { res.destroy(); });
    response.pipe(res); // Node pipe provides backpressure for SSE and HTTP bodies.
  });
  upstream.setTimeout(stream ? 90_000 : 60_000, () => upstream.destroy(new Error("relay timeout")));
  upstream.on("error", (error: NodeJS.ErrnoException) => {
    warnRelay(state.id, error.code || "upstream-unavailable-or-timeout");
    if (!res.headersSent) res.status(502).json({ error: "New panel unavailable; forwarding processes remain running" });
    else res.destroy();
  });
  res.once("close", () => { release(); if (!res.writableFinished) upstream.destroy(); });
  res.once("finish", release);
  req.once("aborted", () => upstream.destroy());
  req.pipe(upstream);
};
