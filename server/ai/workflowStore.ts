import { createHash, randomUUID } from "node:crypto";
import { executeRaw, getDatabaseKind, queryRaw, quoteDbIdentifier as q, rawAffectedRows, withDatabaseTransaction } from "../dbRuntime";

export type BotScope = { provider: "telegram" | "discord"; chatId: string | number; actorUserId: number };
export type StoredBotAction<T> = { id: string; status: string; payload: T; result: string | null; updatedAt: number };
export function botScopeKey(scope: BotScope) {
  if (!Number.isSafeInteger(scope.actorUserId) || scope.actorUserId <= 0) throw new Error("AI 操作用户无效");
  return createHash("sha256").update(JSON.stringify([scope.provider, String(scope.chatId), scope.actorUserId])).digest("hex");
}
function draftId(scope: BotScope) { return `draft-${botScopeKey(scope)}`; }
const table = () => q("ai_bot_workflows");

async function put(scope: BotScope, id: string, status: string, payload: unknown, result: string | null = null) {
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded) > 64 * 1024) throw new Error("AI 待办信息过长，请拆分操作");
  const columns = ["id", "scopeKey", "status", "payload", "result", "updatedAt"];
  const updates = ["status", "payload", "result", "updatedAt"];
  const conflict = getDatabaseKind() === "mysql"
    ? `ON DUPLICATE KEY UPDATE ${updates.map((c) => `${q(c)} = VALUES(${q(c)})`).join(", ")}`
    : `ON CONFLICT (${q("id")}) DO UPDATE SET ${updates.map((c) => `${q(c)} = excluded.${q(c)}`).join(", ")}`;
  await executeRaw(`INSERT INTO ${table()} (${columns.map(q).join(", ")}) VALUES (?, ?, ?, ?, ?, ?) ${conflict}`,
    [id, botScopeKey(scope), status, encoded, result, Date.now()]);
}
export async function saveBotDraft<T>(scope: BotScope, payload: T) {
  await put(scope, draftId(scope), "draft", payload);
}
export async function readBotAction<T>(scope: BotScope, id: string): Promise<StoredBotAction<T> | null> {
  const rows = await queryRaw<any>(`SELECT * FROM ${table()} WHERE ${q("id")} = ? AND ${q("scopeKey")} = ?`, [id, botScopeKey(scope)]);
  if (!rows[0]) return null;
  return { id, status: rows[0].status, payload: JSON.parse(rows[0].payload), result: rows[0].result, updatedAt: Number(rows[0].updatedAt) };
}
export async function readBotDraft<T>(scope: BotScope) {
  return (await readBotAction<T>(scope, draftId(scope)))?.payload ?? null;
}
export async function clearBotDraft(scope: BotScope) {
  await executeRaw(`DELETE FROM ${table()} WHERE ${q("id")} = ? AND ${q("scopeKey")} = ?`, [draftId(scope), botScopeKey(scope)]);
}
export async function createBotAction<T>(scope: BotScope, payload: T) {
  const id = randomUUID().replace(/-/g, "").slice(0, 24);
  await put(scope, id, "pending", payload);
  return id;
}
/** A durable compare-and-swap, not an in-memory lock. Never replay a claimed write after restart. */
export async function claimBotAction<T>(scope: BotScope, id: string): Promise<T | null> {
  return withDatabaseTransaction(async () => {
    const changed = await executeRaw(`UPDATE ${table()} SET ${q("status")} = 'executing', ${q("updatedAt")} = ? WHERE ${q("id")} = ? AND ${q("scopeKey")} = ? AND ${q("status")} = 'pending'`, [Date.now(), id, botScopeKey(scope)]);
    if (rawAffectedRows(changed) !== 1) return null;
    return (await readBotAction<T>(scope, id))!.payload;
  });
}
export async function finishBotAction(scope: BotScope, id: string, status: "succeeded" | "uncertain" | "cancelled" | "rejected", result: string) {
  const allowed = status === "cancelled" ? "('pending')" : "('executing')";
  const changed = await executeRaw(`UPDATE ${table()} SET ${q("status")} = ?, ${q("result")} = ?, ${q("updatedAt")} = ? WHERE ${q("id")} = ? AND ${q("scopeKey")} = ? AND ${q("status")} IN ${allowed}`,
    [status, result.slice(0, 12000), Date.now(), id, botScopeKey(scope)]);
  return rawAffectedRows(changed) === 1;
}
let lastPruneAt = 0;
export async function pruneBotWorkflowHistory() {
  if (Date.now() - lastPruneAt < 60_000) return;
  lastPruneAt = Date.now();
  // Unfinished drafts and ambiguous/executing writes are deliberately retained.
  // Bounded batches avoid a large synchronous SQLite delete on the chat path.
  const rows = await queryRaw<{ id: string }>(`SELECT ${q("id")} FROM ${table()} WHERE ${q("status")} IN ('succeeded', 'cancelled', 'pending', 'rejected') AND ${q("updatedAt")} < ? ORDER BY ${q("updatedAt")} LIMIT 500`, [Date.now() - 30 * 86400_000]);
  if (rows.length) await executeRaw(`DELETE FROM ${table()} WHERE ${q("id")} IN (${rows.map(() => "?").join(", ")}) AND ${q("status")} IN ('succeeded', 'cancelled', 'pending', 'rejected')`, rows.map((row) => row.id));
}
