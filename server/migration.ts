import { Request, Response, Router } from "express";
import nodeCrypto from "crypto";
import { MIGRATION_TABLES, ensureDatabaseSchema } from "./dbSchema";
import { connectDatabase, executeRaw, getDatabaseKind, insertAndGetId, nowDate, queryRaw } from "./dbRuntime";
import { countAll, quoteIdentifier } from "./dbCompat";
import { getAllSettings, setSetting } from "./repositories/settingsRepository";
import { clearHostAgentUpgradeRequest, getHosts, HOST_ONLINE_TTL_MS, requestHostAgentUpgrade } from "./db";
import { pushAgentPanelMigration, pushAgentUpgrade } from "./agentEvents";
import { assertSafeOutboundUrl } from "./ssrf";
import { maintainCurrentPostgresqlDatabase } from "./postgresqlMaintenance";
import { maintainCurrentMysqlDatabase } from "./mysqlMaintenance";
import { AGENT_VERSION, APP_VERSION } from "../shared/versions";
import { ensureTrafficStatBucketsBackfilled, ensureUserTrafficCountersBackfilled } from "./repositories/metricsRepository";
import {
  abortTakeoverToken,
  consumeApprovedMigrationRequest,
  consumeTakeoverToken,
  createMigrationRequest,
  getMigrationRequest,
  prepareTakeoverToken,
  validatePreparedTakeoverToken,
} from "./migrationCodes";
import {
  invalidatePanelMigrationAgentStateCache,
  setPanelMigrationAgentDirective,
} from "./panelMigrationAgentState";
import { markLocalSetupComplete } from "./setupState";
import { startBackgroundServices } from "./backgroundServices";

export type MigrationJobStatus = "pending" | "running" | "success" | "failed";

export interface MigrationSnapshot {
  version: 1;
  exportedAt: number;
  appVersion?: string;
  sourcePanelUrl?: string;
  takeoverToken?: string;
  tables: Record<string, Record<string, any>[]>;
}

export interface MigrationSnapshotSummary {
  exportedAt: number;
  sourcePanelUrl?: string;
  appVersion?: string;
  userCount: number;
  hostCount: number;
  ruleCount: number;
  tunnelCount: number;
  forwardGroupCount: number;
  tableCounts: Record<string, number>;
}

export interface MigrationImportResult {
  success: true;
  mode: "restore" | "incremental";
  summary: MigrationSnapshotSummary;
  existingData: {
    hasExistingData: boolean;
    businessDataCount: number;
    userCount: number;
    hostCount: number;
    ruleCount: number;
    tunnelCount: number;
    forwardGroupCount: number;
  };
  inserted: Record<string, number>;
  updated: Record<string, number>;
  reused: Record<string, number>;
  skipped: Record<string, number>;
  hostCount: number;
  panelUrl?: string;
}

export interface MigrationImportedIds {
  hosts: Record<number, number>;
  tunnels: Record<number, number>;
  forwardRules: Record<number, number>;
}

export interface EncryptedPanelBackup {
  format: "forwardx-panel-backup";
  version: 1;
  encrypted: true;
  exportedAt: number;
  appVersion: string;
  cipher: "aes-256-gcm";
  kdf: {
    name: "scrypt";
    salt: string;
    keyLength: 32;
    cost: number;
    blockSize: number;
    parallelization: number;
  };
  iv: string;
  tag: string;
  data: string;
}

export interface MigrationJob {
  id: string;
  status: MigrationJobStatus;
  progress: number;
  step: string;
  message?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

const jobs = new Map<string, MigrationJob>();
const migrationJobProbeTokens = new Map<string, string>();

const configuredMigrationRuntimeTimeoutMs = Number(process.env.FORWARDX_MIGRATION_RUNTIME_TIMEOUT_MS);
const MIGRATION_RUNTIME_TIMEOUT_MS = Math.max(
  60_000,
  Number.isFinite(configuredMigrationRuntimeTimeoutMs) && configuredMigrationRuntimeTimeoutMs > 0
    ? configuredMigrationRuntimeTimeoutMs
    : 15 * 60 * 1000,
);
const MIGRATION_RUNTIME_POLL_MS = 2_000;

function normalizePanelUrl(url: string) {
  const value = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value)) return `http://${value}`;
  return value;
}

function setJob(job: MigrationJob, patch: Partial<MigrationJob>) {
  Object.assign(job, patch);
  jobs.set(job.id, job);
}

export function getMigrationJob(id: string) {
  return jobs.get(id) || null;
}

export async function exportMigrationSnapshot(sourcePanelUrl?: string): Promise<MigrationSnapshot> {
  await connectDatabase();
  await ensureDatabaseSchema();
  const tables: MigrationSnapshot["tables"] = {};
  for (const table of MIGRATION_TABLES) {
    tables[table] = await queryRaw(`SELECT * FROM ${quote(table)}`);
  }
  return { version: 1, exportedAt: Date.now(), appVersion: APP_VERSION, sourcePanelUrl, tables };
}

type MigrationTableName = (typeof MIGRATION_TABLES)[number];

const PANEL_BACKUP_OMITTED_TABLES = new Set<MigrationTableName>([
  "host_metrics",
  "host_probe_service_stats",
  "tunnel_latency_stats",
  "forward_group_latency_stats",
  "traffic_stats",
  "tcping_stats",
  "forward_tests",
  "forward_group_events",
  "ip_geo_cache",
]);

export function pruneMigrationSnapshotForPanelBackup(snapshot: MigrationSnapshot): MigrationSnapshot {
  const tables: MigrationSnapshot["tables"] = {};
  for (const table of MIGRATION_TABLES) {
    if (PANEL_BACKUP_OMITTED_TABLES.has(table)) continue;
    const rows = snapshot.tables?.[table];
    if (Array.isArray(rows) && rows.length > 0) tables[table] = rows;
  }
  return { ...snapshot, tables };
}

function quote(name: string) {
  return quoteIdentifier(name);
}

function normalizeValue(value: any) {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === "boolean" && getDatabaseKind() !== "postgresql") return value ? 1 : 0;
  return value;
}

