import { asc, desc, eq } from "drizzle-orm";
import {
  hostGroups,
  hostGroupMembers,
  type InsertHostGroup,
  type InsertHostGroupMember,
} from "../../drizzle/schema";
import { getDb, insertAndGetId, nowDate, queryRaw } from "../dbRuntime";
import { inList, quoteIdentifier } from "../dbCompat";

export type HostGroupInput = {
  name: string;
  isEnabled?: boolean;
  sortOrder?: number;
  hostIds?: number[];
  userId: number;
};

function rowDate(value: unknown) {
  if (value instanceof Date) return value;
  const n = Number(value || 0);
  return new Date(n * 1000);
}

function rowBool(value: unknown) {
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function normalizeHostIds(hostIds: unknown[] | undefined) {
  return Array.from(new Set((hostIds || [])
    .map((id) => Math.floor(Number(id)))
    .filter((id) => Number.isInteger(id) && id > 0)));
}

function normalizeSortOrder(value: unknown) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function mapHostGroup(row: any, members: any[] = []) {
  const mappedMembers = members
    .map((member) => ({
      id: Number(member?.id || 0),
      groupId: Number(member?.groupId || 0),
      hostId: Number(member?.hostId || 0),
      sortOrder: normalizeSortOrder(member?.sortOrder),
      createdAt: rowDate(member?.createdAt),
    }))
    .filter((member) => member.id > 0 && member.groupId > 0 && member.hostId > 0)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  return {
    ...row,
    id: Number(row?.id || 0),
    name: String(row?.name || ""),
    isEnabled: rowBool(row?.isEnabled),
    sortOrder: normalizeSortOrder(row?.sortOrder),
    userId: Number(row?.userId || 0),
    createdAt: rowDate(row?.createdAt),
    updatedAt: rowDate(row?.updatedAt),
    members: mappedMembers,
    hostIds: mappedMembers.map((member) => member.hostId),
  };
}

async function getMembersForGroups(groupIds: number[]) {
  const ids = normalizeHostIds(groupIds);
  if (ids.length === 0) return new Map<number, any[]>();
  const q = quoteIdentifier;
  const list = inList(ids);
  const rows = await queryRaw<any>(
    `SELECT *
       FROM ${q("host_group_members")}
      WHERE ${q("groupId")} IN ${list.sql}
      ORDER BY ${q("groupId")} ASC, ${q("sortOrder")} ASC, ${q("id")} ASC`,
    list.params,
  ).catch(() => []);
  const byGroup = new Map<number, any[]>();
  for (const row of rows as any[]) {
    const groupId = Number(row?.groupId || 0);
    if (!groupId) continue;
    const bucket = byGroup.get(groupId);
    if (bucket) bucket.push(row);
    else byGroup.set(groupId, [row]);
  }
  return byGroup;
}

async function replaceHostGroupMembers(groupId: number, hostIds: number[]) {
  const db = await getDb();
  if (!db) return;
  await db.delete(hostGroupMembers).where(eq(hostGroupMembers.groupId, groupId));
  const normalized = normalizeHostIds(hostIds);
  for (const [index, hostId] of normalized.entries()) {
    const payload: InsertHostGroupMember = {
      groupId,
      hostId,
      sortOrder: index,
      createdAt: nowDate(),
    } as InsertHostGroupMember;
    await insertAndGetId("host_group_members", payload as any);
  }
}

export async function getHostGroups(userId?: number) {
  const db = await getDb();
  if (!db) return [];
  const rows = userId
    ? await db.select().from(hostGroups).where(eq(hostGroups.userId, userId)).orderBy(asc(hostGroups.sortOrder), desc(hostGroups.createdAt), desc(hostGroups.id))
    : await db.select().from(hostGroups).orderBy(asc(hostGroups.sortOrder), desc(hostGroups.createdAt), desc(hostGroups.id));
  const membersByGroup = await getMembersForGroups(rows.map((row: any) => Number(row.id)));
  return rows.map((row: any) => mapHostGroup(row, membersByGroup.get(Number(row.id)) || []));
}

export async function getHostGroupById(id: number) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(hostGroups).where(eq(hostGroups.id, id)).limit(1);
  if (!rows[0]) return null;
  const membersByGroup = await getMembersForGroups([id]);
  return mapHostGroup(rows[0], membersByGroup.get(id) || []);
}

export async function createHostGroup(input: HostGroupInput) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const payload: InsertHostGroup = {
    name: input.name.trim(),
    isEnabled: input.isEnabled !== false,
    sortOrder: normalizeSortOrder(input.sortOrder),
    userId: input.userId,
    createdAt: nowDate(),
    updatedAt: nowDate(),
  } as InsertHostGroup;
  const id = await insertAndGetId("host_groups", payload as any);
  await replaceHostGroupMembers(id, input.hostIds || []);
  return id;
}

export async function updateHostGroup(id: number, input: Omit<HostGroupInput, "userId">) {
  const db = await getDb();
  if (!db) return;
  await db.update(hostGroups).set({
    name: input.name.trim(),
    isEnabled: input.isEnabled !== false,
    sortOrder: normalizeSortOrder(input.sortOrder),
    updatedAt: nowDate(),
  }).where(eq(hostGroups.id, id));
  await replaceHostGroupMembers(id, input.hostIds || []);
}

export async function deleteHostGroup(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(hostGroupMembers).where(eq(hostGroupMembers.groupId, id));
  await db.delete(hostGroups).where(eq(hostGroups.id, id));
}
