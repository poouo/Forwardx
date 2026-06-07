import { Request, Response, Router } from "express";
import nodeCrypto from "crypto";
import { MIGRATION_TABLES, ensureDatabaseSchema } from "./dbSchema";
import { connectDatabase, executeRaw, getDatabaseKind, insertAndGetId, nowDate, queryRaw } from "./dbRuntime";
import { getAllSettings, setSetting } from "./repositories/settingsRepository";
import { getHosts, requestHostAgentUpgrade } from "./db";
import { pushAgentUpgrade } from "./agentEvents";
import { AGENT_VERSION, APP_VERSION } from "../shared/versions";
import {
  consumeApprovedMigrationRequest,
  consumeTakeoverToken,
  createMigrationRequest,
  getMigrationRequest,
} from "./migrationCodes";

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

function quote(name: string) {
  return getDatabaseKind() === "sqlite" ? `"${name}"` : `\`${name}\``;
}

function normalizeValue(value: any) {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === "boolean") return value ? 1 : 0;
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
  if (value === null || value === undefined || value === "") return null;
  return mapId(maps, table, value);
}

function mapRequiredId(maps: ImportMaps, table: string, value: unknown) {
  const mapped = mapId(maps, table, value);
  if (!mapped) throw new Error(`依赖数据缺失：${table}#${value}`);
  return mapped;
}

function incrementCounter(target: Record<string, number>, table: string) {
  target[table] = (target[table] || 0) + 1;
}

async function getTableCount(table: string) {
  const rows = await queryRaw<{ count: number }>(`SELECT COUNT(*) as count FROM ${quote(table)}`).catch(() => []);
  return Number(rows[0]?.count || 0);
}

export async function getPanelDataSummary() {
  await connectDatabase();
  await ensureDatabaseSchema();
  const counts: Record<string, number> = {};
  for (const table of MIGRATION_TABLES) {
    counts[table] = await getTableCount(table);
  }
  const userCount = counts.users || 0;
  const hostCount = counts.hosts || 0;
  const ruleCount = counts.forward_rules || 0;
  const tunnelCount = counts.tunnels || 0;
  const forwardGroupCount = counts.forward_groups || 0;
  const businessDataCount = Object.entries(counts).reduce((sum, [table, count]) => {
    if (table === "system_settings") return sum;
    if (table === "users") return sum + Math.max(0, count - 1);
    return sum + count;
  }, 0);
  return {
    hasExistingData: businessDataCount > 0,
    businessDataCount,
    userCount,
    hostCount,
    ruleCount,
    tunnelCount,
    forwardGroupCount,
    tableCounts: counts,
  };
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
const BACKUP_KDF = { name: "scrypt" as const, keyLength: 32, cost: 16384, blockSize: 8, parallelization: 1 };

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
  "tunnels",
  "forward_groups",
  "forward_group_members",
  "forward_rules",
  "tunnel_hops",
  "agent_tokens",
  "user_host_permissions",
  "user_tunnel_permissions",
  "host_metrics",
  "tunnel_latency_stats",
  "forward_group_latency_stats",
  "traffic_stats",
  "tcping_stats",
  "forward_tests",
  "forward_group_events",
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
  "traffic_billing_records",
  "user_traffic_billing_permissions",
  "announcements",
  "announcement_reads",
  "system_settings",
] as const;

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
  return toNumberId(resourceId);
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
      row.agentUpgradeRequestedAt = null;
      return { row, existingWhere: row.agentToken ? { agentToken: row.agentToken } : undefined };

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

    case "agent_tokens":
      if (!row.token) return null;
      row.userId = mapRequiredId(maps, "users", source.userId);
      row.hostId = mapOptionalId(maps, "hosts", source.hostId);
      row.isUsed = !!row.hostId || !!row.isUsed;
      return { row, existingWhere: { token: row.token } };

    case "host_metrics":
      row.hostId = mapRequiredId(maps, "hosts", source.hostId);
      return { row };

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

    case "system_settings": {
      const key = String(source.key || "");
      if (!key) return null;
      const skippedKeys = new Set([
        "databaseConfigured",
        "databaseType",
        "mysqlConfigured",
        "mysqlHost",
        "mysqlDatabase",
        "sqlitePath",
        "setupDataChoice",
        "panelPublicUrl",
        "migratedToPanelUrl",
        "migratedAt",
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
    agentUpgradeRequestedAt: null,
    updatedAt: now,
  });
  await updateByIds("tunnels", tunnelIds, { isRunning: false, updatedAt: now });
  await updateByIds("forward_rules", ruleIds, { isRunning: false, pendingDelete: false, updatedAt: now });
}