function compact<T extends Record<string, any>>(obj: T): T {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

function toNumberId(value: unknown) {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function mapId(maps: ImportMaps, table: string, value: unknown) {
  const id = toNumberId(value);
  if (!id) return null;
  return maps[table]?.get(id) ?? null;
}

function mapOptionalId(maps: ImportMaps, table: string, value: unknown) {
  if (value === null || value === undefined || value === "" || value === 0 || value === "0") return null;
  return mapRequiredId(maps, table, value);
}

function mapRequiredId(maps: ImportMaps, table: string, value: unknown) {
  const mapped = mapId(maps, table, value);
  if (!mapped) throw new Error(`依赖数据缺失：${table}#${value}`);
  return mapped;
}

function incrementCounter(target: Record<string, number>, table: string) {
  target[table] = (target[table] || 0) + 1;
}

const PANEL_DATA_SUMMARY_CACHE_TTL_MS = 10_000;
const PANEL_DATA_SUMMARY_TABLES = ["users", "hosts", "forward_rules", "tunnels", "forward_groups"] as const;
const PANEL_DATA_EXTRA_BUSINESS_TABLES = MIGRATION_TABLES.filter(
  (table) => table !== "system_settings" && !(PANEL_DATA_SUMMARY_TABLES as readonly string[]).includes(table),
);

let panelDataSummaryCache: { kind: string | null; expiresAt: number; data: any } | null = null;

export function invalidatePanelDataSummaryCache() {
  panelDataSummaryCache = null;
}

async function getTableCount(table: string) {
  const rows = await queryRaw<{ count: number }>(`SELECT ${countAll()} FROM ${quote(table)}`).catch(() => []);
  return Number(rows[0]?.count || 0);
}

async function getPanelCoreCounts() {
  const [row] = await queryRaw<{
    user_count: number | string;
    host_count: number | string;
    rule_count: number | string;
    tunnel_count: number | string;
    forward_group_count: number | string;
  }>(
    `SELECT
      (SELECT COUNT(*) FROM ${quote("users")}) AS user_count,
      (SELECT COUNT(*) FROM ${quote("hosts")}) AS host_count,
      (SELECT COUNT(*) FROM ${quote("forward_rules")}) AS rule_count,
      (SELECT COUNT(*) FROM ${quote("tunnels")}) AS tunnel_count,
      (SELECT COUNT(*) FROM ${quote("forward_groups")}) AS forward_group_count`,
  );
  return {
    userCount: Number(row?.user_count || 0),
    hostCount: Number(row?.host_count || 0),
    ruleCount: Number(row?.rule_count || 0),
    tunnelCount: Number(row?.tunnel_count || 0),
    forwardGroupCount: Number(row?.forward_group_count || 0),
  };
}

async function hasAnyRows(table: string) {
  const rows = await queryRaw(`SELECT 1 AS present FROM ${quote(table)} LIMIT 1`).catch(() => []);
  return rows.length > 0;
}

async function hasExtraBusinessData() {
  if (PANEL_DATA_EXTRA_BUSINESS_TABLES.length === 0) return false;
  const sql = PANEL_DATA_EXTRA_BUSINESS_TABLES
    .map((table) => `SELECT '${table}' AS table_name, CASE WHEN EXISTS (SELECT 1 FROM ${quote(table)} LIMIT 1) THEN 1 ELSE 0 END AS has_rows`)
    .join(" UNION ALL ");
  const rows = await queryRaw<{ table_name: string; has_rows: number | string | boolean }>(sql).catch(() => []);
  if (rows.length > 0) {
    return rows.some((row) => row.has_rows === true || Number(row.has_rows || 0) > 0);
  }
  const flags = await Promise.all(PANEL_DATA_EXTRA_BUSINESS_TABLES.map((table) => hasAnyRows(table)));
  return flags.some(Boolean);
}

export async function getPanelDataSummary(options: { useCache?: boolean } = {}) {
  await connectDatabase();
  await ensureDatabaseSchema();
  const useCache = options.useCache !== false;
  const cacheKind = getDatabaseKind();
  const now = Date.now();
  if (useCache && panelDataSummaryCache && panelDataSummaryCache.kind === cacheKind && panelDataSummaryCache.expiresAt > now) {
    return panelDataSummaryCache.data;
  }

  const coreCounts = await getPanelCoreCounts().catch(async () => ({
    userCount: await getTableCount("users"),
    hostCount: await getTableCount("hosts"),
    ruleCount: await getTableCount("forward_rules"),
    tunnelCount: await getTableCount("tunnels"),
    forwardGroupCount: await getTableCount("forward_groups"),
  }));
  const { userCount, hostCount, ruleCount, tunnelCount, forwardGroupCount } = coreCounts;
  const coreBusinessDataCount = Math.max(0, userCount - 1) + hostCount + ruleCount + tunnelCount + forwardGroupCount;
  const extraBusinessData = coreBusinessDataCount > 0 ? false : await hasExtraBusinessData();
  const businessDataCount = coreBusinessDataCount + (extraBusinessData ? 1 : 0);
  const counts: Record<string, number> = Object.fromEntries(MIGRATION_TABLES.map((table) => [table, 0]));
  counts.users = userCount;
  counts.hosts = hostCount;
  counts.forward_rules = ruleCount;
  counts.tunnels = tunnelCount;
  counts.forward_groups = forwardGroupCount;

  const data = {
    hasExistingData: businessDataCount > 0,
    businessDataCount,
    userCount,
    hostCount,
    ruleCount,
    tunnelCount,
    forwardGroupCount,
    tableCounts: counts,
  };
  if (useCache) {
    panelDataSummaryCache = { kind: cacheKind, expiresAt: now + PANEL_DATA_SUMMARY_CACHE_TTL_MS, data };
  }
  return data;
}

export function summarizeMigrationSnapshot(snapshot: MigrationSnapshot): MigrationSnapshotSummary {
  const tableCounts: Record<string, number> = {};
  for (const table of MIGRATION_TABLES) {
    tableCounts[table] = Array.isArray(snapshot.tables?.[table]) ? snapshot.tables[table].length : 0;
  }
  return {
    exportedAt: snapshot.exportedAt || Date.now(),
    sourcePanelUrl: snapshot.sourcePanelUrl,
    appVersion: snapshot.appVersion,
    userCount: tableCounts.users || 0,
    hostCount: tableCounts.hosts || 0,
    ruleCount: tableCounts.forward_rules || 0,
    tunnelCount: tableCounts.tunnels || 0,
    forwardGroupCount: tableCounts.forward_groups || 0,
    tableCounts,
  };
}

const BACKUP_FORMAT = "forwardx-panel-backup" as const;
const BACKUP_CIPHER = "aes-256-gcm" as const;
const BACKUP_KDF = { name: "scrypt" as const, keyLength: 32 as const, cost: 16384, blockSize: 8, parallelization: 1 };

function deriveBackupKey(password: string, salt: Buffer) {
  return nodeCrypto.scryptSync(password, salt, BACKUP_KDF.keyLength, {
    N: BACKUP_KDF.cost,
    r: BACKUP_KDF.blockSize,
    p: BACKUP_KDF.parallelization,
  });
}

export function encryptMigrationSnapshot(snapshot: MigrationSnapshot, password: string): EncryptedPanelBackup {
  const trimmedPassword = String(password || "");
  if (trimmedPassword.length < 8) throw new Error("备份密码至少需要 8 位");
  const salt = nodeCrypto.randomBytes(16);
  const iv = nodeCrypto.randomBytes(12);
  const key = deriveBackupKey(trimmedPassword, salt);
  const cipher = nodeCrypto.createCipheriv(BACKUP_CIPHER, key, iv);
  const payload = Buffer.from(JSON.stringify(snapshot), "utf8");
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    format: BACKUP_FORMAT,
    version: 1,
    encrypted: true,
    exportedAt: snapshot.exportedAt || Date.now(),
    appVersion: APP_VERSION,
    cipher: BACKUP_CIPHER,
    kdf: {
      ...BACKUP_KDF,
      salt: salt.toString("base64"),
    },
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  };
}

export function decryptMigrationSnapshotBackup(rawContent: string, password: string): MigrationSnapshot {
  let backup: EncryptedPanelBackup;
  try {
    backup = JSON.parse(rawContent);
  } catch {
    throw new Error("备份文件格式无效，无法解析 JSON");
  }
  if (backup?.format !== BACKUP_FORMAT || backup.version !== 1 || !backup.encrypted) {
    throw new Error("备份文件格式无效或版本不受支持");
  }
  if (backup.cipher !== BACKUP_CIPHER || backup.kdf?.name !== "scrypt") {
    throw new Error("备份文件加密方式不受支持");
  }
  try {
    const key = deriveBackupKey(String(password || ""), Buffer.from(backup.kdf.salt, "base64"));
    const decipher = nodeCrypto.createDecipheriv(BACKUP_CIPHER, key, Buffer.from(backup.iv, "base64"));
    decipher.setAuthTag(Buffer.from(backup.tag, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(backup.data, "base64")),
      decipher.final(),
    ]);
    const snapshot = JSON.parse(decrypted.toString("utf8")) as MigrationSnapshot;
    if (!snapshot || snapshot.version !== 1 || !snapshot.tables || typeof snapshot.tables !== "object") {
      throw new Error("备份内容无效");
    }
    return snapshot;
  } catch (error) {
    if (error instanceof Error && error.message === "备份内容无效") throw error;
    throw new Error("备份密码错误或备份文件已损坏");
  }
}

type ImportMaps = Record<string, Map<number, number>>;
type PreparedImportRow = {
  row: Record<string, any>;
  existingWhere?: Record<string, any>;
};

const IMPORT_TABLE_ORDER = [
  "users",
  "hosts",
  "host_groups",
  "host_group_members",
  "tunnels",
  "tunnel_exit_nodes",
  "forward_groups",
  "forward_group_members",
  "forward_rules",
  "forward_rule_tunnel_exits",
  "tunnel_hops",
  "agent_tokens",
  "user_host_permissions",
  "user_tunnel_permissions",
  "user_forward_group_permissions",
  "host_probe_services",
  "host_metrics",
  "host_probe_service_stats",
  "host_traffic_counters",
  "user_traffic_counters",
  "forward_rule_traffic_counters",
  "tunnel_latency_stats",
  "forward_group_latency_stats",
  "traffic_stats",
  "tcping_stats",
  "forward_tests",
  "forward_group_events",
  "ip_geo_cache",
  "subscription_plans",
  "subscription_plan_hosts",
  "subscription_plan_tunnels",
  "subscription_plan_forward_groups",
  "subscription_plan_traffic_addons",
  "discount_codes",
  "discount_code_plans",
  "redemption_codes",
  "user_subscriptions",
  "user_traffic_addons",
  "payment_orders",
  "balance_transactions",
  "traffic_billing_configs",
  "traffic_billing_usage",
  "traffic_billing_rule_usage",
  "traffic_billing_records",
  "user_traffic_billing_permissions",
  "announcements",
  "announcement_reads",
  "plugins",
  "plugin_store_sources",
  "plugin_assets",
  "plugin_agent_states",
  "system_settings",
] as const;

