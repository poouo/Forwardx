export type SessionKind = "browser" | "mobile" | "telegram";

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
