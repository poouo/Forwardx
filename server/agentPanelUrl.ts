import type { Request } from "express";
import * as db from "./db";

function firstHeaderValue(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw || "").split(",")[0].trim();
}

export function normalizePanelUrl(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) return "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

export async function getConfiguredPanelUrl(): Promise<string> {
  const configured = normalizePanelUrl((await db.getSetting("panelPublicUrl")) || "");
  return configured && /^https?:\/\//i.test(configured) ? configured : "";
}

function forwardedProto(req: Request) {
  const cfVisitor = firstHeaderValue(req.headers["cf-visitor"]);
  if (cfVisitor) {
    try {
      const parsed = JSON.parse(cfVisitor);
      const scheme = String(parsed?.scheme || "").toLowerCase();
      if (scheme === "http" || scheme === "https") return scheme;
    } catch {
      // Ignore malformed proxy metadata and continue with normal headers.
    }
  }
  const proto = firstHeaderValue(req.headers["x-forwarded-proto"]).toLowerCase();
  if (proto === "http" || proto === "https") return proto;
  return req.protocol === "https" ? "https" : "http";
}

function forwardedHost(req: Request) {
  const host = firstHeaderValue(req.headers["x-forwarded-host"]) || req.get("host") || "";
  if (!host || /[\s/?#\\@]/.test(host)) return "";
  return host;
}

function forwardedPrefix(req: Request) {
  const prefix = firstHeaderValue(req.headers["x-forwarded-prefix"]);
  if (!prefix || prefix === "/") return "";
  if (!prefix.startsWith("/") || /[?#\\\s]/.test(prefix)) return "";
  try {
    const segments = decodeURIComponent(prefix).split("/");
    if (segments.some((segment) => segment === "." || segment === "..")) return "";
  } catch {
    return "";
  }
  return prefix.replace(/\/+$/, "");
}

export function resolveRequestPanelUrl(req: Request, configuredPanelUrl = ""): string {
  const configured = normalizePanelUrl(configuredPanelUrl);
  if (configured) return configured;

  const proto = forwardedProto(req);
  const host = forwardedHost(req);
  if (!host) return "";

  const forwardedPort = firstHeaderValue(req.headers["x-forwarded-port"]);
  const validForwardedPort = /^\d{1,5}$/.test(forwardedPort) && Number(forwardedPort) > 0 && Number(forwardedPort) <= 65535
    ? forwardedPort
    : "";
  const hasPort = /^\[[^\]]+\]:\d+$/.test(host) || /^[^:]+:\d+$/.test(host);
  const defaultPort = (proto === "https" && validForwardedPort === "443") || (proto === "http" && validForwardedPort === "80");
  const hostWithPort = !hasPort && validForwardedPort && !defaultPort ? `${host}:${validForwardedPort}` : host;
  try {
    const url = new URL(`${proto}://${hostWithPort}`);
    url.pathname = forwardedPrefix(req) || "/";
    return normalizePanelUrl(url.toString());
  } catch {
    return "";
  }
}

export async function resolvePanelUrl(req: Request): Promise<string> {
  return resolveRequestPanelUrl(req, await getConfiguredPanelUrl());
}

export async function resolveAgentAdvertisedPanelUrl(): Promise<string> {
  return getConfiguredPanelUrl();
}