const BEST_EFFORT_MIGRATION_TABLES = new Set<MigrationTableName>([
  "host_metrics",
  "host_probe_service_stats",
  "host_traffic_counters",
  "user_traffic_counters",
  "forward_rule_traffic_counters",
  "traffic_stats",
  "tunnel_latency_stats",
  "forward_group_latency_stats",
  "ip_geo_cache",
  "tcping_stats",
  "forward_tests",
  "forward_group_events",
  "system_settings",
]);

const missingImportTables = MIGRATION_TABLES.filter(
  (table) => !(IMPORT_TABLE_ORDER as readonly string[]).includes(table),
);
if (missingImportTables.length > 0) {
  throw new Error(`Migration import order is incomplete: ${missingImportTables.join(", ")}`);
}

function sortedSnapshotRows(snapshot: MigrationSnapshot, table: string) {
  return [...(snapshot.tables?.[table] || [])].sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
}

async function findExistingRow(table: string, where: Record<string, any>) {
  const entries = Object.entries(where).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (entries.length === 0) return null;
  const conditions = entries.map(([key]) => `${quote(key)} = ?`).join(" AND ");
  const rows = await queryRaw<Record<string, any>>(
    `SELECT * FROM ${quote(table)} WHERE ${conditions} LIMIT 1`,
    entries.map(([, value]) => normalizeValue(value)),
  ).catch(() => []);
  return rows[0] || null;
}

async function findExistingId(table: string, where: Record<string, any>) {
  const row = await findExistingRow(table, where);
  const id = toNumberId(row?.id);
  return id || null;
}

async function insertOrReuseSystemSetting(row: Record<string, any>, mode: "restore" | "incremental") {
  const key = String(row.key || "");
  if (!key) return "skipped" as const;
  const existing = await findExistingRow("system_settings", { key });
  if (existing) {
    if (mode === "restore") {
      await setSetting(key, row.value ?? null);
      return "updated" as const;
    }
    return "reused" as const;
  }
  await setSetting(key, row.value ?? null);
  return "inserted" as const;
}

async function insertImportRow(table: string, row: Record<string, any>) {
  const payload = compact(row);
  delete payload.id;
  return insertAndGetId(table, payload);
}

async function sanitizeUserUniqueFields(row: Record<string, any>) {
  for (const key of ["telegramId", "telegramBindCode", "telegramLoginCode"]) {
    if (!row[key]) continue;
    const existing = await findExistingId("users", { [key]: row[key] });
    if (existing) {
      row[key] = null;
      if (key === "telegramBindCode") row.telegramBindCodeExpiresAt = null;
      if (key === "telegramLoginCode") row.telegramLoginCodeExpiresAt = null;
    }
  }
}

function mappedResourceId(maps: ImportMaps, resourceType: unknown, resourceId: unknown) {
  const type = String(resourceType || "");
  if (type === "host") return mapRequiredId(maps, "hosts", resourceId);
  if (type === "tunnel") return mapRequiredId(maps, "tunnels", resourceId);
  if (type === "forward_group") return mapRequiredId(maps, "forward_groups", resourceId);
  return toNumberId(resourceId);
}

function mapStoredHostIds(maps: ImportMaps, value: unknown) {
  if (value === null || value === undefined || value === "") return value;
  let parsed: unknown[];
  if (Array.isArray(value)) {
    parsed = value;
  } else {
    const raw = String(value).trim();
    if (raw.startsWith("[")) {
      try {
        const json = JSON.parse(raw);
        if (!Array.isArray(json)) throw new Error("invalid host list");
        parsed = json;
      } catch {
        throw new Error("主机范围格式无效");
      }
    } else {
      parsed = raw.split(",").map((item) => item.trim()).filter(Boolean);
    }
  }
  const mapped = Array.from(new Set(parsed.map((hostId) => mapRequiredId(maps, "hosts", hostId))));
  return mapped.length > 0 ? mapped.sort((a, b) => a - b).join(",") : null;
}

