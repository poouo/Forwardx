import express, { type Request, type RequestHandler, type Response } from "express";
import { setBoundedMapValue } from "./boundedCache";

const MB = 1024 * 1024;

// Admission happens before raw-body buffers or JSON objects are allocated.
// This is a process resource bound, not a substitute for edge DDoS protection.
export function createBoundedBodyParser(options: {
  maxConcurrent?: number;
  maxPerIp?: number;
  timeoutMs?: number;
  largeBodyLimit?: number;
  globalLargeBodyLimit?: number;
  maxLargeRequests?: number;
  maxLargeRequestsPerIp?: number;
  now?: () => number;
} = {}): RequestHandler {
  const maxConcurrent = options.maxConcurrent ?? 8;
  const maxPerIp = options.maxPerIp ?? 4;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const largeBodyLimit = options.largeBodyLimit ?? 12;
  const globalLargeBodyLimit = options.globalLargeBodyLimit ?? 120;
  const maxLargeRequests = options.maxLargeRequests ?? 4;
  const maxLargeRequestsPerIp = options.maxLargeRequestsPerIp ?? 2;
  const now = options.now ?? Date.now;
  let active = 0;
  const activeByIp = new Map<string, number>();
  let largeActive = 0;
  const largeActiveByIp = new Map<string, number>();
  type Window = { start: number; count: number };
  const largeByIp = new Map<string, Window>();
  let globalWindow: Window = { start: now(), count: 0 };
  const windowMs = 60_000;

  function windowFor(ip: string) {
    const time = now();
    if (time - globalWindow.start >= windowMs) globalWindow = { start: time, count: 0 };
    let entry = largeByIp.get(ip);
    if (!entry || time - entry.start >= windowMs) entry = { start: time, count: 0 };
    setBoundedMapValue(largeByIp, ip, entry, 4096);
    return entry;
  }

  const reject = (req: Request, res: Response, status: number, code: string) => {
    if (res.headersSent || res.destroyed) return;
    if (status === 429) res.setHeader("Retry-After", "60");
    // Never leave an unread rejected body on a keep-alive connection.
    res.setHeader("Connection", "close");
    res.once("finish", () => {
      if (req.complete || req.destroyed) return;
      // Let the error response reach upload clients before closing. Immediate
      // destroy() resets the socket and hides the useful 413/429 response.
      req.resume();
      req.socket.end();
      const closeTimer = setTimeout(() => req.destroy(), 1000);
      closeTimer.unref();
      req.socket.once("close", () => clearTimeout(closeTimer));
    });
    res.status(status).json({ error: code });
  };

  return (req, res, next) => {
    const json = Boolean(req.is("application/json"));
    const form = Boolean(req.is("application/x-www-form-urlencoded"));
    const hasBody = req.headers["transfer-encoding"] !== undefined || Number(req.headers["content-length"]) > 0;
    if ((!json && !form) || !hasBody) return next();
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const length = Number(req.headers["content-length"] || 0);
    if (length > (json ? 10 * MB : MB)) return reject(req, res, 413, "REQUEST_BODY_TOO_LARGE");
    if (length > MB || req.headers["transfer-encoding"] !== undefined
      || (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity")) {
      const entry = windowFor(ip);
      // Once exhausted, reject potential large bodies before decompression or
      // buffering too. Otherwise gzip/chunked clients could keep doing the
      // expensive read even when verify() will refuse their JSON parsing.
      if (entry.count >= largeBodyLimit || globalWindow.count >= globalLargeBodyLimit) {
        return reject(req, res, 429, "REQUEST_BODY_RATE_LIMITED");
      }
    }
    if (active >= maxConcurrent || (activeByIp.get(ip) || 0) >= maxPerIp) {
      return reject(req, res, 429, "REQUEST_BODY_BUSY");
    }

    let charged = false;
    let largeHeld = false;
    const releaseLarge = () => {
      if (!largeHeld) return;
      largeHeld = false;
      largeActive--;
      const count = (largeActiveByIp.get(ip) || 1) - 1;
      if (count) largeActiveByIp.set(ip, count);
      else largeActiveByIp.delete(ip);
      res.off("finish", releaseLarge);
      res.off("close", releaseLarge);
    };
    const chargeLargeBody = () => {
      if (charged) return;
      const entry = windowFor(ip);
      if (entry.count >= largeBodyLimit || globalWindow.count >= globalLargeBodyLimit
        || largeActive >= maxLargeRequests || (largeActiveByIp.get(ip) || 0) >= maxLargeRequestsPerIp) {
        throw Object.assign(new Error("REQUEST_BODY_RATE_LIMITED"), { status: 429 });
      }
      entry.count++;
      globalWindow.count++;
      charged = true;
      // The parsed object remains reachable by route handlers after parsing.
      // Hold large-body capacity until the response ends, not just until next().
      largeHeld = true;
      largeActive++;
      largeActiveByIp.set(ip, (largeActiveByIp.get(ip) || 0) + 1);
      res.once("finish", releaseLarge);
      res.once("close", releaseLarge);
    };
    // Known large requests are refused before any body read. Chunked/compressed
    // requests are charged in verify(), after the size cap but before JSON.parse.
    if (length > MB) {
      try { chargeLargeBody(); } catch { return reject(req, res, 429, "REQUEST_BODY_RATE_LIMITED"); }
    }
    active++;
    activeByIp.set(ip, (activeByIp.get(ip) || 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      req.off("aborted", release);
      req.socket.off("close", release);
      active--;
      const count = (activeByIp.get(ip) || 1) - 1;
      if (count) activeByIp.set(ip, count);
      else activeByIp.delete(ip);
    };
    const timer = setTimeout(() => {
      reject(req, res, 408, "REQUEST_BODY_TIMEOUT");
      // Do not free the slot until the reader is actually aborted/closed.
    }, timeoutMs);
    timer.unref();
    req.once("aborted", release);
    req.socket.once("close", release);
    const verify = (_req: Request, _res: Response, buffer: Buffer) => {
      if (buffer.length > MB) chargeLargeBody();
    };
    const parser = json
      ? express.json({ limit: "10mb", verify })
      : express.urlencoded({ limit: "1mb", extended: true, parameterLimit: 1000 });
    parser(req, res, (error?: { status?: number }) => {
      if (released) return;
      release();
      if (res.headersSent || res.destroyed) return;
      if (error) {
        const status = error.status || 400;
        reject(req, res, status, status === 429 ? "REQUEST_BODY_RATE_LIMITED" : status === 413 ? "REQUEST_BODY_TOO_LARGE" : "INVALID_REQUEST_BODY");
        return;
      }
      next();
    });
  };
}
