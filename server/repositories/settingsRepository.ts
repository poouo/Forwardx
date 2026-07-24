import { eq } from "drizzle-orm";
import { systemSettings } from "../../drizzle/schema";
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
  const db = await getDb();
  if (!db) return;
  invalidateAllSettingsCache();
  const nowSec = Math.floor(Date.now() / 1000);
  if (getDatabaseKind() === "sqlite") {
    await executeRaw(
      "INSERT INTO system_settings (key, value, updatedAt) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt",
      [key, value, nowSec],
    );
  } else if (getDatabaseKind() === "postgresql") {
    await executeRaw(
      'INSERT INTO system_settings ("key", value, "updatedAt") VALUES (?, ?, ?) ON CONFLICT ("key") DO UPDATE SET value=excluded.value, "updatedAt"=excluded."updatedAt"',
      [key, value, nowSec],
    );
  } else {
    await executeRaw(
      "INSERT INTO system_settings (`key`, value, updatedAt) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value), updatedAt=VALUES(updatedAt)",
      [key, value, nowSec],
    );
  }
  invalidateAllSettingsCache();
}
/** 批量 UPSERT */
export async function setSettings(map: Record<string, string | null>): Promise<void> {
  for (const [k, v] of Object.entries(map)) {
    await setSetting(k, v);
  }
}