async function prepareImportRow(table: string, source: Record<string, any>, maps: ImportMaps): Promise<PreparedImportRow | null> {
  const row = { ...source };
  delete row.id;

  switch (table) {
    case "users":
      if (!row.username) return null;
      await sanitizeUserUniqueFields(row);
      return { row, existingWhere: { username: row.username } };

    case "hosts":
      row.userId = mapRequiredId(maps, "users", source.userId);
      row.isOnline = false;
      row.lastHeartbeat = null;
      row.agentUpgradeRequested = false;
      row.agentUpgradeTargetVersion = null;
      row.agentUpgradeReleaseVersion = null;
      row.agentUpgradeRequestedAt = null;
      return { row, existingWhere: row.agentToken ? { agentToken: row.agentToken } : undefined };

    case "host_groups":
      row.userId = mapRequiredId(maps, "users", source.userId);
      return { row };

    case "host_group_members":
      row.groupId = mapRequiredId(maps, "host_groups", source.groupId);
      row.hostId = mapRequiredId(maps, "hosts", source.hostId);
      return { row, existingWhere: { groupId: row.groupId, hostId: row.hostId } };

    case "tunnels":
      row.entryHostId = mapRequiredId(maps, "hosts", source.entryHostId);
      row.exitHostId = mapRequiredId(maps, "hosts", source.exitHostId);
      row.userId = mapRequiredId(maps, "users", source.userId);
      row.isRunning = false;
      return { row };

    case "tunnel_hops":
      row.tunnelId = mapRequiredId(maps, "tunnels", source.tunnelId);
      row.hostId = mapRequiredId(maps, "hosts", source.hostId);
      return { row, existingWhere: { tunnelId: row.tunnelId, seq: row.seq } };

    case "tunnel_exit_nodes":
      row.tunnelId = mapRequiredId(maps, "tunnels", source.tunnelId);
      row.hostId = mapRequiredId(maps, "hosts", source.hostId);
      return { row, existingWhere: { tunnelId: row.tunnelId, seq: row.seq } };

    case "forward_groups":
      row.userId = mapRequiredId(maps, "users", source.userId);
      row.activeMemberId = null;
      return { row };

    case "forward_group_members":
      row.groupId = mapRequiredId(maps, "forward_groups", source.groupId);
      row.hostId = mapOptionalId(maps, "hosts", source.hostId);
      row.tunnelId = mapOptionalId(maps, "tunnels", source.tunnelId);
      row.ruleId = null;
      return { row };

    case "forward_rules":
      row.hostId = mapRequiredId(maps, "hosts", source.hostId);
      row.userId = mapRequiredId(maps, "users", source.userId);
      row.tunnelId = mapOptionalId(maps, "tunnels", source.tunnelId);
      row.forwardGroupId = mapOptionalId(maps, "forward_groups", source.forwardGroupId);
      row.forwardGroupRuleId = null;
      row.forwardGroupMemberId = mapOptionalId(maps, "forward_group_members", source.forwardGroupMemberId);
      row.isRunning = false;
      row.pendingDelete = false;
      return { row };

    case "forward_rule_tunnel_exits":
      row.ruleId = mapRequiredId(maps, "forward_rules", source.ruleId);
      row.tunnelId = mapRequiredId(maps, "tunnels", source.tunnelId);
      row.exitNodeId = mapRequiredId(maps, "tunnel_exit_nodes", source.exitNodeId);
      row.exitHostId = mapRequiredId(maps, "hosts", source.exitHostId);
      return { row, existingWhere: { ruleId: row.ruleId, exitNodeId: row.exitNodeId } };

    case "agent_tokens":
      if (!row.token) return null;
      row.userId = mapRequiredId(maps, "users", source.userId);
      row.hostId = mapOptionalId(maps, "hosts", source.hostId);
      row.isUsed = !!row.hostId || !!row.isUsed;
      return { row, existingWhere: { token: row.token } };

    case "host_metrics":
      row.hostId = mapRequiredId(maps, "hosts", source.hostId);
      return { row };

    case "host_traffic_counters":
      row.hostId = mapRequiredId(maps, "hosts", source.hostId);
      return { row, existingWhere: { hostId: row.hostId } };

    case "user_traffic_counters":
      row.userId = mapRequiredId(maps, "users", source.userId);
      return { row, existingWhere: { userId: row.userId } };

    case "forward_rule_traffic_counters":
      row.ruleId = mapRequiredId(maps, "forward_rules", source.ruleId);
      row.hostId = mapRequiredId(maps, "hosts", source.hostId);
      row.userId = mapRequiredId(maps, "users", source.userId);
      return { row, existingWhere: { ruleId: row.ruleId, hostId: row.hostId } };

    case "traffic_stats":
      row.ruleId = mapRequiredId(maps, "forward_rules", source.ruleId);
      row.hostId = mapRequiredId(maps, "hosts", source.hostId);
      return { row };

    case "tunnel_latency_stats":
      row.tunnelId = mapRequiredId(maps, "tunnels", source.tunnelId);
      return { row };

    case "forward_group_latency_stats":
      row.groupId = mapRequiredId(maps, "forward_groups", source.groupId);
      return { row };

    case "tcping_stats":
      row.ruleId = mapRequiredId(maps, "forward_rules", source.ruleId);
      row.hostId = mapRequiredId(maps, "hosts", source.hostId);
      return { row };

    case "forward_tests":
      row.ruleId = mapRequiredId(maps, "forward_rules", source.ruleId);
      row.hostId = mapRequiredId(maps, "hosts", source.hostId);
      row.userId = mapRequiredId(maps, "users", source.userId);
      return { row };

    case "user_host_permissions":
      row.userId = mapRequiredId(maps, "users", source.userId);
      row.hostId = mapRequiredId(maps, "hosts", source.hostId);
      return { row, existingWhere: { userId: row.userId, hostId: row.hostId } };

    case "user_tunnel_permissions":
      row.userId = mapRequiredId(maps, "users", source.userId);
      row.tunnelId = mapRequiredId(maps, "tunnels", source.tunnelId);
      return { row, existingWhere: { userId: row.userId, tunnelId: row.tunnelId } };

    case "user_forward_group_permissions":
      row.userId = mapRequiredId(maps, "users", source.userId);
      row.forwardGroupId = mapRequiredId(maps, "forward_groups", source.forwardGroupId);
      return { row, existingWhere: { userId: row.userId, forwardGroupId: row.forwardGroupId } };

    case "host_probe_services":
      row.userId = mapRequiredId(maps, "users", source.userId);
      row.hostIds = mapStoredHostIds(maps, source.hostIds);
      row.excludeHostIds = mapStoredHostIds(maps, source.excludeHostIds);
      return { row };

    case "host_probe_service_stats":
      row.serviceId = mapRequiredId(maps, "host_probe_services", source.serviceId);
      row.hostId = mapRequiredId(maps, "hosts", source.hostId);
      return { row };

    case "forward_group_events":
      row.groupId = mapRequiredId(maps, "forward_groups", source.groupId);
      row.memberId = mapOptionalId(maps, "forward_group_members", source.memberId);
      return { row };

    case "subscription_plan_hosts":
      row.planId = mapRequiredId(maps, "subscription_plans", source.planId);
      row.hostId = mapRequiredId(maps, "hosts", source.hostId);
      return { row, existingWhere: { planId: row.planId, hostId: row.hostId } };

    case "subscription_plan_tunnels":
      row.planId = mapRequiredId(maps, "subscription_plans", source.planId);
      row.tunnelId = mapRequiredId(maps, "tunnels", source.tunnelId);
      return { row, existingWhere: { planId: row.planId, tunnelId: row.tunnelId } };

    case "subscription_plan_forward_groups":
      row.planId = mapRequiredId(maps, "subscription_plans", source.planId);
      row.forwardGroupId = mapRequiredId(maps, "forward_groups", source.forwardGroupId);
      return { row, existingWhere: { planId: row.planId, forwardGroupId: row.forwardGroupId } };

    case "subscription_plan_traffic_addons":
      row.planId = mapRequiredId(maps, "subscription_plans", source.planId);
      return { row };

    case "user_subscriptions":
      row.userId = mapRequiredId(maps, "users", source.userId);
      row.planId = mapRequiredId(maps, "subscription_plans", source.planId);
      return { row };

    case "user_traffic_addons":
      row.userId = mapRequiredId(maps, "users", source.userId);
      row.subscriptionId = mapRequiredId(maps, "user_subscriptions", source.subscriptionId);
      row.planId = mapRequiredId(maps, "subscription_plans", source.planId);
      row.addonId = mapOptionalId(maps, "subscription_plan_traffic_addons", source.addonId);
      row.operatorUserId = mapOptionalId(maps, "users", source.operatorUserId);
      return { row };

    case "payment_orders":
      row.userId = mapRequiredId(maps, "users", source.userId);
      row.planId = mapOptionalId(maps, "subscription_plans", source.planId);
      row.subscriptionId = mapOptionalId(maps, "user_subscriptions", source.subscriptionId);
      row.discountCodeId = mapOptionalId(maps, "discount_codes", source.discountCodeId);
      return { row, existingWhere: row.outTradeNo ? { outTradeNo: row.outTradeNo } : undefined };

    case "balance_transactions":
      row.userId = mapRequiredId(maps, "users", source.userId);
      row.operatorUserId = mapOptionalId(maps, "users", source.operatorUserId);
      row.redemptionCodeId = mapOptionalId(maps, "redemption_codes", source.redemptionCodeId);
      return { row };

    case "traffic_billing_configs":
      row.resourceId = mappedResourceId(maps, source.resourceType, source.resourceId);
      return { row, existingWhere: { resourceType: row.resourceType, resourceId: row.resourceId } };

    case "traffic_billing_usage":
      row.userId = mapRequiredId(maps, "users", source.userId);
      row.resourceId = mappedResourceId(maps, source.resourceType, source.resourceId);
      return { row, existingWhere: { userId: row.userId, resourceType: row.resourceType, resourceId: row.resourceId } };

    case "traffic_billing_rule_usage":
      row.userId = mapRequiredId(maps, "users", source.userId);
      row.ruleId = mapRequiredId(maps, "forward_rules", source.ruleId);
      row.resourceId = mappedResourceId(maps, source.resourceType, source.resourceId);
      return { row, existingWhere: { ruleId: row.ruleId, resourceType: row.resourceType, resourceId: row.resourceId } };

    case "traffic_billing_records":
      row.userId = mapRequiredId(maps, "users", source.userId);
      row.ruleId = mapRequiredId(maps, "forward_rules", source.ruleId);
      row.resourceId = mappedResourceId(maps, source.resourceType, source.resourceId);
      return { row };

    case "user_traffic_billing_permissions":
      row.userId = mapRequiredId(maps, "users", source.userId);
      row.resourceId = mappedResourceId(maps, source.resourceType, source.resourceId);
      return { row, existingWhere: { userId: row.userId, resourceType: row.resourceType, resourceId: row.resourceId } };

    case "redemption_codes":
      row.planId = mapOptionalId(maps, "subscription_plans", source.planId);
      row.usedByUserId = mapOptionalId(maps, "users", source.usedByUserId);
      row.createdByUserId = mapOptionalId(maps, "users", source.createdByUserId);
      return { row, existingWhere: row.code ? { code: row.code } : undefined };

    case "discount_codes":
      row.createdByUserId = mapOptionalId(maps, "users", source.createdByUserId);
      return { row, existingWhere: row.code ? { code: row.code } : undefined };

    case "discount_code_plans":
      row.discountCodeId = mapRequiredId(maps, "discount_codes", source.discountCodeId);
      row.planId = mapRequiredId(maps, "subscription_plans", source.planId);
      return { row, existingWhere: { discountCodeId: row.discountCodeId, planId: row.planId } };

    case "announcements":
      row.createdByUserId = mapOptionalId(maps, "users", source.createdByUserId);
      return { row };

    case "announcement_reads":
      row.announcementId = mapRequiredId(maps, "announcements", source.announcementId);
      row.userId = mapRequiredId(maps, "users", source.userId);
      return { row, existingWhere: { announcementId: row.announcementId, userId: row.userId } };

    case "ip_geo_cache":
      return { row, existingWhere: row.address ? { address: row.address } : undefined };

    case "plugins":
      if (!row.pluginId) return null;
      return { row, existingWhere: { pluginId: row.pluginId } };

    case "plugin_store_sources":
      return {
        row,
        existingWhere: row.repository
          ? { repository: row.repository, branch: row.branch, catalogPath: row.catalogPath }
          : undefined,
      };

    case "plugin_assets":
      if (!row.pluginId || !row.path) return null;
      return { row, existingWhere: { pluginId: row.pluginId, path: row.path } };

    case "plugin_agent_states":
      row.hostId = mapRequiredId(maps, "hosts", source.hostId);
      return {
        row,
        existingWhere: {
          pluginId: row.pluginId,
          resourceViewId: row.resourceViewId,
          hostId: row.hostId,
        },
      };

    case "system_settings": {
      const key = String(source.key || "");
      if (!key) return null;
      const skippedKeys = new Set([
        "databaseConfigured",
        "databaseType",
        "mysqlConfigured",
        "mysqlHost",
        "mysqlDatabase",
        "postgresqlConfigured",
        "postgresqlHost",
        "postgresqlDatabase",
        "sqlitePath",
        "setupDataChoice",
        "panelPublicUrl",
        "migratedToPanelUrl",
        "migratedAt",
        "panelMigrationId",
        "panelMigrationPhase",
        "panelMigrationSourceUrl",
        "panelMigrationStartedAt",
        "agentMigrationTargetPanelUrl",
        "agentMigrationTargetExpiresAt",
      ]);
      if (skippedKeys.has(key)) return null;
      return { row: { key, value: source.value ?? null, updatedAt: source.updatedAt || nowDate() }, existingWhere: { key } };
    }

    default:
      return { row };
  }
}

