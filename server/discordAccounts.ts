import { and, eq } from "drizzle-orm";
import { users } from "../drizzle/schema";
import { getDb, getDatabaseKind, nowDate, queryRaw, withDatabaseTransaction } from "./dbRuntime";
import { quoteIdentifier } from "./dbCompat";
import { isDiscordSnowflake } from "./discordIdentity";

export function discordBotUser(user: any) {
  if (!user) return user;
  // Only the shared bot presentation layer sees these aliases. Stored Telegram
  // identifiers and authentication codes are never reused for Discord.
  return { ...user, telegramId: user.discordId, telegramUsername: user.discordUsername,
    telegramFirstName: null, telegramLastName: null, telegramLinkedAt: user.discordLinkedAt,
    telegramLastSeenAt: user.discordLastSeenAt, telegramBindCode: user.discordBindCode,
    telegramBindCodeExpiresAt: user.discordBindCodeExpiresAt };
}
export async function getDiscordUser(field: "discordId" | "discordBindCode", value: string) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return (await db.select().from(users).where(eq(users[field], value)).limit(1))[0];
}
export async function createDiscordCode(userId: number, code: string, expiresAt: Date, kind: "Bind" | "Login") {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  await db.update(users).set({ [`discord${kind}Code`]: code, [`discord${kind}CodeExpiresAt`]: expiresAt, updatedAt: nowDate() }).where(eq(users.id, userId));
}
export async function clearDiscordBindCode(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  await db.update(users).set({ discordBindCode: null, discordBindCodeExpiresAt: null }).where(eq(users.id, userId));
}
export async function bindDiscordAccount(userId: number, identity: { id: string; username?: string | null }, code: string) {
  if (!isDiscordSnowflake(identity.id)) throw new Error("Invalid Discord identity");
  return withDatabaseTransaction(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const q = quoteIdentifier;
    await queryRaw(`SELECT ${q("id")} FROM ${q("users")} WHERE ${q("id")} = ?${getDatabaseKind() === "sqlite" ? "" : " FOR UPDATE"}`, [userId]);
    const user = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
    if (!user || user.accountEnabled === false || user.discordBindCode !== code || new Date(user.discordBindCodeExpiresAt || 0).getTime() <= Date.now()) throw new Error("绑定码无效或已过期");
    const existing = await getDiscordUser("discordId", identity.id);
    if (existing && Number(existing.id) !== userId) throw new Error("该 Discord 已绑定其他账号，请先解除绑定");
    if (user.discordId && user.discordId !== identity.id) throw new Error("该账号已绑定其他 Discord，请先解除绑定");
    await db.update(users).set({ discordId: identity.id, discordUsername: identity.username || null,
      discordLinkedAt: nowDate(), discordLastSeenAt: nowDate(), discordBindCode: null, discordBindCodeExpiresAt: null,
      discordLoginCode: null, discordLoginCodeExpiresAt: null, updatedAt: nowDate() }).where(eq(users.id, userId));
  });
}
export async function updateDiscordLastSeen(id: string, identity?: { username?: string | null }) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  await db.update(users).set({ discordLastSeenAt: nowDate(), ...(identity ? { discordUsername: identity.username || null } : {}) }).where(eq(users.discordId, id));
}
export async function unbindDiscordAccount(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  await db.update(users).set({ discordId: null, discordUsername: null, discordLinkedAt: null, discordLastSeenAt: null,
    discordBindCode: null, discordBindCodeExpiresAt: null, discordLoginCode: null, discordLoginCodeExpiresAt: null,
    discordAnnouncementSubscribed: false, updatedAt: nowDate() }).where(eq(users.id, userId));
}
export async function consumeDiscordLoginCode(code: string) {
  return withDatabaseTransaction(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const q = quoteIdentifier;
    const rows = await queryRaw<{ id: number }>(`SELECT ${q("id")} FROM ${q("users")} WHERE ${q("discordLoginCode")} = ?${getDatabaseKind() === "sqlite" ? "" : " FOR UPDATE"}`, [code]);
    if (!rows[0]) return null;
    const user = (await db.select().from(users).where(eq(users.id, rows[0].id)).limit(1))[0];
    const valid = user?.discordId && user.accountEnabled !== false && new Date(user.discordLoginCodeExpiresAt || 0).getTime() > Date.now();
    await db.update(users).set({ discordLoginCode: null, discordLoginCodeExpiresAt: null }).where(and(eq(users.id, rows[0].id), eq(users.discordLoginCode, code)));
    return valid ? user : null;
  });
}
