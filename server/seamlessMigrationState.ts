import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";
import { timingSafeEqual } from "node:crypto";
import { ENV } from "./env";

export type SeamlessMigrationState = {
  version: 1;
  id: string;
  role: "source" | "target";
  phase: "frozen" | "verifying" | "forwarding" | "active" | "archived";
  sourceUrl: string;
  targetUrl: string;
  tokenHash: string;
  startedAt: number;
  expiresAt: number;
  jobId?: string;
  job?: { id: string; status: "pending" | "running" | "success" | "failed"; progress: number; step: string; startedAt: number; finishedAt?: number; error?: string; message?: string };
  takeoverToken?: string; // target-only, persisted privately for restart recovery
  imported?: boolean;
  requiredHosts?: number[];
  requiredRules?: number[];
  requiredTunnels?: number[];
};

const statePath = process.env.FORWARDX_SEAMLESS_MIGRATION_STATE_PATH
  || path.join(path.dirname(ENV.databaseConfigPath || ENV.sqlitePath), "seamless-migration.json");
const admission = new AsyncLocalStorage<{ internal: boolean; active: boolean }>();
let state: SeamlessMigrationState | null = null;
let activities = 0;
let databaseOperations = 0;
try {
  const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
  if (parsed.version !== 1 || !parsed.id || !/^[a-f0-9]{64}$/.test(parsed.tokenHash) || !Number.isFinite(parsed.expiresAt) || !["source", "target"].includes(parsed.role)
    || !["frozen", "verifying", "forwarding", "active", "archived"].includes(parsed.phase)
    || !/^https?:\/\//.test(parsed.sourceUrl) || !/^https?:\/\//.test(parsed.targetUrl)) throw new Error("invalid state");
  state = parsed;
} catch (error: any) {
  if (error.code !== "ENOENT") throw new Error(`Cannot load seamless migration state: ${error.message}`);
}

export function getSeamlessMigrationState() { return state; }

// Only an uncommitted source freeze may expire. Never reactivate an archived
// database: the target may already have accepted payments/traffic reports.
export function expireSeamlessFreeze(now = Date.now()) {
  if (state?.role === "source" && state.phase === "frozen" && state.expiresAt <= now) {
    persistSeamlessMigrationState(null);
    void import("./backgroundServices").then(({ startBackgroundServices }) => startBackgroundServices()).catch((error) => console.warn("[Migration] Could not resume background services:", error instanceof Error ? error.message : String(error)));
    console.warn("[Migration] Uncommitted migration freeze expired; original panel resumed");
    return true;
  }
  return false;
}
let expiryErrorLoggedAt = 0;
const expiryTimer = setInterval(() => {
  try { expireSeamlessFreeze(); }
  catch (error) {
    if (Date.now() - expiryErrorLoggedAt > 60_000) {
      expiryErrorLoggedAt = Date.now();
      console.warn("[Migration] Freeze recovery failed; retained read-only state:", error instanceof Error ? error.message : String(error));
    }
  }
}, 10_000);
expiryTimer.unref();

export function persistSeamlessMigrationState(next: SeamlessMigrationState | null) {
  if (next) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const temp = `${statePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(temp, statePath);
  } else {
    fs.rmSync(statePath, { force: true });
  }
  state = next;
}

export function seamlessSourcePaused() {
  return state?.role === "source";
}

export function seamlessBackgroundPaused() {
  return seamlessSourcePaused() || state?.phase === "verifying";
}

export function seamlessInternal<T>(work: () => T): T {
  return admission.run({ internal: true, active: true }, work);
}

export async function seamlessActivity<T>(work: () => Promise<T>): Promise<T> {
  if (seamlessBackgroundPaused()) throw new Error("面板迁移中，后台写入已暂停");
  const scope = { internal: false, active: true };
  activities++;
  try { return await admission.run(scope, work); }
  finally { scope.active = false; activities--; }
}

export function assertSeamlessDatabaseWrite(sql: string) {
  const scope = admission.getStore();
  if (!seamlessBackgroundPaused() || (scope?.active && scope.internal)) return;
  // No writes from a retired panel, including WITH ... INSERT/UPDATE, DDL,
  // transaction commands and driver's prepared DML. Only plain reads survive.
  const text = sql.replace(/^\s*(?:\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*)*/, "");
  if (/^(SELECT\b|SHOW\b|EXPLAIN\s+SELECT\b)/i.test(text) && !/\bFOR\s+UPDATE\b|\bINTO\s+(?:OUTFILE|DUMPFILE)\b|;\s*\S/i.test(text)) return;
  if (scope?.active && (state?.phase === "frozen" || state?.role === "target")) return; // finish admitted work / accept target Agent reports
  const error = new Error("旧面板已暂停写入并保留数据，请在新面板操作") as Error & { code: string };
  error.code = "PANEL_MIGRATION_READ_ONLY";
  throw error;
}

export async function seamlessDatabaseOperation<T>(sql: string, work: () => Promise<T> | T): Promise<T> {
  assertSeamlessDatabaseWrite(sql);
  databaseOperations++;
  try { return await work(); }
  finally { databaseOperations--; }
}

export async function drainSeamlessActivities(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (activities || databaseOperations) {
    if (Date.now() >= deadline) throw new Error("旧面板仍有正在执行的任务，已停止迁移；请稍后重试");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export const seamlessAdmissionMiddleware: RequestHandler = (req, res, next) => {
  if (!req.path.startsWith("/api/") || req.path.startsWith("/api/migration/") || req.path === "/api/database-health") return next();
  const verificationProcedures = new Set(["setup.migrationStatus", "setup.status", "auth.me", "auth.login", "auth.verifyTwoFactorLogin", "auth.createCaptcha", "auth.needsCaptcha", "auth.emailConfig", "system.resumeSeamlessMigration", "system.publicInfo", "system.getSettings", "plugins.live2dWidget"]);
  const verificationApi = (req.path.startsWith("/api/trpc/") && req.path.slice(10).split(",").every((name) => verificationProcedures.has(name))) || req.path.startsWith("/api/auth/cap/login/");
  const incomingRelay = String(req.headers["x-forwardx-migration-relay"] || "");
  const trustedRelay = !!state && /^[a-f0-9]{64}$/.test(incomingRelay)
    && timingSafeEqual(Buffer.from(incomingRelay), Buffer.from(state.tokenHash));
  const verificationAgent = trustedRelay && (req.path.startsWith("/api/agent/") || ["/api/sync", "/api/stream"].includes(req.path) || req.path.startsWith("/api/payment/"));
  const cancelFrozenSource = state?.role === "source" && state.phase === "frozen" && req.method === "POST" && req.path === "/api/trpc/system.cancelSeamlessSourceMigration";
  if ((seamlessSourcePaused() && !cancelFrozenSource) || (state?.role === "target" && state.phase === "verifying" && !verificationApi && !verificationAgent)) {
    res.setHeader("Retry-After", "5");
    res.status(503).json({ error: "面板迁移中，旧数据保留且转发继续运行，请稍后在新面板操作", panelUrl: state?.targetUrl });
    return;
  }
  if (req.path === "/api/stream") return next(); // don't wait for long-lived SSE to finish
  const scope = { internal: false, active: true };
  activities++;
  let released = false;
  const release = () => { if (!released) { released = true; scope.active = false; activities--; } };
  res.once("finish", release);
  res.once("close", release);
  admission.run(scope, next);
};