async function updateMappedId(table: string, id: number, patch: Record<string, any>) {
  const columns = Object.keys(patch).filter((key) => patch[key] !== undefined);
  if (columns.length === 0) return;
  await executeRaw(
    `UPDATE ${quote(table)} SET ${columns.map((key) => `${quote(key)} = ?`).join(", ")} WHERE ${quote("id")} = ?`,
    [...columns.map((key) => normalizeValue(patch[key])), id],
  );
}

async function fixDeferredForwardGroupReferences(snapshot: MigrationSnapshot, maps: ImportMaps) {
  for (const group of sortedSnapshotRows(snapshot, "forward_groups")) {
    const nextId = mapId(maps, "forward_groups", group.id);
    if (!nextId) continue;
    const activeMemberId = mapOptionalId(maps, "forward_group_members", group.activeMemberId);
    if (activeMemberId) await updateMappedId("forward_groups", nextId, { activeMemberId });
  }

  for (const member of sortedSnapshotRows(snapshot, "forward_group_members")) {
    const nextId = mapId(maps, "forward_group_members", member.id);
    if (!nextId) continue;
    const ruleId = mapOptionalId(maps, "forward_rules", member.ruleId);
    if (ruleId) await updateMappedId("forward_group_members", nextId, { ruleId });
  }

  for (const rule of sortedSnapshotRows(snapshot, "forward_rules")) {
    const nextId = mapId(maps, "forward_rules", rule.id);
    if (!nextId) continue;
    await updateMappedId("forward_rules", nextId, {
      forwardGroupRuleId: mapOptionalId(maps, "forward_rules", rule.forwardGroupRuleId),
      forwardGroupMemberId: mapOptionalId(maps, "forward_group_members", rule.forwardGroupMemberId),
      isRunning: false,
      pendingDelete: false,
    });
  }
}

async function resetImportedRuntimeState(maps: ImportMaps) {
  const now = Math.floor(Date.now() / 1000);
  const hostIds = [...new Set([...(maps.hosts?.values() || [])])].filter(Boolean);
  const tunnelIds = [...new Set([...(maps.tunnels?.values() || [])])].filter(Boolean);
  const ruleIds = [...new Set([...(maps.forward_rules?.values() || [])])].filter(Boolean);
  const updateByIds = async (table: string, ids: number[], patch: Record<string, any>) => {
    if (ids.length === 0) return;
    const columns = Object.keys(patch);
    await executeRaw(
      `UPDATE ${quote(table)} SET ${columns.map((key) => `${quote(key)} = ?`).join(", ")} WHERE ${quote("id")} IN (${ids.map(() => "?").join(", ")})`,
      [...columns.map((key) => normalizeValue(patch[key])), ...ids],
    );
  };
  await updateByIds("hosts", hostIds, {
    isOnline: false,
    lastHeartbeat: null,
    agentUpgradeRequested: false,
    agentUpgradeTargetVersion: null,
    agentUpgradeReleaseVersion: null,
    agentUpgradeRequestedAt: null,
    updatedAt: now,
  });
  await updateByIds("tunnels", tunnelIds, { isRunning: false, updatedAt: now });
  await updateByIds("forward_rules", ruleIds, { isRunning: false, pendingDelete: false, updatedAt: now });
}

async function syncPostgresqlSequences() {
  if (getDatabaseKind() !== "postgresql") return;
  for (const table of MIGRATION_TABLES) {
    if (table === "system_settings") continue;
    const maxId = `COALESCE((SELECT MAX(${quote("id")}) FROM ${quote(table)}), 0)`;
    await executeRaw(
      `SELECT setval(pg_get_serial_sequence(?, 'id')::regclass, GREATEST(${maxId}, 1), ${maxId} > 0)`,
      [table],
    ).catch(() => undefined);
  }
}

