import { createHash, randomBytes } from "node:crypto";
import { executeRaw, insertAndGetId, queryRaw } from "./dbRuntime";
import { quoteIdentifier as q } from "./dbCompat";
import { withKeyedTaskLock } from "./keyedTaskLock";

export async function listMcpTokens(userId: number) {
  // The dialect is not known when this module is imported during startup.
  // MySQL treats precomputed double-quoted field names as string literals.
  const fields = ["id", "name", "prefix", "expiresAt", "createdAt", "lastUsedAt"].map(q).join(",");
  return queryRaw<any>(`SELECT ${fields} FROM ${q("external_mcp_tokens")} WHERE ${q("userId")} = ? ORDER BY ${q("id")} DESC`, [userId]);
}
export async function createMcpToken(userId: number, name: string, days: number) {
  return withKeyedTaskLock(`mcp-tokens:${userId}`, async () => {
    const now = Math.floor(Date.now() / 1000);
    await executeRaw(`DELETE FROM ${q("external_mcp_tokens")} WHERE ${q("userId")} = ? AND ${q("expiresAt")} <= ?`, [userId, now]);
    if ((await listMcpTokens(userId)).length >= 10) throw new Error("最多保留 10 个有效 MCP 令牌，请先撤销旧令牌");
    const token = `fxm_${randomBytes(32).toString("hex")}`;
    const id = await insertAndGetId("external_mcp_tokens", { userId, name, prefix: token.slice(0, 12), tokenHash: hashMcpToken(token), createdAt: now, expiresAt: now + days * 86400 });
    return { id, token, expiresAt: now + days * 86400 };
  });
}
export const hashMcpToken = (value: string) => createHash("sha256").update(value).digest("hex");
export async function revokeMcpToken(userId: number, id: number) {
  await executeRaw(`DELETE FROM ${q("external_mcp_tokens")} WHERE ${q("id")} = ? AND ${q("userId")} = ?`, [id, userId]);
}
export async function resolveMcpToken(value: string) {
  if (!/^fxm_[a-f0-9]{64}$/.test(value)) return null;
  const [row] = await queryRaw<any>(`SELECT ${q("id")}, ${q("userId")}, ${q("lastUsedAt")} FROM ${q("external_mcp_tokens")} WHERE ${q("tokenHash")} = ? AND ${q("expiresAt")} > ?`, [hashMcpToken(value), Math.floor(Date.now() / 1000)]);
  return row || null;
}
