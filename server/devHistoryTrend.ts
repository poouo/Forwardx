import { randomUUID } from "node:crypto";
import { executeRaw, insertAndGetId, queryRaw, quoteDbIdentifier as q, withDatabaseTransaction } from "./dbRuntime";
import { getSetting, setSetting } from "./repositories/settingsRepository";
import { devAvailabilityPeriods, devProbeTrendSample, uncoveredPeriods } from "./devHistoryTrendData";

/** Additive refresh for existing local databases. Never resets user-edited fixtures. */
export async function seedDevHistoryTrend(now = new Date()) {
  if (process.env.NODE_ENV === "production" || !["1", "true"].includes(process.env.FORWARDX_DEV_PANEL || "")) return;
  const marker = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}:v2`;
  if (await getSetting("devHistoryTrendSeededAt") === marker) return;
  const nowSec = Math.floor(now.getTime() / 1000);
  const first = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29).getTime() / 1000);
  const hosts = await queryRaw<{ id: number }>("SELECT id FROM hosts ORDER BY id LIMIT 8");
  let inserted = 0;
  await withDatabaseTransaction(async () => {
    for (const [index, host] of hosts.entries()) {
      const occupied = await queryRaw<{ startAt: number; endAt: number }>("SELECT startAt, endAt FROM host_availability_intervals WHERE hostId = ? AND endAt > ? AND startAt < ? ORDER BY startAt", [host.id, first, nowSec]);
      for (let day = 29; day >= 0; day--) {
        const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() - day).getTime() / 1000);
        const end = Math.min(nowSec, Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1).getTime() / 1000));
        for (const period of devAvailabilityPeriods(start, end, day + index)) {
          for (const gap of uncoveredPeriods(period.startAt, period.endAt, occupied)) {
            await insertAndGetId("host_availability_intervals", { observationKey: randomUUID(), hostId: host.id, ...period, ...gap,
              offlineIncident: period.offlineIncident && gap.startAt === period.startAt ? 1 : 0 });
            inserted++;
          }
        }
      }
    }
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
    const since = Math.floor(dayStart.getTime() / 1000);
    const services = await queryRaw<{ id: number }>("SELECT id FROM host_probe_services ORDER BY id LIMIT 3");
    const resources = [
      { table: "tcping_stats", key: "ruleId", rows: await queryRaw<{ id: number; hostId: number }>("SELECT id, hostId FROM forward_rules WHERE pendingDelete = 0 ORDER BY id LIMIT 12") },
      { table: "tunnel_latency_stats", key: "tunnelId", rows: await queryRaw<{ id: number }>("SELECT id FROM tunnels ORDER BY id LIMIT 8") },
      { table: "forward_group_latency_stats", key: "groupId", rows: await queryRaw<{ id: number }>("SELECT id FROM forward_groups WHERE groupMode = 'chain' ORDER BY id LIMIT 8") },
      { table: "host_probe_service_stats", key: "serviceId", rows: hosts.flatMap(host => services.map(service => ({ id: service.id, hostId: host.id }))) },
    ];
    for (const resource of resources) for (const [index, row] of resource.rows.entries()) {
      const hostId = "hostId" in row ? Number(row.hostId) : 0;
      const existing = await queryRaw<{ recordedAt: number }>(`SELECT recordedAt FROM ${q(resource.table)} WHERE ${q(resource.key)} = ? AND recordedAt >= ?${resource.key === "serviceId" ? " AND hostId = ?" : ""}`, [row.id, since, ...(resource.key === "serviceId" ? [hostId] : [])]);
      const slots = new Set(existing.map(item => Math.floor(Number(item.recordedAt) / 900)));
      // INSERT in bounded batches rather than thousands of separate DB calls.
      let values: unknown[][] = [];
      const extra = resource.key === "ruleId" || resource.key === "serviceId" ? ["hostId"] : resource.key === "tunnelId" ? ["seriesKey", "seriesLabel"] : [];
      const columns = [resource.key, ...extra, "latencyMs", "isTimeout", "probeCount", "probeSuccesses", "recordedAt"];
      const flush = async () => {
        if (!values.length) return;
        await executeRaw(`INSERT INTO ${q(resource.table)} (${columns.map(q).join(",")}) VALUES ${values.map(value => `(${value.map(() => "?").join(",")})`).join(",")}`, values.flat());
        inserted += values.length;
        values = [];
      };
      for (let at = since; at < nowSec; at += 900) {
        if (slots.has(Math.floor(at / 900))) continue;
        const local = new Date(at * 1000);
        const sample = devProbeTrendSample(local.getHours() * 4 + Math.floor(local.getMinutes() / 15), index);
        values.push([row.id, ...(resource.key === "ruleId" || resource.key === "serviceId" ? [hostId] : resource.key === "tunnelId" ? ["total", "Total latency"] : []),
          sample.latencyMs, sample.isTimeout ? 1 : 0, sample.probeCount, sample.probeSuccesses, at]);
        if (values.length >= 80) await flush();
      }
      await flush();
    }
    await setSetting("devHistoryTrendSeededAt", marker);
  });
  console.log(`[DevPanel] Added history trend fixtures rows=${inserted}; existing data preserved`);
}
