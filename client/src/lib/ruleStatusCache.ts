/**
 * Last-known visual state for forwarding rules.
 *
 * The panel deliberately keeps this cache separate from rule/config data. A
 * rule can be rendered immediately with its last reported state while the
 * next status query is in flight, without changing the authoritative value
 * stored by the server.
 */

export const RULE_STATUS_CACHE_VERSION = 1;
export const RULE_STATUS_CACHE_STORAGE_PREFIX = "forwardx.rules.visualStatus.v1.";

export type RuleVisualStatusState = "disabled" | "running" | "pending" | "error";

export type RuleVisualStatusSnapshot = {
  state: RuleVisualStatusState;
  title: string;
  updatedAt: number;
};

export type RuleVisualStatusSnapshotInput = {
  state: RuleVisualStatusState;
  title?: unknown;
  updatedAt?: unknown;
};

type StoredRuleStatusCache = {
  version: number;
  entries: Record<string, RuleVisualStatusSnapshot>;
};

const VALID_STATES = new Set<RuleVisualStatusState>([
  "disabled",
  "running",
  "pending",
  "error",
]);
const MAX_TITLE_LENGTH = 512;
// Keep localStorage bounded even if a user has accumulated many deleted rules.
const MAX_CACHED_RULES = 2_000;

const memoryCacheByUser = new Map<string, Map<number, RuleVisualStatusSnapshot>>();
const storageLoadedUsers = new Set<string>();

function normalizeUserId(value: unknown) {
  if (value === null || value === undefined) return null;
  const key = String(value).trim();
  return key ? key : null;
}

function normalizeRuleId(value: unknown) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function normalizeTimestamp(value: unknown, fallback = 0) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : fallback;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) return fallback;
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    }
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
  return fallback;
}

export function normalizeRuleStatusSnapshot(value: unknown, fallbackUpdatedAt = 0): RuleVisualStatusSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const state = String(source.state || "").trim().toLowerCase() as RuleVisualStatusState;
  if (!VALID_STATES.has(state)) return null;
  const updatedAt = normalizeTimestamp(source.updatedAt, fallbackUpdatedAt);
  if (!updatedAt) return null;
  const title = String(source.title ?? "").slice(0, MAX_TITLE_LENGTH);
  return { state, title, updatedAt };
}

function storageForClient(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage || null;
  } catch {
    // Safari private browsing and restrictive iframe policies can throw while
    // reading localStorage. The in-memory cache remains usable in that case.
    return null;
  }
}

function storageKey(userKey: string) {
  return `${RULE_STATUS_CACHE_STORAGE_PREFIX}${encodeURIComponent(userKey)}`;
}

function parseStoredCache(raw: string | null): Map<number, RuleVisualStatusSnapshot> {
  if (!raw) return new Map();
  try {
    const parsed = JSON.parse(raw) as Partial<StoredRuleStatusCache> | Record<string, unknown>;
    const source = parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object"
      ? parsed.entries as Record<string, unknown>
      : parsed as Record<string, unknown>;
    const result = new Map<number, RuleVisualStatusSnapshot>();
    Object.entries(source || {}).forEach(([rawRuleId, value]) => {
      const ruleId = normalizeRuleId(rawRuleId);
      const snapshot = normalizeRuleStatusSnapshot(value);
      if (ruleId && snapshot) result.set(ruleId, snapshot);
    });
    return result;
  } catch {
    return new Map();
  }
}

function mergeSnapshots(
  target: Map<number, RuleVisualStatusSnapshot>,
  source: ReadonlyMap<number, RuleVisualStatusSnapshot>,
) {
  source.forEach((snapshot, ruleId) => {
    const current = target.get(ruleId);
    if (!current || snapshot.updatedAt > current.updatedAt) {
      target.set(ruleId, { ...snapshot });
    }
  });
}

function getUserCache(userId: unknown, loadStorage = true) {
  const userKey = normalizeUserId(userId);
  if (!userKey) return { userKey: null, cache: null as Map<number, RuleVisualStatusSnapshot> | null };
  let cache = memoryCacheByUser.get(userKey);
  if (!cache) {
    cache = new Map<number, RuleVisualStatusSnapshot>();
    memoryCacheByUser.set(userKey, cache);
  }
  if (loadStorage && !storageLoadedUsers.has(userKey)) {
    storageLoadedUsers.add(userKey);
    const storage = storageForClient();
    if (storage) {
      try {
        mergeSnapshots(cache, parseStoredCache(storage.getItem(storageKey(userKey))));
        trimCache(cache);
      } catch {
        // A broken Storage implementation should not affect rendering.
      }
    }
  }
  return { userKey, cache };
}

function trimCache(cache: Map<number, RuleVisualStatusSnapshot>) {
  if (cache.size <= MAX_CACHED_RULES) return;
  const keep = Array.from(cache.entries())
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_CACHED_RULES);
  cache.clear();
  keep.forEach(([ruleId, snapshot]) => cache.set(ruleId, snapshot));
}

function persistUserCache(userKey: string, cache: Map<number, RuleVisualStatusSnapshot>) {
  trimCache(cache);
  const storage = storageForClient();
  if (!storage) return;
  const entries: Record<string, RuleVisualStatusSnapshot> = {};
  cache.forEach((snapshot, ruleId) => {
    entries[String(ruleId)] = { ...snapshot };
  });
  const payload: StoredRuleStatusCache = {
    version: RULE_STATUS_CACHE_VERSION,
    entries,
  };
  try {
    storage.setItem(storageKey(userKey), JSON.stringify(payload));
  } catch {
    // Quota/security errors are expected in some browsers. Memory remains the
    // source for the current page and the next server response can still win.
  }
}

