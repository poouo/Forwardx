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
  isSessionLeaseOwnedByAnother,
  normalizeSessionKind,
  parseSessionLease,
  shouldRefreshSessionLease,
  type SessionKind,
} from "../session";
import { DEV_ADMIN_USERNAME, isDevPanelMode } from "../devPanel";
import { getActiveAuthSession, touchAuthSession } from "../repositories/sessionRepository";
import { withKeyedTaskLock } from "../keyedTaskLock";

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
  authFailureReason: "session_replaced" | "session_busy" | null;
}

type TokenSource = "cookie" | "bearer";

const MULTI_DEVICE_LOGIN_SETTING_CACHE_MS = 30 * 1000;
let allowMultiDeviceLoginCache: { value: boolean; loadedAt: number } = { value: false, loadedAt: 0 };

export function updateMultiDeviceLoginSettingCache(value: boolean) {
  allowMultiDeviceLoginCache = { value, loadedAt: Date.now() };
}

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
  const kind = normalizeSessionKind(data.kind, "browser");
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

async function claimSessionLease(user: User, sessionKind: SessionKind, sid: string) {
  const field = getSessionKindField(sessionKind);
  const initialLease = parseSessionLease(String((user as any)[field] || ""));
  if (isSessionLeaseOwnedByAnother(initialLease, sid)) return false;
  if (!shouldRefreshSessionLease(initialLease, sid)) return true;

  return withKeyedTaskLock(`auth-session-lease:${user.id}:${sessionKind}`, async () => {
    const latestUser = await db.getUserById(user.id);
    if (!latestUser) return false;
    const lease = parseSessionLease(String((latestUser as any)[field] || ""));
    if (isSessionLeaseOwnedByAnother(lease, sid)) return false;
    if (shouldRefreshSessionLease(lease, sid)) {
      await db.setUserSessionToken(user.id, sessionKind, encodeSessionLease(sid), { touchUserUpdatedAt: false });
    }
    return true;
  });
}

type ResolveSessionResult =
  | { user: User; authSession: AuthSession; failureReason?: never }
  | { user: null; authSession: null; failureReason: "session_replaced" | "session_busy" | null };

async function resolveSessionFromToken(req: Request, res: Response, token: string, source: TokenSource): Promise<ResolveSessionResult> {
  try {
    if (!ENV.cookieSecret) return { user: null, authSession: null, failureReason: null };
    const payload = jwt.verify(token, ENV.cookieSecret);
    const normalized = normalizeSessionPayload(req, payload);
    if (!normalized) return { user: null, authSession: null, failureReason: null };
    if (!normalized.sid) {
      if (source === "cookie") clearSessionCookie(res, req);
      return { user: null, authSession: null, failureReason: "session_replaced" };
    }

    const found = await db.getUserById(normalized.userId);
    if (!found) return { user: null, authSession: null, failureReason: null };

    const sessionKind = normalized.kind;
    const activeSession = await getActiveAuthSession(found.id, normalized.sid, sessionKind);
    if (!activeSession) {
      if (source === "cookie") clearSessionCookie(res, req);
      return {
        user: null,
        authSession: null,
        failureReason: "session_replaced",
      };
    }
    if (!(await allowMultiDeviceLogin()) && !(await claimSessionLease(found, sessionKind, normalized.sid))) {
      return {
        user: null,
        authSession: null,
        failureReason: "session_busy",
      };
    }
    await touchAuthSession(found.id, normalized.sid, sessionKind).catch((error) => {
      console.warn(`[Auth] session touch failed userId=${found.id} kind=${sessionKind}: ${error instanceof Error ? error.message : String(error)}`);
    });

    return {
      user: found,
      authSession: {
        kind: sessionKind,
        sid: normalized.sid,
        token,
        legacy: false,
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
