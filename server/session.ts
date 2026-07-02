export type SessionKind = "browser" | "mobile" | "telegram";

export const SESSION_ACTIVE_LEASE_TTL_MS = 120 * 1000;
export const SESSION_ACTIVE_LEASE_REFRESH_MS = 30 * 1000;

export const SESSION_KIND_FIELDS = {
  browser: "browserSessionToken",
  mobile: "mobileSessionToken",
  telegram: "telegramSessionToken",
} as const;

export function normalizeSessionKind(value: unknown, fallback: SessionKind = "browser"): SessionKind {
  const text = String(value || "").trim().toLowerCase();
  return text === "mobile" || text === "telegram" || text === "browser" ? text : fallback;
}

export function inferLegacySessionKind(req: { headers?: Record<string, any> }) {
  const mobileHeader = String(req?.headers?.["x-forwardx-mobile"] || "").trim().toLowerCase();
  return mobileHeader && mobileHeader !== "0" && mobileHeader !== "false" ? "mobile" : "browser";
}

export function resolveRequestedSessionKind(req: { headers?: Record<string, any> }, mobile?: boolean): SessionKind {
  if (mobile) return "mobile";
  const header = String(req?.headers?.["x-forwardx-mobile"] || "").trim().toLowerCase();
  return header && header !== "0" && header !== "false" ? "mobile" : "browser";
}

export function getSessionKindField(kind: SessionKind) {
  return SESSION_KIND_FIELDS[kind];
}

export interface SessionLease {
  sid: string;
  activeAt: number;
}

export function encodeSessionLease(sid: string, activeAt = Date.now()) {
  return JSON.stringify({ sid, activeAt });
}

export function parseSessionLease(value?: string | null): SessionLease | null {
  const text = String(value || "").trim();
  if (!text) return null;
  if (text.startsWith("{")) {
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      const sid = String(data.sid || "").trim();
      const activeAt = Number(data.activeAt || 0);
      if (sid) {
        return {
          sid,
          activeAt: Number.isFinite(activeAt) && activeAt > 0 ? activeAt : 0,
        };
      }
    } catch {
      // Fall through to legacy plain sid handling.
    }
  }
  return { sid: text, activeAt: 0 };
}

export function isSessionLeaseActive(lease: SessionLease | null, now = Date.now()) {
  return !!lease?.sid && lease.activeAt > 0 && now - lease.activeAt <= SESSION_ACTIVE_LEASE_TTL_MS;
}

export function shouldRefreshSessionLease(lease: SessionLease | null, sid: string, now = Date.now()) {
  return !lease || lease.sid !== sid || lease.activeAt <= 0 || now - lease.activeAt >= SESSION_ACTIVE_LEASE_REFRESH_MS;
}

export function stripSessionSensitiveFields<T extends Record<string, any>>(user: T | null | undefined) {
  if (!user) return user as T | null | undefined;
  const {
    password,
    twoFactorSecret,
    browserSessionToken,
    mobileSessionToken,
    telegramSessionToken,
    ...safeUser
  } = user as Record<string, any>;
  void password;
  void twoFactorSecret;
  void browserSessionToken;
  void mobileSessionToken;
  void telegramSessionToken;
  return safeUser as T;
}
