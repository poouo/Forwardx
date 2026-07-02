import type { Request, Response } from "express";
import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import jwt from "jsonwebtoken";
import { COOKIE_NAME } from "../../shared/const";
import type { User } from "../../drizzle/schema";
import { ENV } from "../env";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import {
  encodeSessionLease,
  getSessionKindField,
  inferLegacySessionKind,
  isSessionLeaseActive,
  normalizeSessionKind,
  parseSessionLease,
  shouldRefreshSessionLease,
  type SessionKind,
} from "../session";
import { DEV_ADMIN_USERNAME, isDevPanelMode } from "../devPanel";

export interface AuthSession {
  kind: SessionKind;
  sid: string | null;
  token: string;
  legacy: boolean;
  source: "cookie" | "bearer";
}

export interface TrpcContext {
  req: Request;
  res: Response;
  user: User | null;
  authSession: AuthSession | null;
  authFailureReason: "session_replaced" | null;
}

type TokenSource = "cookie" | "bearer";

const MULTI_DEVICE_LOGIN_SETTING_CACHE_MS = 30 * 1000;
let allowMultiDeviceLoginCache: { value: boolean; loadedAt: number } = { value: false, loadedAt: 0 };

function getRequestToken(req: Request): { token: string; source: TokenSource | null } {
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : "";
  if (bearerToken) return { token: bearerToken, source: "bearer" };
  const cookieToken = req.cookies?.[COOKIE_NAME];
  if (typeof cookieToken === "string" && cookieToken.trim()) {
    return { token: cookieToken.trim(), source: "cookie" };
  }
  return { token: "", source: null };
}

function clearSessionCookie(res: Response, req: Request) {
  res.clearCookie(COOKIE_NAME, { ...getSessionCookieOptions(req), maxAge: -1 });
}

function normalizeSessionPayload(req: Request, payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as Record<string, any>;
  const userId = Number(data.userId);
  if (!Number.isFinite(userId) || userId <= 0) return null;
  const sid = String(data.sid || "").trim();
  const kind = normalizeSessionKind(data.kind, inferLegacySessionKind(req));
  return {
    userId,
    sid: sid || null,
    kind,
  };
}

async function allowMultiDeviceLogin() {
  const now = Date.now();
  if (now - allowMultiDeviceLoginCache.loadedAt < MULTI_DEVICE_LOGIN_SETTING_CACHE_MS) {
    return allowMultiDeviceLoginCache.value;
  }
  const value = (await db.getSetting("allowMultiDeviceLogin").catch(() => null)) === "true";
  allowMultiDeviceLoginCache = { value, loadedAt: now };
  return value;
}

async function refreshActiveSessionLease(userId: number, sessionKind: SessionKind, sid: string, storedToken: string) {
  const now = Date.now();
  const lease = parseSessionLease(storedToken);
  if (!shouldRefreshSessionLease(lease, sid, now)) return;
  await db.setUserSessionToken(userId, sessionKind, encodeSessionLease(sid, now), { touchUserUpdatedAt: false });
}

type ResolveSessionResult =
  | { user: User; authSession: AuthSession; failureReason?: never }
  | { user: null; authSession: null; failureReason: "session_replaced" | null };

async function resolveSessionFromToken(req: Request, res: Response, token: string, source: TokenSource): Promise<ResolveSessionResult> {
  try {
    if (!ENV.cookieSecret) return { user: null, authSession: null, failureReason: null };
    const payload = jwt.verify(token, ENV.cookieSecret);
    const normalized = normalizeSessionPayload(req, payload);
    if (!normalized) return { user: null, authSession: null, failureReason: null };

    const found = await db.getUserById(normalized.userId);
    if (!found) return { user: null, authSession: null, failureReason: null };

    const sessionKind = normalized.sid ? normalized.kind : inferLegacySessionKind(req);
    const field = getSessionKindField(sessionKind);
    const storedToken = String((found as any)[field] || "").trim();

    if (normalized.sid) {
      if (!(await allowMultiDeviceLogin())) {
        const activeLease = parseSessionLease(storedToken);
        if (activeLease?.sid && activeLease.sid !== normalized.sid && isSessionLeaseActive(activeLease)) {
          return {
            user: null,
            authSession: null,
            failureReason: "session_replaced",
          };
        }
        await refreshActiveSessionLease(found.id, sessionKind, normalized.sid, storedToken).catch((error) => {
          console.warn(`[Auth] refresh session lease failed userId=${found.id} kind=${sessionKind}: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    } else if (storedToken) {
      if (source === "cookie") clearSessionCookie(res, req);
      return {
        user: null,
        authSession: null,
        failureReason: null,
      };
    }

    return {
      user: found,
      authSession: {
        kind: sessionKind,
        sid: normalized.sid,
        token,
        legacy: !normalized.sid,
        source,
      },
    };
  } catch {
    if (source === "cookie") {
      clearSessionCookie(res, req);
    }
    return { user: null, authSession: null, failureReason: null };
  }
}

export async function createContext({ req, res }: CreateExpressContextOptions): Promise<TrpcContext> {
  let user: User | null = null;
  let authSession: AuthSession | null = null;
  let authFailureReason: TrpcContext["authFailureReason"] = null;

  if (isDevPanelMode()) {
    const devUser = await db.getUserByUsername(DEV_ADMIN_USERNAME).catch(() => null);
    if (devUser) {
      return {
        req,
        res,
        user: devUser,
        authSession: {
          kind: "browser",
          sid: "dev-panel",
          token: "dev-panel",
          legacy: false,
          source: "cookie",
        },
        authFailureReason: null,
      };
    }
  }

  const session = getRequestToken(req);
  if (session.token) {
    const resolved = await resolveSessionFromToken(req, res, session.token, session.source || "cookie");
    if (resolved.user) {
      user = resolved.user;
      authSession = resolved.authSession;
    } else {
      authFailureReason = resolved.failureReason ?? null;
    }
  }

  return { req, res, user, authSession, authFailureReason };
}