/** Read one last-known visual status for a rule. */
export function readRuleStatusSnapshot(userId: unknown, ruleId: unknown): RuleVisualStatusSnapshot | null {
  const normalizedRuleId = normalizeRuleId(ruleId);
  if (!normalizedRuleId) return null;
  const { cache } = getUserCache(userId);
  const snapshot = cache?.get(normalizedRuleId);
  return snapshot ? { ...snapshot } : null;
}

/**
 * Read snapshots for the requested rules. If ruleIds is omitted, all cached
 * rules for the current user are returned.
 */
export function readRuleStatusSnapshots(
  userId: unknown,
  ruleIds?: Iterable<number>,
): Map<number, RuleVisualStatusSnapshot> {
  const { cache } = getUserCache(userId);
  const result = new Map<number, RuleVisualStatusSnapshot>();
  if (!cache) return result;
  if (ruleIds === undefined) {
    cache.forEach((snapshot, ruleId) => result.set(ruleId, { ...snapshot }));
    return result;
  }
  for (const rawRuleId of ruleIds) {
    const ruleId = normalizeRuleId(rawRuleId);
    const snapshot = ruleId ? cache.get(ruleId) : undefined;
    if (snapshot) result.set(ruleId, { ...snapshot });
  }
  return result;
}

/** Store one visual status. Invalid input is ignored and returns false. */
export function writeRuleStatusSnapshot(
  userId: unknown,
  ruleId: unknown,
  input: RuleVisualStatusSnapshotInput,
): boolean {
  const normalizedRuleId = normalizeRuleId(ruleId);
  const userKey = normalizeUserId(userId);
  if (!normalizedRuleId || !userKey) return false;
  const snapshot = normalizeRuleStatusSnapshot({
    ...input,
    updatedAt: input?.updatedAt ?? Date.now(),
  }, Date.now());
  if (!snapshot) return false;
  const { cache } = getUserCache(userKey);
  if (!cache) return false;
  const current = cache.get(normalizedRuleId);
  if (current && current.updatedAt > snapshot.updatedAt) return false;
  cache.set(normalizedRuleId, snapshot);
  persistUserCache(userKey, cache);
  return true;
}

/** Store a batch of visual statuses in one localStorage write. */
export function writeRuleStatusSnapshots(
  userId: unknown,
  snapshots: ReadonlyMap<number, RuleVisualStatusSnapshotInput> | Iterable<readonly [number, RuleVisualStatusSnapshotInput]>,
): number {
  const userKey = normalizeUserId(userId);
  if (!userKey) return 0;
  const { cache } = getUserCache(userKey);
  if (!cache) return 0;
  let written = 0;
  const entries = snapshots instanceof Map ? snapshots.entries() : snapshots;
  for (const [rawRuleId, input] of entries) {
    const ruleId = normalizeRuleId(rawRuleId);
    if (!ruleId || !input) continue;
    const snapshot = normalizeRuleStatusSnapshot({
      ...input,
      updatedAt: input.updatedAt ?? Date.now(),
    }, Date.now());
    if (!snapshot) continue;
    const current = cache.get(ruleId);
    if (current && current.updatedAt > snapshot.updatedAt) continue;
    cache.set(ruleId, snapshot);
    written += 1;
  }
  if (written > 0) persistUserCache(userKey, cache);
  return written;
}

/** Remove selected rules, or the entire user's cache when ruleIds is omitted. */
export function clearRuleStatusSnapshots(userId: unknown, ruleIds?: Iterable<number>): number {
  const userKey = normalizeUserId(userId);
  if (!userKey) return 0;
  // Load a persisted cache before selective cleanup. This matters after a
  // full page reload where the in-memory map has not been populated yet.
  const cache = ruleIds === undefined
    ? memoryCacheByUser.get(userKey)
    : getUserCache(userKey).cache;
  const storage = storageForClient();
  if (ruleIds === undefined) {
    const removed = cache?.size || 0;
    memoryCacheByUser.delete(userKey);
    storageLoadedUsers.delete(userKey);
    try {
      storage?.removeItem(storageKey(userKey));
    } catch {
      // Ignore storage failures.
    }
    return removed;
  }
  if (!cache) return 0;
  let removed = 0;
  for (const rawRuleId of ruleIds) {
    const ruleId = normalizeRuleId(rawRuleId);
    if (ruleId && cache.delete(ruleId)) removed += 1;
  }
  if (cache.size === 0) {
    memoryCacheByUser.delete(userKey);
    try {
      storage?.removeItem(storageKey(userKey));
    } catch {
      // Ignore storage failures.
    }
  } else {
    persistUserCache(userKey, cache);
  }
  return removed;
}

// Short aliases keep call sites readable while retaining the explicit exports
// above for consumers that prefer the full name.
export const getRuleStatusSnapshot = readRuleStatusSnapshot;
export const getRuleStatusSnapshots = readRuleStatusSnapshots;
export const setRuleStatusSnapshot = writeRuleStatusSnapshot;
export const setRuleStatusSnapshots = writeRuleStatusSnapshots;
export const clearRuleStatusCache = clearRuleStatusSnapshots;
