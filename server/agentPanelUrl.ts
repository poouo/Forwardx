import { Request } from "express";
import * as db from "./db";

function firstHeaderValue(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw || "").split(",")[0].trim();
}

function normalizePanelUrl(value: string) {
  return String(value || "").trim().replace(/\/+$/, "");
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
  return req.protocol || "http";
}

function forwardedHost(req: Request) {
  return firstHeaderValue(req.headers["x-forwarded-host"]) || req.get("host") || "";
}

export async function resolvePanelUrl(req: Request): Promise<string> {
  const configured = await getConfiguredPanelUrl();
  if (configured) return configured;

  const proto = forwardedProto(req);
  const host = forwardedHost(req);
  if (!host) return `${req.protocol}://${req.get("host")}`;

  const forwardedPort = firstHeaderValue(req.headers["x-forwarded-port"]);
  const hasPort = /^\[[^\]]+\]:\d+$/.test(host) || /^[^:]+:\d+$/.test(host);
  const defaultPort = (proto === "https" && forwardedPort === "443") || (proto === "http" && forwardedPort === "80");
  const hostWithPort = !hasPort && forwardedPort && !defaultPort ? `${host}:${forwardedPort}` : host;
  return `${proto}://${hostWithPort}`.replace(/\/+$/, "");
}

export async function resolveAgentAdvertisedPanelUrl(): Promise<string> {
  return getConfiguredPanelUrl();
}
