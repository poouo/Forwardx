import type { QueryClient, QueryKey } from "@tanstack/react-query";
import superjson from "superjson";

// Only presentation data. Never persist auth, permissions, settings or mutations.
const PREFIX = "forwardx.dashboard.v1:";
const MAX_AGE = 24 * 60 * 60_000;
const MAX_BYTES = 200_000;
const paths = new Set(["dashboard.stats", "dashboard.trafficTotals", "dashboard.trafficSeries", "dashboard.trafficBreakdown"]);
type Entry = { key: QueryKey; data: unknown; at: number };
type Snapshot = { version: 1; scope: string; entries: Entry[] };

export function queryPath(key: QueryKey): string {
  return Array.isArray(key[0]) ? key[0].join(".") : "";
}

export function dashboardCacheScope(panel: string, user: { id: number; username?: string | null; createdAt?: unknown; role?: string } | null | undefined) {
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return "";
  return JSON.stringify([panel.replace(/\/+$/, ""), user.id, user.username, user.createdAt, user.role]);
}

function storage() { try { return globalThis.localStorage; } catch { return undefined; } }
function eligible(key: QueryKey) {
  if (!paths.has(queryPath(key))) return false;
  const options = key[1] as { type?: string; input?: unknown } | undefined;
  if (options?.type !== "query") return false;
  const path = queryPath(key);
  if (path === "dashboard.stats" || path === "dashboard.trafficTotals") return options.input === undefined;
  const input = options.input as Record<string, unknown> | undefined;
  return !!input && input.hours === 24 && Object.keys(input).length === 2 &&
    (path === "dashboard.trafficSeries" ? input.bucketMinutes === 60 : input.limit === 30);
}

function validPresentation(key: QueryKey, data: unknown): boolean {
  const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
  const numeric = (value: unknown) => value === undefined ||
    ((typeof value === "number" || typeof value === "string") && Number.isFinite(Number(value)));
  switch (queryPath(key)) {
    case "dashboard.stats": return record(data) && ["totalRules", "activeRules", "totalHosts", "onlineHosts"].every(field => numeric(data[field]));
    case "dashboard.trafficTotals": return record(data) && ["totalTrafficIn", "totalTrafficOut"].every(field => numeric(data[field]));
    case "dashboard.trafficSeries": return Array.isArray(data) && data.length <= 200 && data.every(point => record(point) &&
      (typeof point.bucket === "string" || point.bucket instanceof Date) && numeric(point.bytesIn) && numeric(point.bytesOut));
    case "dashboard.trafficBreakdown": return record(data) && ["tunnelRules", "portRules", "forwardGroupRules"].every(field =>
      data[field] === undefined || (Array.isArray(data[field]) && data[field].length <= 100 && data[field].every((row: unknown) =>
        record(row) && (row.name == null || typeof row.name === "string") && numeric(row.id) && numeric(row.totalBytes))));
    default: return false;
  }
}

export function readDashboardSnapshot(scope: string, now = Date.now()): Entry[] {
  if (!scope) return [];
  try {
    const raw = storage()?.getItem(PREFIX + scope);
    if (!raw || raw.length > MAX_BYTES) return [];
    const snapshot = superjson.parse<Snapshot>(raw);
    if (snapshot.version !== 1 || snapshot.scope !== scope || !Array.isArray(snapshot.entries) || snapshot.entries.length > 4) return [];
    return snapshot.entries.filter(entry => Array.isArray(entry.key) && eligible(entry.key) && validPresentation(entry.key, entry.data) &&
      Number.isFinite(entry.at) && entry.at <= now && now - entry.at < MAX_AGE);
  } catch { return []; }
}

/** Installed before requests start. Restore only AFTER auth.me confirms the identity. */
export function installDashboardCache(client: QueryClient, panel: () => string) {
  let scope = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let restoring = false;
  const clear = () => {
    clearTimeout(timer);
    scope = "";
    try {
      const target = storage();
      if (!target) return;
      for (let i = target.length - 1; i >= 0; i--) {
        const key = target.key(i);
        if (key?.startsWith(PREFIX) || key?.startsWith("forwardx.stat.")) target.removeItem(key);
      }
    } catch { /* Private mode/quota errors must never affect navigation. */ }
  };
  const unsubscribe = client.getQueryCache().subscribe(event => {
    if (event.type !== "updated" || event.action.type !== "success") return;
    const path = queryPath(event.query.queryKey);
    if (path === "auth.me") {
      if (event.action.manual) return; // setQueryData is not server verification.
      const next = dashboardCacheScope(panel(), event.query.state.data as Parameters<typeof dashboardCacheScope>[1]);
      if (next && next === scope) return;
      // A different identity must never inherit either the in-memory or disk snapshot.
      if (scope || !next) {
        clear();
        for (const query of client.getQueryCache().getAll()) {
          if (paths.has(queryPath(query.queryKey))) client.removeQueries({ queryKey: query.queryKey, exact: true });
        }
      }
      scope = next;
      restoring = true;
      for (const entry of readDashboardSnapshot(scope)) {
        if ((client.getQueryState(entry.key)?.dataUpdatedAt ?? 0) >= entry.at) continue;
        client.setQueryData(entry.key, entry.data, { updatedAt: entry.at });
        // Even a seconds-old snapshot must be checked against the server.
        client.getQueryCache().find({ queryKey: entry.key, exact: true })?.invalidate();
      }
      restoring = false;
      return;
    }
    if (!scope || restoring || !eligible(event.query.queryKey) || event.action.manual) return;
    clearTimeout(timer);
    // Coalesce parallel responses; do not serialize/write on the render hot path.
    timer = setTimeout(() => {
      try {
        const entries = client.getQueryCache().getAll().filter(query => eligible(query.queryKey) && query.state.data !== undefined)
          .map(query => ({ key: query.queryKey, data: query.state.data, at: query.state.dataUpdatedAt }));
        const raw = superjson.stringify({ version: 1, scope, entries });
        if (raw.length <= MAX_BYTES) storage()?.setItem(PREFIX + scope, raw);
      } catch { /* Best-effort presentation cache only. */ }
    }, 250);
  });
  return { clear, dispose() { clearTimeout(timer); unsubscribe(); } };
}
