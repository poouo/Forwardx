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
import { getAuthSessionIdentity, revokeAuthSession, touchAuthSession } from "../repositories/sessionRepository";
import { withKeyedTaskLock } from "../keyedTaskLock";
import { TRPCError } from "@trpc/server";
import { databaseHealth, describeDatabaseError, isDatabaseBusyError } from "../databaseHealthState";
import { DATABASE_UNAVAILABLE_MESSAGE, SERVICE_BUSY_MESSAGE } from "../../shared/databaseHealth";
import { createRequestWorkPool } from "../requestWorkPool";

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
  authFailureReason: "session_replaced" | "account_disabled" | null;
}

type TokenSource = "cookie" | "bearer";

const MULTI_DEVICE_LOGIN_SETTING_CACHE_MS = 30 * 1000;
let allowMultiDeviceLoginCache: { value: boolean; loadedAt: number } = { value: false, loadedAt: 0 };
let multiDeviceLoginLoad: Promise<boolean> | undefined;
// Absorb short UI bursts in application memory, without putting every request
// into the driver's queue. A healthy DB must not lose reads to a tiny queue.
const authReads = createRequestWorkPool({ concurrency: 8, maxQueued: 256, queueTimeoutMs: 2000 });

export function updateMultiDeviceLoginSettingCache(value: boolean) {
  allowMultiDeviceLoginCache = { value, loadedAt: Date.now() };
  multiDeviceLoginLoad = undefined;
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
  if (!multiDeviceLoginLoad) {
    const currentCache = allowMultiDeviceLoginCache;
    const pending = db.getSetting("allowMultiDeviceLogin").then((setting) => {
      if (allowMultiDeviceLoginCache === currentCache) {
        allowMultiDeviceLoginCache = { value: setting === "true", loadedAt: Date.now() };
      }
      return allowMultiDeviceLoginCache.value;
    }).finally(() => { if (multiDeviceLoginLoad === pending) multiDeviceLoginLoad = undefined; });
    multiDeviceLoginLoad = pending;
  }
  return multiDeviceLoginLoad;
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
  | { user: null; authSession: null; failureReason: "session_replaced" | "account_disabled" | null };

async function resolveSessionFromToken(req: Request, res: Response, token: string, source: TokenSource): Promise<ResolveSessionResult> {
  if (!ENV.cookieSecret) return { user: null, authSession: null, failureReason: null };
  let payload: unknown;
  try {
    payload = jwt.verify(token, ENV.cookieSecret);
  } catch {
    // Only cryptographically invalid/expired tokens may be discarded here.
    if (source === "cookie") clearSessionCookie(res, req);
    return { user: null, authSession: null, failureReason: null };
  }
  try {
    const normalized = normalizeSessionPayload(req, payload);
    if (!normalized) return { user: null, authSession: null, failureReason: null };
    if (!normalized.sid) {
      if (source === "cookie") clearSessionCookie(res, req);
      return { user: null, authSession: null, failureReason: "session_replaced" };
    }

    const identity = await authReads.run(() => getAuthSessionIdentity(normalized.userId, normalized.sid!, normalized.kind));
    const found = identity?.user;
    if (!found) return { user: null, authSession: null, failureReason: null };

    // Account state is checked while resolving the token, before any public
    // procedure can inspect ctx.user. This invalidates an otherwise-active
    // cookie immediately after an administrator disables the account.
    if ((found as any).accountEnabled === false) {
      clearSessionCookie(res, req);
      return { user: null, authSession: null, failureReason: "account_disabled" };
    }

    const sessionKind = normalized.kind;
    const activeSession = identity?.session;
    if (!activeSession) {
      if (source === "cookie") clearSessionCookie(res, req);
      return {
        user: null,
        authSession: null,
        failureReason: "session_replaced",
      };
    }
    if (!(await allowMultiDeviceLogin()) && !(await claimSessionLease(found, sessionKind, normalized.sid))) {
      await revokeAuthSession(found.id, normalized.sid, sessionKind, "lease_replaced").catch((error) => {
        console.warn(`[Auth] conflicting session cleanup failed userId=${found.id} kind=${sessionKind}: ${error instanceof Error ? error.message : String(error)}`);
      });
      if (source === "cookie") clearSessionCookie(res, req);
      return {
        user: null,
        authSession: null,
        failureReason: "session_replaced",
      };
    }
    await touchAuthSession(found.id, normalized.sid, sessionKind, activeSession).catch((error) => {
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
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    if (isDatabaseBusyError(error)) {
      throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: SERVICE_BUSY_MESSAGE, cause: error });
    }
    if (describeDatabaseError(error) || databaseHealth.snapshot().state === "unavailable") {
      databaseHealth.unavailable(error);
      // A DB outage is not evidence that a cookie is invalid. Keep the session
      // for recovery, but never bypass account/session checks or grant access.
      throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: DATABASE_UNAVAILABLE_MESSAGE });
    }
    // Unknown database/service errors are not an authentication decision either.
    // Fail closed, but keep credentials so recovery needs no fresh login.
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "登录验证暂时失败，请稍后重试", cause: error });
  }
}

export async function createContext({ req, res }: CreateExpressContextOptions): Promise<TrpcContext> {
  if (databaseHealth.snapshot().state === "unavailable") {
    throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: DATABASE_UNAVAILABLE_MESSAGE });
  }
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
