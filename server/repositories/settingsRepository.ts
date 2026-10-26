import { eq } from "drizzle-orm";
import { systemSettings } from "../../drizzle/schema";
import { inArray } from "drizzle-orm";
import { executeRaw, getDatabaseKind, getDb } from "../dbRuntime";

// ==================== System Settings (key-value) ====================

const ALL_SETTINGS_CACHE_TTL_MS = 5_000;
let allSettingsCache: {
  db: unknown;
  expiresAt: number;
  values: Record<string, string | null>;
} | null = null;
let allSettingsLoad: {
  db: unknown;
  promise: Promise<Record<string, string | null>>;
} | null = null;
let allSettingsGeneration = 0;

export function invalidateAllSettingsCache() {
  allSettingsCache = null;
  allSettingsLoad = null;
  allSettingsGeneration += 1;
}

/** 读取单个系统设置；不存在返回 null */
export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const r = await db.select().from(systemSettings).where(eq(systemSettings.key, key)).limit(1);
  return r[0]?.value ?? null;
}

/** Live, scoped read; no TTL cache for feature/security decisions. */
export async function getSettings(keys: string[]): Promise<Record<string, string | null>> {
  const unique = [...new Set(keys)];
  const values: Record<string, string | null> = Object.fromEntries(unique.map(key => [key, null]));
  if (!unique.length) return values;
  const db = await getDb();
  if (!db) return values;
  for (let offset = 0; offset < unique.length; offset += 500) {
    const rows = await db.select().from(systemSettings).where(inArray(systemSettings.key, unique.slice(offset, offset + 500)));
    for (const row of rows) values[row.key] = row.value ?? null;
  }
  return values;
}

/** 批量读取所有系统设置 */
export async function getAllSettings(): Promise<Record<string, string | null>> {
  const db = await getDb();
  if (!db) return {};
  const now = Date.now();
  const cached = allSettingsCache;
  if (cached && cached.db === db && cached.expiresAt > now) {
    return { ...cached.values };
  }
  const activeLoad = allSettingsLoad;
  if (activeLoad && activeLoad.db === db) return { ...await activeLoad.promise };

  const generation = allSettingsGeneration;
  const promise = db.select().from(systemSettings).then((rows: Array<{ key: string; value: string | null }>) => {
    const values: Record<string, string | null> = {};
    for (const row of rows) values[row.key] = row.value ?? null;
    if (generation === allSettingsGeneration) {
      allSettingsCache = { db, expiresAt: Date.now() + ALL_SETTINGS_CACHE_TTL_MS, values };
    }
    return values;
  });
  allSettingsLoad = { db, promise };
  try {
    return { ...await promise };
  } finally {
    if (allSettingsLoad?.promise === promise) allSettingsLoad = null;
  }
}

/** UPSERT 单个系统设置 */
export async function setSetting(key: string, value: string | null): Promise<void> {
  return setSettings({ [key]: value });
}
/** 批量 UPSERT */
export async function setSettings(map: Record<string, string | null>): Promise<void> {
  const entries = Object.entries(map);
  if (!entries.length || !await getDb()) return;
  invalidateAllSettingsCache();
  try {
    const kind = getDatabaseKind();
    const keyColumn = kind === "mysql" ? "`key`" : '"key"';
    const updatedColumn = kind === "mysql" ? "`updatedAt`" : '"updatedAt"';
    const conflict = kind === "mysql"
      ? `ON DUPLICATE KEY UPDATE value=VALUES(value), ${updatedColumn}=VALUES(${updatedColumn})`
      : `ON CONFLICT (${keyColumn}) DO UPDATE SET value=excluded.value, ${updatedColumn}=excluded.${updatedColumn}`;
    const nowSec = Math.floor(Date.now() / 1000);
    // Keep below SQLite's conservative parameter ceiling as well as avoiding
    // huge packets on external databases. Each batch is one atomic statement.
    for (let offset = 0; offset < entries.length; offset += 200) {
      const batch = entries.slice(offset, offset + 200);
      await executeRaw(`INSERT INTO system_settings (${keyColumn}, value, ${updatedColumn}) VALUES ${batch.map(() => "(?, ?, ?)").join(",")} ${conflict}`,
        batch.flatMap(([key, value]) => [key, value, nowSec]));
    }
  } finally {
    invalidateAllSettingsCache();
  }
}

