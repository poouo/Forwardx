import { and, desc, eq } from "drizzle-orm";
import { forwardTests, InsertForwardTest, tunnelLatencyStats } from "../../drizzle/schema";
import { executeRaw, getDb, insertAndGetId, nowDate, queryRaw, rawAffectedRows } from "../dbRuntime";
import { quoteIdentifier } from "../dbCompat";

// ==================== Forward Tests ====================

export async function createForwardTest(data: InsertForwardTest) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return insertAndGetId("forward_tests", data as any);
}

export async function getPendingForwardTestsByHost(hostId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(forwardTests)
    .where(and(eq(forwardTests.hostId, hostId), eq(forwardTests.status, "pending")));
}

export async function markForwardTestRunning(id: number) {
  const db = await getDb();
  if (!db) return false;
  const q = quoteIdentifier;
  const result = await executeRaw(
    `UPDATE ${q("forward_tests")}
     SET ${q("status")} = 'running',
         ${q("updatedAt")} = ?
     WHERE ${q("id")} = ?
       AND ${q("status")} = 'pending'`,
    [nowDate(), id],
  );
  return rawAffectedRows(result) > 0;
}

export async function updateForwardTestResult(
  id: number,
  data: {
    status: "success" | "failed" | "timeout";
    listenOk?: boolean;
    targetReachable?: boolean;
    forwardOk?: boolean;
    latencyMs?: number | null;
    message?: string | null;
  }
) {
  const db = await getDb();
  if (!db) return;
  await db.update(forwardTests).set({ ...data, updatedAt: nowDate() } as any).where(eq(forwardTests.id, id));
}

export async function getLatestTunnelLatency(tunnelId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select()
    .from(tunnelLatencyStats)
    .where(eq(tunnelLatencyStats.tunnelId, tunnelId))
    .orderBy(desc(tunnelLatencyStats.recordedAt))
    .limit(1);
  return rows[0];
}

export async function getLatestForwardTest(ruleId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const table = quoteIdentifier("forward_tests");
  const ruleCol = quoteIdentifier("ruleId");
  const statusCol = quoteIdentifier("status");
  const updatedCol = quoteIdentifier("updatedAt");
  const createdCol = quoteIdentifier("createdAt");
  const messageCol = quoteIdentifier("message");
  const pendingRows = await queryRaw<any>(
    `SELECT * FROM ${table} WHERE ${ruleCol} = ? AND ${statusCol} IN ('pending', 'running') ORDER BY ${updatedCol} DESC, ${createdCol} DESC LIMIT 1`,
    [ruleId],
  );
  if (pendingRows[0]) return pendingRows[0];
  const rows = await queryRaw<any>(
    `SELECT * FROM ${table} WHERE ${ruleCol} = ? ORDER BY ${updatedCol} DESC, CASE WHEN ${messageCol} LIKE '%forward-chain-hop-summary%' OR ${messageCol} LIKE '%"kind":"forward-via-tunnel"%' THEN 0 ELSE 1 END, ${createdCol} DESC LIMIT 1`,
    [ruleId],
  );
  return rows[0];
}

export async function getForwardTestById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(forwardTests).where(eq(forwardTests.id, id)).limit(1);
  return rows[0];
}

export async function cleanOldForwardTests(retainHours = 72) {
  const cutoff = Math.floor((Date.now() - retainHours * 3600 * 1000) / 1000);
  await executeRaw(
    `DELETE FROM ${quoteIdentifier("forward_tests")} WHERE ${quoteIdentifier("updatedAt")} < ?`,
    [cutoff],
  );
}