export async function importMigrationSnapshot(
  snapshot: MigrationSnapshot,
  options: {
    targetPanelUrl?: string;
    onProgress?: (progress: number, step: string) => void;
    onImportedIds?: (ids: MigrationImportedIds) => void;
  } | ((progress: number, step: string) => void) = {},
): Promise<MigrationImportResult> {
  const onProgress = typeof options === "function" ? options : options.onProgress;
  const targetPanelUrl = typeof options === "function" ? undefined : options.targetPanelUrl;
  const onImportedIds = typeof options === "function" ? undefined : options.onImportedIds;
  await connectDatabase();
  await ensureDatabaseSchema();
  if (!snapshot || snapshot.version !== 1 || !snapshot.tables || typeof snapshot.tables !== "object") {
    throw new Error("迁移数据格式无效");
  }

  const existingData = await getPanelDataSummary({ useCache: false });
  const mode = existingData.hasExistingData ? "incremental" : "restore";
  const summary = summarizeMigrationSnapshot(snapshot);
  const maps: ImportMaps = {};
  const inserted: Record<string, number> = {};
  const updated: Record<string, number> = {};
  const reused: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  for (const table of MIGRATION_TABLES) maps[table] = new Map();

  const totalRows = Math.max(1, IMPORT_TABLE_ORDER.reduce((sum, table) => sum + (snapshot.tables?.[table]?.length || 0), 0));
  let processed = 0;

  onProgress?.(40, mode === "incremental" ? "正在增量合并旧面板数据" : "正在导入旧面板数据");
  for (const table of IMPORT_TABLE_ORDER) {
    const rows = sortedSnapshotRows(snapshot, table);
    if (rows.length === 0) continue;
    onProgress?.(45 + Math.floor((processed / totalRows) * 45), `正在处理 ${table}`);
    for (const source of rows) {
      processed += 1;
      const oldId = toNumberId(source.id);
      try {
        if (table !== "system_settings" && !oldId) {
          throw new Error("源数据缺少有效 ID");
        }
        const prepared = await prepareImportRow(table, source, maps);
        if (!prepared) {
          incrementCounter(skipped, table);
          continue;
        }
        if (table === "system_settings") {
          const status = await insertOrReuseSystemSetting(prepared.row, mode);
          if (status === "inserted") incrementCounter(inserted, table);
          else if (status === "updated") incrementCounter(updated, table);
          else if (status === "reused") incrementCounter(reused, table);
          else incrementCounter(skipped, table);
          continue;
        }
        const existingId = prepared.existingWhere ? await findExistingId(table, prepared.existingWhere) : null;
        if (existingId) {
          if (oldId) maps[table].set(oldId, existingId);
          incrementCounter(reused, table);
          continue;
        }
        const newId = await insertImportRow(table, prepared.row);
        if (!newId) throw new Error("写入后未返回有效 ID");
        if (oldId) maps[table].set(oldId, newId);
        incrementCounter(inserted, table);
      } catch (error) {
        incrementCounter(skipped, table);
        console.warn(`[Migration] skipped ${table}#${source.id || "-"}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const criticalSkipped = Object.entries(skipped)
    .filter(([table, count]) => count > 0 && !BEST_EFFORT_MIGRATION_TABLES.has(table as MigrationTableName));
  if (criticalSkipped.length > 0) {
    throw new Error(`关键数据导入不完整：${criticalSkipped.map(([table, count]) => `${table} ${count} 条`).join("，")}`);
  }

  onImportedIds?.({
    hosts: Object.fromEntries(maps.hosts || []),
    tunnels: Object.fromEntries(maps.tunnels || []),
    forwardRules: Object.fromEntries(maps.forward_rules || []),
  });

  onProgress?.(92, "正在修复关联关系");
  await fixDeferredForwardGroupReferences(snapshot, maps);
  await resetImportedRuntimeState(maps);
  await syncPostgresqlSequences();

  onProgress?.(95, "正在恢复系统标记");
  if (!snapshot.tables.system_settings?.some((row) => row.key === "storeEnabled")) {
    await setSetting("storeEnabled", "false");
  }
  await setSetting("setupDataChoice", "use-existing");
  await setSetting("lastPanelImportAt", String(Math.floor(Date.now() / 1000)));
  await setSetting("lastPanelImportMode", mode);
  if (targetPanelUrl) await setSetting("panelPublicUrl", normalizePanelUrl(targetPanelUrl));
  invalidatePanelDataSummaryCache();

  onProgress?.(96, "正在重建流量汇总缓存");
  await ensureTrafficStatBucketsBackfilled({ force: true }).catch((error) => {
    console.warn("[TrafficSummary] Post-migration bucket backfill skipped:", error instanceof Error ? error.message : String(error));
  });
  await ensureUserTrafficCountersBackfilled().catch((error) => {
    console.warn("[TrafficCounter] Post-migration cumulative counter backfill skipped:", error instanceof Error ? error.message : String(error));
  });

  onProgress?.(97, "正在优化数据库查询性能");
  await maintainCurrentPostgresqlDatabase({ forceAnalyze: true }).catch((error) => {
    console.warn("[PostgreSQL] Post-migration maintenance skipped:", error instanceof Error ? error.message : String(error));
  });
  await maintainCurrentMysqlDatabase({ forceAnalyze: true }).catch((error) => {
    console.warn("[MySQL] Post-migration maintenance skipped:", error instanceof Error ? error.message : String(error));
  });

  return {
    success: true,
    mode,
    summary,
    existingData: {
      hasExistingData: existingData.hasExistingData,
      businessDataCount: existingData.businessDataCount,
      userCount: existingData.userCount,
      hostCount: existingData.hostCount,
      ruleCount: existingData.ruleCount,
      tunnelCount: existingData.tunnelCount,
      forwardGroupCount: existingData.forwardGroupCount,
    },
    inserted,
    updated,
    reused,
    skipped,
    hostCount: maps.hosts?.size || summary.hostCount,
    panelUrl: targetPanelUrl ? normalizePanelUrl(targetPanelUrl) : undefined,
  };
}

export async function announcePanelMigration(
  targetPanelUrl: string,
  options: { forceAgentSwitch?: boolean; updatePanelPublicUrl?: boolean } = {},
) {
  const normalized = normalizePanelUrl(targetPanelUrl);
  if (options.updatePanelPublicUrl !== false) await setSetting("panelPublicUrl", normalized);
  const hosts = await getHosts();
  const targetVersion = options.forceAgentSwitch ? "9999.0.0" : AGENT_VERSION;
  for (const host of hosts as any[]) {
    await requestHostAgentUpgrade(Number(host.id), targetVersion);
    pushAgentUpgrade(Number(host.id), targetVersion, normalized);
  }
  return { hostCount: hosts.length, panelUrl: normalized };
}

async function cancelPanelMigrationAnnouncement() {
  const hosts = await getHosts();
  for (const host of hosts as any[]) {
    await clearHostAgentUpgradeRequest(Number(host.id));
  }
  await setSetting("agentMigrationTargetPanelUrl", null);
  await setSetting("agentMigrationTargetExpiresAt", null);
  invalidatePanelMigrationAgentStateCache();
  return hosts.length;
}

async function markPanelAsMigrated(targetPanelUrl: string) {
  await connectDatabase();
  await ensureDatabaseSchema();
  const normalized = normalizePanelUrl(targetPanelUrl);
  await setSetting("migratedToPanelUrl", normalized);
  await setSetting("migratedAt", String(Math.floor(nowDate().getTime() / 1000)));
  await setSetting("panelPublicUrl", normalized);
}

async function fetchSnapshotFromOldPanelWithApproval(input: {
  oldPanelUrl: string;
  migrationCode: string;
  targetPanelUrl: string;
  onPendingApproval?: () => void;
}) {
  const url = `${normalizePanelUrl(input.oldPanelUrl)}/api/migration/export`;
  await assertSafeOutboundUrl(url, { allowPrivate: true, purpose: "面板迁移请求" });
  const normalizedTargetPanelUrl = normalizePanelUrl(input.targetPanelUrl);
  let requestId = "";
  const deadline = Date.now() + 6 * 60 * 1000;

  while (Date.now() < deadline) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      redirect: "manual",
      body: JSON.stringify({
        migrationCode: input.migrationCode,
        targetPanelUrl: normalizedTargetPanelUrl,
        requestId: requestId || undefined,
      }),
    });
    const body = await resp.text();

    if (resp.status === 202) {
      const pending = body ? JSON.parse(body) : {};
      requestId = pending.requestId || requestId;
      input.onPendingApproval?.();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }

    if (!resp.ok) {
      throw new Error(body || `旧面板返回 ${resp.status}`);
    }

    return JSON.parse(body) as MigrationSnapshot;
  }

  throw new Error("等待旧面板管理员确认迁移超时，请重新生成迁移码");
}

type OldPanelTakeoverInput = {
  oldPanelUrl: string;
  targetPanelUrl: string;
  takeoverToken: string;
  migrationId: string;
};

async function postOldPanelTakeover(path: string, input: OldPanelTakeoverInput) {
  const url = `${normalizePanelUrl(input.oldPanelUrl)}${path}`;
  await assertSafeOutboundUrl(url, { allowPrivate: true, purpose: "面板迁移请求" });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let resp: globalThis.Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      redirect: "manual",
      signal: controller.signal,
      body: JSON.stringify({
        takeoverToken: input.takeoverToken,
        targetPanelUrl: input.targetPanelUrl,
        fallbackPanelUrl: normalizePanelUrl(input.oldPanelUrl),
        migrationId: input.migrationId,
      }),
    });
  } finally {
    clearTimeout(timer);
  }
  const body = await resp.text();
  if (!resp.ok) {
    let message = body;
    try {
      message = JSON.parse(body)?.error || body;
    } catch {
      // Keep the original response text.
    }
    throw new Error(message || `旧面板迁移接口返回 ${resp.status}`);
  }
  return body ? JSON.parse(body) : null;
}

async function prepareOldPanelTakeover(input: OldPanelTakeoverInput) {
  return postOldPanelTakeover("/api/migration/takeover-prepare", input);
}

async function abortOldPanelTakeover(input: OldPanelTakeoverInput) {
  return postOldPanelTakeover("/api/migration/takeover-abort", input);
}

async function finalizeOldPanelTakeover(input: OldPanelTakeoverInput) {
  let lastError: unknown;
  let attempt = 0;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      return await postOldPanelTakeover("/api/migration/takeover-complete", input);
    } catch (error) {
      lastError = error;
      const delay = Math.min(10_000, 1000 * attempt);
      if (Date.now() + delay < deadline) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

type MigrationRuntimeExpectations = {
  hostIds: number[];
  ruleIds: number[];
  tunnelIds: number[];
  allImportedHostIds: number[];
};

function migrationBool(value: unknown) {
  return value === true || value === 1 || value === "1" || String(value || "").toLowerCase() === "true";
}

function migrationTimeMs(value: unknown) {
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  const parsed = new Date(String(value || "")).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildMigrationRuntimeExpectations(
  snapshot: MigrationSnapshot,
  importedIds: MigrationImportedIds,
): MigrationRuntimeExpectations {
  const exportedAt = Number(snapshot.exportedAt || Date.now());
  const onlineHostOldIds = new Set<number>();
  for (const host of snapshot.tables.hosts || []) {
    const id = toNumberId(host.id);
    const heartbeatAt = migrationTimeMs(host.lastHeartbeat);
    if (id && migrationBool(host.isOnline) && heartbeatAt > 0 && exportedAt - heartbeatAt <= HOST_ONLINE_TTL_MS) {
      onlineHostOldIds.add(id);
    }
  }
  const hostIds = Array.from(onlineHostOldIds)
    .map((id) => Number(importedIds.hosts[id] || 0))
    .filter((id) => id > 0);
  const ruleIds = (snapshot.tables.forward_rules || [])
    .filter((rule) => migrationBool(rule.isEnabled) && migrationBool(rule.isRunning) && !migrationBool(rule.pendingDelete))
    .map((rule) => Number(importedIds.forwardRules[Number(rule.id)] || 0))
    .filter((id) => id > 0);
  const tunnelIds = (snapshot.tables.tunnels || [])
    .filter((tunnel) => migrationBool(tunnel.isEnabled) && migrationBool(tunnel.isRunning))
    .map((tunnel) => Number(importedIds.tunnels[Number(tunnel.id)] || 0))
    .filter((id) => id > 0);
  if ((ruleIds.length > 0 || tunnelIds.length > 0) && hostIds.length === 0) {
    throw new Error("旧面板存在运行中的转发，但没有可验证的在线 Agent；请先恢复 Agent 在线后再迁移");
  }
  return {
    hostIds: Array.from(new Set(hostIds)),
    ruleIds: Array.from(new Set(ruleIds)),
    tunnelIds: Array.from(new Set(tunnelIds)),
    allImportedHostIds: Array.from(new Set(Object.values(importedIds.hosts).map(Number).filter((id) => id > 0))),
  };
}

async function readyIds(
  table: string,
  ids: number[],
  predicate: (row: Record<string, any>) => boolean,
) {
  if (ids.length === 0) return 0;
  const rows = await queryRaw<Record<string, any>>(
    `SELECT * FROM ${quote(table)} WHERE ${quote("id")} IN (${ids.map(() => "?").join(", ")})`,
    ids,
  );
  return rows.filter(predicate).length;
}

async function getMigrationRuntimeReadiness(expectations: MigrationRuntimeExpectations, switchedAt: number) {
  const [hostsReady, rulesReady, tunnelsReady] = await Promise.all([
    readyIds("hosts", expectations.hostIds, (row) => (
      migrationBool(row.isOnline) && migrationTimeMs(row.lastHeartbeat) >= switchedAt - 5_000
    )),
    readyIds("forward_rules", expectations.ruleIds, (row) => migrationBool(row.isRunning)),
    readyIds("tunnels", expectations.tunnelIds, (row) => migrationBool(row.isRunning)),
  ]);
  return {
    hostsReady,
    rulesReady,
    tunnelsReady,
    complete: hostsReady === expectations.hostIds.length
      && rulesReady === expectations.ruleIds.length
      && tunnelsReady === expectations.tunnelIds.length,
  };
}

async function waitForMigratedRuntime(
  job: MigrationJob,
  expectations: MigrationRuntimeExpectations,
  switchedAt: number,
) {
  const deadline = Date.now() + MIGRATION_RUNTIME_TIMEOUT_MS;
  let stablePasses = 0;
  while (Date.now() < deadline) {
    const readiness = await getMigrationRuntimeReadiness(expectations, switchedAt);
    setJob(job, {
      progress: 99,
      step: `正在验证新面板运行状态：主机 ${readiness.hostsReady}/${expectations.hostIds.length}，规则 ${readiness.rulesReady}/${expectations.ruleIds.length}，隧道 ${readiness.tunnelsReady}/${expectations.tunnelIds.length}`,
    });
    stablePasses = readiness.complete ? stablePasses + 1 : 0;
    if (stablePasses >= 2) return readiness;
    await new Promise((resolve) => setTimeout(resolve, MIGRATION_RUNTIME_POLL_MS));
  }
  const readiness = await getMigrationRuntimeReadiness(expectations, switchedAt);
  throw new Error(
    `新面板运行验证超时：主机 ${readiness.hostsReady}/${expectations.hostIds.length}，规则 ${readiness.rulesReady}/${expectations.ruleIds.length}，隧道 ${readiness.tunnelsReady}/${expectations.tunnelIds.length}；已取消接管，旧面板不会停用或删除数据`,
  );
}

async function verifyTargetPanelIdentity(job: MigrationJob, targetPanelUrl: string) {
  const probeToken = migrationJobProbeTokens.get(job.id);
  if (!probeToken) throw new Error("新面板验证令牌已失效");
  const url = `${normalizePanelUrl(targetPanelUrl)}/api/migration/target-probe`;
  await assertSafeOutboundUrl(url, { allowPrivate: true, purpose: "新面板地址验证" });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      redirect: "manual",
      signal: controller.signal,
      body: JSON.stringify({ jobId: job.id, probeToken }),
    });
    const body = await resp.text();
    const result = body ? JSON.parse(body) : {};
    if (!resp.ok || result.jobId !== job.id || result.appVersion !== APP_VERSION) {
      throw new Error(result.error || `目标地址返回 ${resp.status}`);
    }
  } catch (error) {
    if ((error as any)?.name === "AbortError") throw new Error("新面板公开地址连接超时");
    throw new Error(`新面板公开地址验证失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

function pushMigrationDirectiveToHosts(
  hostIds: number[],
  directive: { id: string; state: "preparing" | "committed" | "aborted"; fallbackPanelUrl?: string },
) {
  for (const hostId of hostIds) pushAgentPanelMigration(hostId, directive);
}

export function startPanelMigration(input: {
  oldPanelUrl: string;
  migrationCode: string;
  targetPanelUrl: string;
}) {
  const activeJob = [...jobs.values()].find((item) => item.status === "pending" || item.status === "running");
  if (activeJob) throw new Error(`已有迁移任务正在执行：${activeJob.step}`);
  const job: MigrationJob = {
    id: nodeCrypto.randomUUID(),
    status: "pending",
    progress: 0,
    step: "等待迁移开始",
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  migrationJobProbeTokens.set(job.id, nodeCrypto.randomBytes(32).toString("hex"));

  void (async () => {
    let takeoverInput: OldPanelTakeoverInput | null = null;
    let takeoverPrepareStarted = false;
    let commitStarted = false;
    let expectations: MigrationRuntimeExpectations | null = null;
    try {
      setJob(job, { status: "running", progress: 10, step: "正在连接旧面板" });
      const snapshot = await fetchSnapshotFromOldPanelWithApproval({
        ...input,
        onPendingApproval: () => setJob(job, { progress: 20, step: "等待旧面板管理员确认迁移请求" }),
      });
      if (!snapshot.takeoverToken) throw new Error("旧面板未提供安全接管令牌，请先升级旧面板后再迁移");
      setJob(job, { progress: 35, step: "已获取旧面板数据，正在准备新数据库" });
      let importedIds: MigrationImportedIds | null = null;
      const imported = await importMigrationSnapshot(snapshot, {
        targetPanelUrl: input.targetPanelUrl,
        onProgress: (progress, step) => setJob(job, { progress, step }),
        onImportedIds: (ids) => { importedIds = ids; },
      });
      if (!importedIds) throw new Error("迁移数据关联映射生成失败");
      expectations = buildMigrationRuntimeExpectations(snapshot, importedIds);
      setJob(job, { progress: 98, step: "正在验证新面板公开地址" });
      await setSetting("panelPublicUrl", normalizePanelUrl(input.targetPanelUrl));
      await setSetting("setupDataChoice", "use-existing");
      await verifyTargetPanelIdentity(job, input.targetPanelUrl);

      const switchedAt = Date.now();
      takeoverInput = {
        oldPanelUrl: input.oldPanelUrl,
        targetPanelUrl: input.targetPanelUrl,
        takeoverToken: snapshot.takeoverToken,
        migrationId: job.id,
      };
      await setPanelMigrationAgentDirective({
        id: job.id,
        state: "preparing",
        fallbackPanelUrl: normalizePanelUrl(input.oldPanelUrl),
        startedAt: Math.floor(switchedAt / 1000),
      });
      setJob(job, { progress: 98, step: "正在预切换 Agent，旧面板继续保留运行" });
      takeoverPrepareStarted = true;
      await prepareOldPanelTakeover(takeoverInput);
      await waitForMigratedRuntime(job, expectations, switchedAt);

      setJob(job, { progress: 99, step: "新面板运行正常，正在完成接管" });
      await setPanelMigrationAgentDirective({
        id: job.id,
        state: "committing",
        fallbackPanelUrl: normalizePanelUrl(input.oldPanelUrl),
        startedAt: Math.floor(switchedAt / 1000),
      });
      commitStarted = true;
      await finalizeOldPanelTakeover({
        ...takeoverInput,
      });
      startBackgroundServices();
      await setPanelMigrationAgentDirective({ id: job.id, state: "committed" });
      pushMigrationDirectiveToHosts(expectations.allImportedHostIds, { id: job.id, state: "committed" });
      markLocalSetupComplete();
      setJob(job, {
        status: "success",
        progress: 100,
        step: imported.mode === "incremental" ? "增量迁移完成" : "迁移完成",
        message: imported.mode === "incremental"
          ? "新面板已有业务数据已保留，旧面板数据已增量导入并通过运行验证；旧面板数据仍完整保留。"
          : "新面板已通过 Agent 和转发运行验证；旧面板数据仍完整保留，可由用户确认后手动处理。",
        finishedAt: Date.now(),
      });
    } catch (error) {
      if (takeoverPrepareStarted && takeoverInput && !commitStarted) {
        await setPanelMigrationAgentDirective({
          id: job.id,
          state: "aborted",
          fallbackPanelUrl: normalizePanelUrl(input.oldPanelUrl),
          startedAt: Math.floor(Date.now() / 1000),
        }).catch(() => undefined);
        if (expectations) {
          pushMigrationDirectiveToHosts(expectations.allImportedHostIds, {
            id: job.id,
            state: "aborted",
            fallbackPanelUrl: normalizePanelUrl(input.oldPanelUrl),
          });
        }
        await abortOldPanelTakeover(takeoverInput).catch((abortError) => {
          console.warn(`[Migration] old panel abort failed: ${abortError instanceof Error ? abortError.message : String(abortError)}`);
        });
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      setJob(job, {
        status: "failed",
        progress: Math.max(job.progress, 1),
        step: "迁移失败",
        error: commitStarted
          ? `新面板已通过运行验证，但旧面板的最终接管确认未完成：${errorMessage}。Agent 暂时保持在新面板且保留回退信息，请勿删除旧面板，先恢复新旧面板连通性。`
          : errorMessage,
        finishedAt: Date.now(),
      });
    } finally {
      migrationJobProbeTokens.delete(job.id);
    }
  })();

  return job;
}

export const migrationRouter = Router();

migrationRouter.post("/api/migration/target-probe", async (req: Request, res: Response) => {
  try {
    const jobId = String(req.body?.jobId || "");
    const probeToken = String(req.body?.probeToken || "");
    const expectedToken = migrationJobProbeTokens.get(jobId);
    const job = jobs.get(jobId);
    if (!job || !expectedToken || probeToken.length !== expectedToken.length) {
      res.status(404).json({ error: "迁移验证任务不存在" });
      return;
    }
    const tokenMatches = nodeCrypto.timingSafeEqual(Buffer.from(probeToken), Buffer.from(expectedToken));
    if (!tokenMatches || (job.status !== "pending" && job.status !== "running")) {
      res.status(404).json({ error: "迁移验证任务不存在" });
      return;
    }
    await connectDatabase();
    await ensureDatabaseSchema();
    await queryRaw("SELECT 1 AS healthy");
    res.json({ success: true, jobId, appVersion: APP_VERSION, database: "ready" });
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

migrationRouter.post("/api/migration/export", async (req: Request, res: Response) => {
  try {
    const migrationCode = String(req.body?.migrationCode || "");
    const targetPanelUrl = String(req.body?.targetPanelUrl || "");
    const requestId = String(req.body?.requestId || "");
    if (!migrationCode) {
      res.status(400).json({ error: "migrationCode required" });
      return;
    }
    const request = requestId
      ? getMigrationRequest(requestId, migrationCode)
      : createMigrationRequest(migrationCode, normalizePanelUrl(targetPanelUrl));
    if (!request) {
      res.status(401).json({ error: "迁移码无效、已过期或已使用" });
      return;
    }
    if (request.status === "rejected") {
      res.status(403).json({ error: "旧面板管理员已拒绝本次迁移请求" });
      return;
    }
    if (request.status !== "approved") {
      res.status(202).json({
        status: "pending",
        requestId: request.id,
        targetPanelUrl: request.targetPanelUrl,
        expiresAt: request.expiresAt,
      });
      return;
    }
    const takeover = consumeApprovedMigrationRequest(request.id, migrationCode, normalizePanelUrl(targetPanelUrl));
    if (!takeover) {
      res.status(401).json({ error: "迁移码无效、已过期或已使用" });
      return;
    }
    const settings = await getAllSettings();
    const snapshot = await exportMigrationSnapshot(settings.panelPublicUrl || undefined);
    snapshot.takeoverToken = takeover.takeoverToken;
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

migrationRouter.post("/api/migration/takeover-prepare", async (req: Request, res: Response) => {
  try {
    const takeoverToken = String(req.body?.takeoverToken || "");
    const targetPanelUrl = normalizePanelUrl(String(req.body?.targetPanelUrl || ""));
    if (!takeoverToken || !targetPanelUrl) {
      res.status(400).json({ error: "takeoverToken/targetPanelUrl required" });
      return;
    }
    const migratedToPanelUrl = normalizePanelUrl((await getAllSettings()).migratedToPanelUrl || "");
    if (migratedToPanelUrl && migratedToPanelUrl !== targetPanelUrl) {
      res.status(409).json({ error: `旧面板已经迁移到其他地址：${migratedToPanelUrl}` });
      return;
    }
    if (!prepareTakeoverToken(takeoverToken, targetPanelUrl)) {
      res.status(401).json({ error: "接管令牌无效、已过期或目标面板不匹配" });
      return;
    }
    if (migratedToPanelUrl === targetPanelUrl) {
      res.json({ success: true, phase: "prepared", panelUrl: targetPanelUrl, alreadyCompleted: true, oldPanelActive: false, dataPreserved: true });
      return;
    }
    await setSetting("agentMigrationTargetPanelUrl", targetPanelUrl);
    await setSetting("agentMigrationTargetExpiresAt", String(Math.floor(Date.now() / 1000) + 60 * 60));
    invalidatePanelMigrationAgentStateCache();
    const takeover = await announcePanelMigration(targetPanelUrl, {
      forceAgentSwitch: true,
      updatePanelPublicUrl: false,
    });
    res.json({ success: true, phase: "prepared", ...takeover, oldPanelActive: true, dataPreserved: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

migrationRouter.post("/api/migration/takeover-abort", async (req: Request, res: Response) => {
  try {
    const takeoverToken = String(req.body?.takeoverToken || "");
    const targetPanelUrl = normalizePanelUrl(String(req.body?.targetPanelUrl || ""));
    if (!takeoverToken || !targetPanelUrl) {
      res.status(400).json({ error: "takeoverToken/targetPanelUrl required" });
      return;
    }
    if (!abortTakeoverToken(takeoverToken, targetPanelUrl)) {
      res.status(401).json({ error: "接管令牌无效、已过期或目标面板不匹配" });
      return;
    }
    const hostCount = await cancelPanelMigrationAnnouncement();
    res.json({ success: true, phase: "aborted", hostCount, oldPanelActive: true, dataPreserved: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

migrationRouter.post("/api/migration/takeover-complete", async (req: Request, res: Response) => {
  try {
    const takeoverToken = String(req.body?.takeoverToken || "");
    const targetPanelUrl = String(req.body?.targetPanelUrl || "");
    if (!takeoverToken || !targetPanelUrl) {
      res.status(400).json({ error: "takeoverToken/targetPanelUrl required" });
      return;
    }
    const normalizedTarget = normalizePanelUrl(targetPanelUrl);
    const alreadyMigratedTo = normalizePanelUrl((await getAllSettings()).migratedToPanelUrl || "");
    if (alreadyMigratedTo === normalizedTarget) {
      await markPanelAsMigrated(normalizedTarget);
      await setSetting("agentMigrationTargetPanelUrl", null);
      await setSetting("agentMigrationTargetExpiresAt", null);
      invalidatePanelMigrationAgentStateCache();
      res.json({ success: true, panelUrl: normalizedTarget, alreadyCompleted: true, dataPreserved: true });
      return;
    }
    if (!validatePreparedTakeoverToken(takeoverToken, normalizedTarget)) {
      res.status(401).json({ error: "接管令牌无效、已过期或已使用" });
      return;
    }
    await markPanelAsMigrated(normalizedTarget);
    consumeTakeoverToken(takeoverToken, normalizedTarget);
    await setSetting("agentMigrationTargetPanelUrl", null);
    await setSetting("agentMigrationTargetExpiresAt", null);
    invalidatePanelMigrationAgentStateCache();
    const takeover = await announcePanelMigration(normalizedTarget, { forceAgentSwitch: true });
    res.json({ success: true, ...takeover, dataPreserved: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
