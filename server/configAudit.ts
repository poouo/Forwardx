import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, ne } from "drizzle-orm";
import { configAuditEvents } from "../drizzle/schema";
import { getDb, insertAndGetId } from "./dbRuntime";

export type ConfigAuditContext = {
  actorUserId?: number | null;
  actorName?: string | null;
  source: string;
  requestId?: string | null;
  requestPath?: string | null;
};

type AuditResourceType = "host" | "tunnel" | "forward_rule" | "runtime";
type AuditAction = "create" | "update" | "delete" | "dispatch";

const auditContext = new AsyncLocalStorage<ConfigAuditContext>();
const SECRET_KEY = /(password|passwd|secret|token|private.?key|certificate|authorization|cookie|credential)/i;
const VOLATILE_KEYS = new Set([
  "createdAt", "updatedAt", "lastHeartbeat", "isOnline", "isRunning", "lastLatencyMs",
  "lastTestAt", "lastTestStatus", "lastTestMessage", "lastError", "trafficUsed",
  "lastDdnsValue", "lastDdnsAt", "lastDdnsError", "geoUpdatedAt", "mimicCheckedAt",
  "mimicMessage", "mimicStatus", "mimicRuntimeStatus", "mimicRuntimeMessage",
  "mimicRuntimeCheckedAt", "agentRecoveryStartedAt", "agentRecoveryCompletedAt",
  "agentRecoveryExpected", "agentRecoveryReady", "agentLastReceivedRevision",
  "agentLastAppliedRevision", "agentLastReceivedHash", "agentLastAppliedHash",
]);

type SecretMode = "redact" | "hash" | "plain";

function normalize(value: any, omitVolatile = false, secretMode: SecretMode = "redact"): any {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => normalize(item, omitVolatile, secretMode));
  if (typeof value !== "object") return value;
  const result: Record<string, any> = {};
  for (const key of Object.keys(value).sort()) {
    if (omitVolatile && VOLATILE_KEYS.has(key)) continue;
    if (SECRET_KEY.test(key) && secretMode !== "plain") {
      result[key] = secretMode === "redact"
        ? "[REDACTED]"
        : `sha256:${createHash("sha256").update(JSON.stringify(normalize(value[key], false, "plain")) ?? "null").digest("hex")}`;
    } else {
      result[key] = normalize(value[key], omitVolatile, secretMode);
    }
  }
  return result;
}

function stableJson(value: any) {
  return JSON.stringify(normalize(value));
}

export function hashConfig(value: any) {
  return createHash("sha256").update(JSON.stringify(normalize(value, true, "hash"))).digest("hex");
}

export function shouldAuditConfigPatch(value: Record<string, any> | null | undefined) {
  return !!value && Object.keys(value).some((key) => !VOLATILE_KEYS.has(key));
}

function buildDiff(before: any, after: any) {
  const left = normalize(before || {}, true, "plain") as Record<string, any>;
  const right = normalize(after || {}, true, "plain") as Record<string, any>;
  const diff: Record<string, { before: any; after: any }> = {};
  for (const key of Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort()) {
    const leftComparable = normalize({ [key]: left[key] }, false, "hash");
    const rightComparable = normalize({ [key]: right[key] }, false, "hash");
    if (JSON.stringify(leftComparable) !== JSON.stringify(rightComparable)) {
      diff[key] = {
        before: normalize({ [key]: left[key] }, false, "redact")[key] ?? null,
        after: normalize({ [key]: right[key] }, false, "redact")[key] ?? null,
      };
    }
  }
  return diff;
}

export function runWithConfigAuditContext<T>(context: Partial<ConfigAuditContext>, callback: () => T): T {
  return auditContext.run({
    source: context.source || "system",
    actorUserId: context.actorUserId || null,
    actorName: context.actorName || null,
    requestId: context.requestId || randomUUID(),
    requestPath: context.requestPath || null,
  }, callback);
}

export function currentConfigAuditContext() {
  return auditContext.getStore();
}

export async function recordConfigAuditEvent(input: {
  resourceType: AuditResourceType;
  resourceId: number;
  hostId?: number | null;
  action: AuditAction;
  before?: any;
  after?: any;
  source?: string;
}) {
  const resourceId = Math.floor(Number(input.resourceId || 0));
  if (resourceId <= 0) return 0;
  const before = normalize(input.before ?? null, true, "redact");
  const after = normalize(input.after ?? null, true, "redact");
  const diff = buildDiff(input.before, input.after);
  if (input.action === "update" && Object.keys(diff).length === 0) return 0;
  const context = currentConfigAuditContext();
  try {
    return await insertAndGetId("config_audit_events", {
      resourceType: input.resourceType,
      resourceId,
      hostId: Number(input.hostId || 0) > 0 ? Number(input.hostId) : null,
      action: input.action,
      source: input.source || context?.source || "system",
      actorUserId: context?.actorUserId || null,
      actorName: context?.actorName || null,
      requestId: context?.requestId || null,
      requestPath: context?.requestPath || null,
      beforeJson: input.before === undefined ? null : stableJson(before),
      afterJson: input.after === undefined ? null : stableJson(after),
      diffJson: stableJson(diff),
      configHash: hashConfig(input.after),
    });
  } catch (error) {
    console.warn(`[ConfigAudit] write failed resource=${input.resourceType}:${resourceId}: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}

export async function latestConfigRevision() {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db.select({ id: configAuditEvents.id }).from(configAuditEvents)
    .where(ne(configAuditEvents.action, "dispatch" as any)).orderBy(desc(configAuditEvents.id)).limit(1);
  return Number(rows[0]?.id || 0);
}

export async function listRecentConfigAuditEvents(limit = 500) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(configAuditEvents).orderBy(desc(configAuditEvents.id)).limit(Math.min(2000, Math.max(1, limit)));
}

export async function getResourceConfigRevision(resourceType: string, resourceId: number) {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db.select({ id: configAuditEvents.id }).from(configAuditEvents)
    .where(and(eq(configAuditEvents.resourceType, resourceType as any), eq(configAuditEvents.resourceId, resourceId)))
    .orderBy(desc(configAuditEvents.id)).limit(1);
  return Number(rows[0]?.id || 0);
}