export async function importMigrationSnapshot(
  snapshot: MigrationSnapshot,
  options: {
    targetPanelUrl?: string;
    onProgress?: (progress: number, step: string) => void;
  } | ((progress: number, step: string) => void) = {},
): Promise<MigrationImportResult> {
  const onProgress = typeof options === "function" ? options : options.onProgress;
  const targetPanelUrl = typeof options === "function" ? undefined : options.targetPanelUrl;
  await connectDatabase();
  await ensureDatabaseSchema();
  if (!snapshot || snapshot.version !== 1 || !snapshot.tables || typeof snapshot.tables !== "object") {
    throw new Error("迁移数据格式无效");
  }

  const existingData = await getPanelDataSummary();
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
        const newId = table === "system_settings"
          ? 0
          : await insertImportRow(table, prepared.row);
        if (oldId && newId) maps[table].set(oldId, newId);
        incrementCounter(inserted, table);
      } catch (error) {
        incrementCounter(skipped, table);
        console.warn(`[Migration] skipped ${table}#${source.id || "-"}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  onProgress?.(92, "正在修复关联关系");
  await fixDeferredForwardGroupReferences(snapshot, maps);
  await resetImportedRuntimeState(maps);

  onProgress?.(95, "正在恢复系统标记");
  if (!snapshot.tables.system_settings?.some((row) => row.key === "storeEnabled")) {
    await setSetting("storeEnabled", "false");
  }
  await setSetting("setupDataChoice", "use-existing");
  await setSetting("lastPanelImportAt", String(Math.floor(Date.now() / 1000)));
  await setSetting("lastPanelImportMode", mode);
  if (targetPanelUrl) await setSetting("panelPublicUrl", normalizePanelUrl(targetPanelUrl));

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

export async function announcePanelMigration(targetPanelUrl: string, options: { forceAgentSwitch?: boolean } = {}) {
  const normalized = normalizePanelUrl(targetPanelUrl);
  await setSetting("panelPublicUrl", normalized);
  const hosts = await getHosts();
  const targetVersion = options.forceAgentSwitch ? "9999.0.0" : AGENT_VERSION;
  for (const host of hosts as any[]) {
    await requestHostAgentUpgrade(Number(host.id), targetVersion);
    pushAgentUpgrade(Number(host.id), targetVersion, normalized);
  }
  return { hostCount: hosts.length, panelUrl: normalized };
}

async function markPanelAsMigrated(targetPanelUrl: string) {
  await connectDatabase();
  await ensureDatabaseSchema();
  const normalized = normalizePanelUrl(targetPanelUrl);
  await setSetting("panelPublicUrl", normalized);
  await setSetting("migratedToPanelUrl", normalized);
  await setSetting("migratedAt", String(Math.floor(nowDate().getTime() / 1000)));
}

async function fetchSnapshotFromOldPanelWithApproval(input: {
  oldPanelUrl: string;
  migrationCode: string;
  targetPanelUrl: string;
  onPendingApproval?: () => void;
}) {
  const url = `${normalizePanelUrl(input.oldPanelUrl)}/api/migration/export`;
  const normalizedTargetPanelUrl = normalizePanelUrl(input.targetPanelUrl);
  let requestId = "";
  const deadline = Date.now() + 6 * 60 * 1000;

  while (Date.now() < deadline) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

async function finalizeOldPanelTakeover(input: {
  oldPanelUrl: string;
  targetPanelUrl: string;
  takeoverToken?: string;
}) {
  if (!input.takeoverToken) return null;
  const url = `${normalizePanelUrl(input.oldPanelUrl)}/api/migration/takeover-complete`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      takeoverToken: input.takeoverToken,
      targetPanelUrl: input.targetPanelUrl,
    }),
  });
  const body = await resp.text();
  if (!resp.ok) {
    throw new Error(body || `旧面板接管确认返回 ${resp.status}`);
  }
  return body ? JSON.parse(body) : null;
}

export function startPanelMigration(input: {
  oldPanelUrl: string;
  migrationCode: string;
  targetPanelUrl: string;
}) {
  const job: MigrationJob = {
    id: nodeCrypto.randomUUID(),
    status: "pending",
    progress: 0,
    step: "等待迁移开始",
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);

  void (async () => {
    try {
      setJob(job, { status: "running", progress: 10, step: "正在连接旧面板" });
      const snapshot = await fetchSnapshotFromOldPanelWithApproval({
        ...input,
        onPendingApproval: () => setJob(job, { progress: 20, step: "等待旧面板管理员确认迁移请求" }),
      });
      setJob(job, { progress: 35, step: "已获取旧面板数据，正在准备新数据库" });
      const imported = await importMigrationSnapshot(snapshot, {
        targetPanelUrl: input.targetPanelUrl,
        onProgress: (progress, step) => setJob(job, { progress, step }),
      });
      setJob(job, { progress: 94, step: "正在写入新面板地址" });
      await setSetting("panelPublicUrl", normalizePanelUrl(input.targetPanelUrl));
      await setSetting("setupDataChoice", "use-existing");
      setJob(job, { progress: 96, step: "正在通知旧面板切换 Agent" });
      await finalizeOldPanelTakeover({
        oldPanelUrl: input.oldPanelUrl,
        targetPanelUrl: input.targetPanelUrl,
        takeoverToken: snapshot.takeoverToken,
      });
      setJob(job, {
        status: "success",
        progress: 100,
        step: imported.mode === "incremental" ? "增量迁移完成" : "迁移完成",
        message: imported.mode === "incremental"
          ? "新面板已有业务数据已保留，旧面板数据已增量导入。"
          : "旧面板数据已导入，旧面板已进入迁移失效状态。",
        finishedAt: Date.now(),
      });
    } catch (error) {
      setJob(job, {
        status: "failed",
        progress: Math.max(job.progress, 1),
        step: "迁移失败",
        error: error instanceof Error ? error.message : String(error),
        finishedAt: Date.now(),
      });
    }
  })();

  return job;
}

export const migrationRouter = Router();

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

migrationRouter.post("/api/migration/takeover-complete", async (req: Request, res: Response) => {
  try {
    const takeoverToken = String(req.body?.takeoverToken || "");
    const targetPanelUrl = String(req.body?.targetPanelUrl || "");
    if (!takeoverToken || !targetPanelUrl) {
      res.status(400).json({ error: "takeoverToken/targetPanelUrl required" });
      return;
    }
    if (!consumeTakeoverToken(takeoverToken)) {
      res.status(401).json({ error: "接管令牌无效、已过期或已使用" });
      return;
    }
    await markPanelAsMigrated(targetPanelUrl);
    const takeover = await announcePanelMigration(targetPanelUrl, { forceAgentSwitch: true });
    res.json({ success: true, ...takeover });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
