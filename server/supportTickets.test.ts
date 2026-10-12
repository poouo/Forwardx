import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeSidebarMenuSettings } from "../shared/sidebarMenu";
import { validateTicketAttachments } from "./supportTicketAttachments";

const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), "forwardx-support-tests-"),
);
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = path.join(directory, "support.sqlite");
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
let runtime: typeof import("./dbRuntime");
let settings: typeof import("./repositories/settingsRepository");
let repo: typeof import("./repositories/supportTicketRepository");
let router: typeof import("./routers/supportTickets").supportTicketsRouter;
const admin = { id: 1, role: "admin", name: "Staff", username: "staff" };
const user = { id: 2, role: "user", name: "Customer", username: "customer" };
const stranger = { id: 3, role: "user", name: "Other", username: "other" };
const secondAdmin = {
  id: 4,
  role: "admin",
  name: "Staff 2",
  username: "staff2",
};
function caller(actor: typeof user | null) {
  return router.createCaller({
    user: actor as any,
    req: { headers: {} } as any,
    res: { clearCookie() {} } as any,
    authSession: null,
    authFailureReason: null,
  });
}
const input = (extra = {}) => ({
  title: "Connection issue",
  content: "Please investigate",
  category: "technical" as const,
  priority: "normal" as const,
  ...extra,
});
const textFile = {
  name: "diagnostic.log",
  mime: "text/plain",
  base64: Buffer.from("safe diagnostic\nline 2").toString("base64"),
};
before(async () => {
  runtime = await import("./dbRuntime");
  await runtime.connectDatabase({
    type: "sqlite",
    sqlite: { path: process.env.SQLITE_PATH! },
  });
  await (await import("./dbSchema")).ensureDatabaseSchema();
  settings = await import("./repositories/settingsRepository");
  repo = await import("./repositories/supportTicketRepository");
  router = (await import("./routers/supportTickets")).supportTicketsRouter;
  for (const actor of [
    admin,
    user,
    stranger,
    secondAdmin,
    { id: 5, role: "user", username: "limits" },
    { id: 6, role: "user", username: "race" },
  ])
    await runtime.insertAndGetId("users", { ...actor, password: "unused" });
});
after(async () => {
  await runtime?.closeDatabase();
  // Delete only the explicit mkdtemp-created test directory, never project data.
  assert.equal(
    path.dirname(path.resolve(directory)),
    path.resolve(os.tmpdir()),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.rmSync(directory, { recursive: true, force: true });
});

test("tickets are opt-in and disabling blocks every data endpoint without destroying history", async () => {
  assert.equal(normalizeSidebarMenuSettings().tickets, false);
  assert.equal(
    normalizeSidebarMenuSettings({ dashboard: false }).tickets,
    false,
  );
  assert.deepEqual(await caller(user).status(), { enabled: false });
  await assert.rejects(() => caller(user).create(input()), {
    code: "FORBIDDEN",
  });
  await assert.rejects(() => caller(admin).list({ page: 1 }), {
    code: "FORBIDDEN",
  });
  await settings.setSetting("sidebarMenu", JSON.stringify({ tickets: true }));
  const created = await caller(user).create(input());
  await settings.setSetting("sidebarMenu", JSON.stringify({ tickets: false }));
  for (const call of [
    () => caller(user).detail(created),
    () => caller(user).messages(created),
    () => caller(user).markRead({ ...created, version: 1 }),
    () => caller(user).summary(),
    () => caller(admin).cannedReplies(),
    () => caller(user).services({}),
  ])
    await assert.rejects(call, { code: "FORBIDDEN" });
  await settings.setSetting("sidebarMenu", JSON.stringify({ tickets: true }));
  assert.equal((await caller(user).detail(created)).title, "Connection issue");
});

test("optional service, plain text, attachments and strict owner isolation", async () => {
  const created = await caller(user).create(
    input({ content: '<script>alert("x")</script>', attachments: [textFile] }),
  );
  const ticket = await caller(user).detail(created);
  assert.equal(ticket.serviceId, null);
  const messages = await caller(user).messages(created);
  assert.equal(messages.items[0].content, '<script>alert("x")</script>');
  const attachmentId = messages.items[0].attachments[0].id;
  assert.equal(
    (await caller(user).attachment({ id: attachmentId })).base64,
    textFile.base64,
  );
  assert.equal((await caller(stranger).list({ page: 1 })).total, 0);
  for (const call of [
    () => caller(stranger).detail(created),
    () => caller(stranger).messages(created),
    () => caller(stranger).attachment({ id: attachmentId }),
    () => caller(stranger).markRead({ ...created, version: 1 }),
    () =>
      caller(stranger).reply({ ...created, version: 1, content: "intrusion" }),
    () => caller(stranger).update({ ...created, version: 1, status: "closed" }),
    () => caller(stranger).rate({ ...created, version: 1, rating: 5 }),
    () => caller(user).delete({ ...created, version: 1 }),
    () => caller(null).detail(created),
  ])
    await assert.rejects(call);
  for (const call of [
    () => caller(user).staff(),
    () => caller(user).cannedReplies(),
    () => caller(user).saveCannedReply({ title: "bad", content: "bad" }),
    () =>
      caller(user).bulkStatus({
        tickets: [{ ...created, version: 1 }],
        status: "closed",
      }),
  ])
    await assert.rejects(call, { code: "FORBIDDEN" });
});

test("private notes, assignments and their attachments never leak or create user unread alerts", async () => {
  const created = await caller(user).create(input());
  await caller(admin).update({
    ...created,
    version: 1,
    assignedTo: secondAdmin.id,
  });
  await caller(admin).reply({
    ...created,
    version: 2,
    content: "private staff note",
    internal: true,
    attachments: [textFile],
  });
  const staffDetail = await caller(admin).detail(created);
  assert.equal(staffDetail.status, "open");
  assert.equal(staffDetail.assignedTo, secondAdmin.id);
  assert.equal((await caller(user).detail(created)).assignedTo, null);
  const staffMessages = await caller(admin).messages(created);
  const userMessages = await caller(user).messages(created);
  assert.equal(staffMessages.items.length, 3);
  assert.equal(userMessages.items.length, 1);
  assert.equal(userMessages.seenVersion, 1);
  assert.equal(
    (await caller(user).list({ page: 1, search: String(created.id) })).items[0]
      .unread,
    false,
  );
  const note = staffMessages.items.find(
    (m) => m.content === "private staff note",
  )!;
  assert.equal(
    (await caller(admin).attachment({ id: note.attachments[0].id })).name,
    textFile.name,
  );
  await assert.rejects(
    () => caller(user).attachment({ id: note.attachments[0].id }),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(
    () =>
      caller(user).reply({
        ...created,
        version: 3,
        content: "fake note",
        internal: true,
      }),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(
    () => caller(user).update({ ...created, version: 3, assignedTo: 1 }),
    { code: "NOT_FOUND" },
  );
  await caller(admin).reply({
    ...created,
    version: 3,
    content: "Public answer",
  });
  const publicTicket = await caller(user).detail(created);
  assert.equal(publicTicket.status, "waiting_user");
  assert.ok(publicTicket.firstResponseAt);
  assert.equal(
    (await caller(user).list({ page: 1, search: String(created.id) })).items[0]
      .unread,
    true,
  );
  // An old read acknowledgement must not hide a newer reply.
  await caller(user).markRead({ ...created, version: 1 });
  assert.equal(
    (await caller(user).list({ page: 1, search: String(created.id) })).items[0]
      .unread,
    true,
  );
  await caller(user).markRead({ ...created, version: 4 });
  await caller(user).markRead({ ...created, version: 1 });
  assert.equal(
    (await caller(user).list({ page: 1, search: String(created.id) })).items[0]
      .unread,
    false,
  );
});

test("status lifecycle, optimistic conflicts, reply atomicity and rating constraints", async () => {
  const created = await caller(user).create(input());
  await assert.rejects(
    () => caller(user).update({ ...created, version: 1, status: "resolved" }),
    { code: "NOT_FOUND" },
  );
  await caller(admin).reply({
    ...created,
    version: 1,
    content: "Fixed",
    status: "resolved",
  });
  await assert.rejects(
    () =>
      caller(admin).reply({
        ...created,
        version: 1,
        content: "stale duplicate",
      }),
    { code: "CONFLICT" },
  );
  assert.equal(
    (await caller(admin).messages(created)).items.some(
      (m) => m.content === "stale duplicate",
    ),
    false,
  );
  await caller(user).rate({
    ...created,
    version: 2,
    rating: 5,
    comment: "Thanks",
  });
  await assert.rejects(
    () => caller(user).rate({ ...created, version: 3, rating: 1 }),
    { code: "BAD_REQUEST" },
  );
  await caller(user).update({ ...created, version: 3, status: "open" });
  assert.equal((await caller(user).detail(created)).rating, null);
  await assert.rejects(
    () => caller(user).rate({ ...created, version: 4, rating: 5 }),
    { code: "BAD_REQUEST" },
  );
  await caller(user).update({ ...created, version: 4, status: "closed" });
  await assert.rejects(
    () =>
      caller(admin).reply({ ...created, version: 5, content: "closed reply" }),
    { code: "BAD_REQUEST" },
  );
  await caller(admin).reply({
    ...created,
    version: 5,
    content: "closed private note",
    internal: true,
  });
  await caller(admin).delete({ ...created, version: 6 });
  await assert.rejects(() => caller(user).detail(created), {
    code: "NOT_FOUND",
  });
  for (const table of [
    "support_ticket_messages",
    "support_ticket_attachments",
    "support_ticket_reads",
  ])
    assert.equal(
      (
        await runtime.queryRaw(
          `SELECT * FROM "${table}" WHERE "ticketId" = ?`,
          [created.id],
        )
      ).length,
      0,
    );
});

test("bulk operations roll back entirely on stale/invalid tickets and admin filters work", async () => {
  const first = await caller(user).create(input({ title: "batch-first" }));
  const second = await caller(user).create(input({ title: "batch-second" }));
  await caller(admin).update({
    ...second,
    version: 1,
    priority: "high",
    category: "billing",
    assignedTo: 1,
  });
  await assert.rejects(
    () =>
      caller(admin).bulkStatus({
        tickets: [
          { ...first, version: 1 },
          { ...second, version: 1 },
        ],
        status: "closed",
      }),
    { code: "CONFLICT" },
  );
  assert.equal((await caller(user).detail(first)).status, "open");
  await caller(admin).bulkStatus({
    tickets: [
      { ...first, version: 1 },
      { ...second, version: 2 },
    ],
    status: "resolved",
  });
  const filtered = await caller(admin).list({
    page: 1,
    status: "resolved",
    priority: "high",
    category: "billing",
    assigned: "me",
    search: "batch",
  });
  assert.deepEqual(
    filtered.items.map((t) => t.id),
    [second.id],
  );
  assert.ok((await caller(admin).summary()).statuses.resolved);
});

test("message pagination is bounded and private records are excluded before paging", async () => {
  const created = await caller(stranger).create(input());
  for (let i = 0; i < 62; i++)
    await runtime.insertAndGetId("support_ticket_messages", {
      ticketId: created.id,
      authorId: 1,
      authorName: "staff",
      authorRole: "admin",
      content: `message-${i}`,
      visibility: i % 4 === 0 ? "internal" : "public",
      kind: "reply",
      createdAt: 1000 + i,
    });
  const page1 = await caller(admin).messages(created);
  assert.equal(page1.items.length, 50);
  assert.ok(page1.nextCursor);
  const page2 = await caller(admin).messages({
    ...created,
    cursor: page1.nextCursor,
  });
  assert.equal(page2.items.length, 13);
  assert.equal(
    new Set([...page1.items, ...page2.items].map((m) => m.id)).size,
    63,
  );
  const publicPage = await caller(stranger).messages(created);
  assert.equal(
    publicPage.items.every((m) => m.visibility === "public"),
    true,
  );
  assert.equal(publicPage.nextCursor, null);
});

test("service choices use direct permissions and billing grants, not hidden topology", async () => {
  for (const [id, owner] of [
    [10, 1],
    [11, 1],
    [12, 1],
    [13, 1],
    [14, 1],
    [15, 2],
  ])
    await runtime.insertAndGetId("hosts", {
      id,
      userId: owner,
      name: `host-${id}`,
      ip: `192.0.2.${id}`,
    });
  await runtime.insertAndGetId("user_host_permissions", {
    userId: user.id,
    hostId: 10,
  });
  await runtime.insertAndGetId("forward_groups", {
    id: 20,
    userId: 1,
    name: "Granted group",
    groupType: "host",
    forwardType: "gost",
    protocol: "tcp",
    targetIp: "example.org",
    targetPort: 443,
  });
  await runtime.insertAndGetId("forward_group_members", {
    groupId: 20,
    memberType: "host",
    hostId: 11,
  });
  await runtime.insertAndGetId("user_forward_group_permissions", {
    userId: user.id,
    forwardGroupId: 20,
  });
  const basic = (await caller(user).services({})).items;
  assert.ok(basic.some((s) => s.type === "host" && s.id === 10));
  assert.ok(basic.some((s) => s.type === "host" && s.id === 15));
  assert.ok(basic.some((s) => s.type === "group" && s.id === 20));
  assert.equal(
    basic.some((s) => s.type === "host" && s.id === 11),
    false,
  );
  await assert.rejects(
    () => caller(user).create(input({ service: { type: "host", id: 11 } })),
    { code: "BAD_REQUEST" },
  );
  const billing = await import("./repositories/trafficBillingRepository");
  await billing.setTrafficBillingEnabled(true);
  await runtime.insertAndGetId("traffic_billing_configs", {
    id: 31,
    resourceType: "host",
    resourceId: 12,
    enabled: true,
    requiresPermission: false,
  });
  await runtime.insertAndGetId("traffic_billing_configs", {
    id: 32,
    resourceType: "host",
    resourceId: 13,
    enabled: true,
    requiresPermission: true,
  });
  await runtime.insertAndGetId("traffic_billing_configs", {
    id: 33,
    resourceType: "host",
    resourceId: 14,
    enabled: true,
    requiresPermission: true,
  });
  // A normal host grant cannot override a private pay-as-you-go resource.
  await runtime.insertAndGetId("user_host_permissions", {
    userId: 2,
    hostId: 13,
  });
  await runtime.insertAndGetId("user_traffic_billing_permissions", {
    userId: 2,
    resourceType: "host",
    resourceId: 14,
  });
  const services = (await caller(user).services({})).items;
  for (const [hostId, usable] of [
    [12, true],
    [13, false],
    [14, true],
  ])
    assert.equal(
      services.some((s) => s.type === "host" && s.id === hostId),
      usable,
    );
  assert.ok(services.some((s) => s.type === "billing" && s.id === 31));
  assert.equal(
    services.some((s) => s.type === "billing" && s.id === 32),
    false,
  );
  const created = await caller(user).create(
    input({ service: { type: "host", id: 10 } }),
  );
  await runtime.executeRaw(
    'DELETE FROM "user_host_permissions" WHERE "hostId" = 10',
  );
  await runtime.executeRaw('DELETE FROM "hosts" WHERE id = 10');
  assert.equal((await caller(user).detail(created)).serviceName, "host-10");
  assert.equal(
    (await caller(user).services({ type: "host" })).items.some(
      (s) => s.id === 10,
    ),
    false,
  );
});

test("creation limits and per-user reply throttling are enforced in the database", async () => {
  const limited = { id: 5, role: "user", name: "limits", username: "limits" };
  for (let i = 0; i < 10; i++) await caller(limited).create(input());
  await assert.rejects(() => caller(limited).create(input()), {
    code: "TOO_MANY_REQUESTS",
  });
  await runtime.executeRaw(
    'UPDATE "support_tickets" SET status = ? WHERE "userId" = ?',
    ["closed", limited.id],
  );
  for (let i = 0; i < 10; i++) {
    const ticket = await caller(limited).create(input());
    await runtime.executeRaw(
      'UPDATE "support_tickets" SET status = ? WHERE id = ?',
      ["closed", ticket.id],
    );
  }
  await assert.rejects(() => caller(limited).create(input()), {
    code: "TOO_MANY_REQUESTS",
  });
  const racer = { id: 6, role: "user", name: "race", username: "race" };
  const created = await caller(racer).create(input());
  await assert.rejects(
    () => caller(racer).reply({ ...created, version: 1, content: "too soon" }),
    { code: "TOO_MANY_REQUESTS" },
  );
  await runtime.executeRaw(
    'UPDATE "support_ticket_messages" SET "createdAt" = 1 WHERE "ticketId" = ?',
    [created.id],
  );
  const replies = await Promise.allSettled([
    caller(racer).reply({ ...created, version: 1, content: "first" }),
    caller(racer).reply({ ...created, version: 1, content: "duplicate" }),
  ]);
  assert.equal(replies.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    (await caller(racer).messages(created)).items.filter(
      (m) => m.kind === "reply",
    ).length,
    2,
  );
});

test("attachments validate actual content, names, sizes and encodings", () => {
  assert.equal(
    validateTicketAttachments([
      { ...textFile, name: "../test.log", mime: "text/html" },
    ])[0].mime,
    "text/plain",
  );
  assert.equal(
    validateTicketAttachments([
      { ...textFile, name: "../test.log" },
    ])[0].name.includes("/"),
    false,
  );
  for (const files of [
    [{ ...textFile, name: "payload.svg" }],
    [{ ...textFile, name: "fake.png" }],
    [{ ...textFile, base64: "%%%" }],
    [{ ...textFile, base64: Buffer.from([255, 254, 0]).toString("base64") }],
    Array(4).fill(textFile),
    [
      {
        ...textFile,
        base64: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64"),
      },
    ],
  ])
    assert.throws(() => validateTicketAttachments(files));
});

test("shared canned replies stay staff-only, and schema upgrades are idempotent", async () => {
  await caller(admin).saveCannedReply({
    title: "Diagnostics",
    content: "Please provide a sanitized log.",
  });
  const first = (await caller(secondAdmin).cannedReplies())[0];
  await caller(secondAdmin).saveCannedReply({
    ...first,
    content: "Updated shared answer",
  });
  assert.equal(
    (await caller(admin).cannedReplies())[0].content,
    "Updated shared answer",
  );
  await caller(admin).deleteCannedReply({ id: first.id });
  assert.equal((await caller(admin).cannedReplies()).length, 0);
  const schema = await import("./dbSchema");
  await schema.ensureDatabaseSchema();
  for (const table of [
    "support_tickets",
    "support_ticket_messages",
    "support_ticket_attachments",
    "support_ticket_reads",
    "support_canned_replies",
  ])
    assert.ok(schema.MIGRATION_TABLES.includes(table as any));
  const migration = await import("./migration");
  const backup = migration.pruneMigrationSnapshotForPanelBackup({
    version: 1,
    exportedAt: Date.now(),
    tables: {
      support_tickets: [{ id: 99 }],
      support_ticket_messages: [{ id: 100 }],
      support_ticket_attachments: [{ id: 101 }],
      support_ticket_reads: [{ id: 102 }],
      support_canned_replies: [{ id: 103 }],
    },
  });
  assert.equal(Object.keys(backup.tables).length, 5);
});

test("attachment quotas reject writes atomically without storing a partial reply", async () => {
  const created = await caller(stranger).create(input());
  const [message] = (await caller(stranger).messages(created)).items;
  const oversized = await runtime.insertAndGetId("support_ticket_attachments", {
    ticketId: created.id,
    messageId: message.id,
    ...textFile,
    size: 20 * 1024 * 1024,
  });
  await assert.rejects(
    () =>
      caller(admin).reply({
        ...created,
        version: 1,
        content: "must not persist",
        attachments: [textFile],
      }),
    { code: "BAD_REQUEST" },
  );
  assert.equal((await caller(admin).detail(created)).version, 1);
  assert.equal(
    (await caller(admin).messages(created)).items.some(
      (m) => m.content === "must not persist",
    ),
    false,
  );
  await runtime.executeRaw(
    'DELETE FROM "support_ticket_attachments" WHERE id = ?',
    [oversized],
  );
  const staffMessage = await runtime.insertAndGetId("support_ticket_messages", {
    ticketId: created.id,
    authorId: 1,
    authorName: "Staff",
    authorRole: "admin",
    visibility: "internal",
    content: "quota fixture",
    createdAt: Math.floor(Date.now() / 1000),
  });
  const daily = await runtime.insertAndGetId("support_ticket_attachments", {
    ticketId: created.id,
    messageId: staffMessage,
    ...textFile,
    size: 50 * 1024 * 1024,
  });
  await assert.rejects(
    () => caller(admin).create(input({ attachments: [textFile] })),
    { code: "BAD_REQUEST" },
  );
  await runtime.executeRaw(
    'DELETE FROM "support_ticket_attachments" WHERE id = ?',
    [daily],
  );
});

test("service pagination and exact selection work beyond the first fifty resources", async () => {
  let oldest = 0;
  for (let index = 0; index < 70; index++) {
    const id = await runtime.insertAndGetId("forward_rules", {
      userId: stranger.id,
      hostId: 15,
      name: `rule-paged-${index}`,
      forwardType: "gost",
      protocol: "tcp",
      sourcePort: 30000 + index,
      targetIp: "example.org",
      targetPort: 443,
    });
    if (!index) oldest = id;
  }
  const first = await caller(stranger).services({ type: "rule" });
  assert.equal(first.items.length, 50);
  assert.equal(first.nextOffset, 50);
  const second = await caller(stranger).services({ type: "rule", offset: 50 });
  assert.equal(second.items.length, 20);
  assert.equal(
    new Set([...first.items, ...second.items].map((s) => s.id)).size,
    70,
  );
  assert.equal(
    (await caller(stranger).services({ type: "rule", search: "rule-paged-69" }))
      .items.length,
    1,
  );
  const ticket = await caller(stranger).create(
    input({ service: { type: "rule", id: oldest } }),
  );
  assert.equal((await caller(stranger).detail(ticket)).serviceId, oldest);
});

test("MySQL and PostgreSQL schema generation includes attachment capacity and unique read cursors", async () => {
  const { ensureDatabaseSchema } = await import("./dbSchema");
  const mysql: string[] = [],
    postgres: string[] = [];
  await ensureDatabaseSchema({
    getConnection() {},
    query: async (sql: string) => {
      mysql.push(sql);
      return [[], []];
    },
    execute: async () => [[], []],
  } as any);
  await ensureDatabaseSchema({
    query: async (sql: string) => {
      postgres.push(sql);
      return { rows: [] };
    },
  } as any);
  assert.ok(
    mysql.some(
      (sql) =>
        sql.startsWith(
          "CREATE TABLE IF NOT EXISTS `support_ticket_attachments`",
        ) && sql.includes("`base64` LONGTEXT NOT NULL"),
    ),
  );
  assert.ok(
    postgres.some(
      (sql) =>
        sql.startsWith(
          'CREATE TABLE IF NOT EXISTS "support_ticket_attachments"',
        ) && sql.includes('"base64" TEXT NOT NULL'),
    ),
  );
  for (const queries of [mysql, postgres])
    assert.ok(
      queries.some(
        (sql) =>
          sql.includes("support_ticket_reads") &&
          /UNIQUE/.test(sql) &&
          /ticketId/.test(sql) &&
          /userId/.test(sql),
      ),
    );
});

test("backup import remaps ticket, author, message and read IDs while preserving removed-service history", async () => {
  const migration = await import("./migration");
  const result = await migration.importMigrationSnapshot({
    version: 1,
    exportedAt: Date.now(),
    tables: {
      users: [
        { id: 102, username: user.username, password: "unused", role: "user" },
        {
          id: 103,
          username: admin.username,
          password: "unused",
          role: "admin",
        },
      ],
      support_tickets: [
        {
          id: 901,
          userId: 102,
          title: "Migrated historical ticket",
          status: "open",
          priority: "normal",
          category: "technical",
          serviceType: "host",
          serviceId: 9999,
          serviceName: "Removed service",
          assignedTo: 103,
          version: 2,
          publicVersion: 1,
        },
      ],
      support_ticket_messages: [
        {
          id: 910,
          ticketId: 901,
          authorId: 103,
          authorName: "Old Staff",
          authorRole: "admin",
          kind: "reply",
          visibility: "internal",
          content: "Migrated private note",
        },
      ],
      support_ticket_attachments: [
        { id: 911, ticketId: 901, messageId: 910, ...textFile, size: 22 },
      ],
      support_ticket_reads: [
        { id: 912, ticketId: 901, userId: 102, version: 1 },
      ],
      support_canned_replies: [
        { id: 913, title: "Migrated reply", content: "Migrated saved answer" },
      ],
    },
  });
  assert.equal(result.inserted.support_tickets, 1);
  assert.equal(result.skipped.support_tickets || 0, 0);
  const [ticket] = await runtime.queryRaw<{
    id: number;
    userId: number;
    serviceId: number | null;
    serviceName: string;
    assignedTo: number;
  }>('SELECT * FROM "support_tickets" WHERE title = ?', [
    "Migrated historical ticket",
  ]);
  assert.equal(ticket.userId, user.id);
  assert.equal(ticket.assignedTo, admin.id);
  assert.equal(ticket.serviceId, null);
  assert.equal(ticket.serviceName, "Removed service");
  const messages = await caller(admin).messages({ id: ticket.id });
  assert.equal(messages.items[0].authorId, admin.id);
  assert.equal(
    (
      await caller(admin).attachment({
        id: messages.items[0].attachments[0].id,
      })
    ).base64,
    textFile.base64,
  );
  assert.equal(
    (await caller(user).messages({ id: ticket.id })).items.length,
    0,
  );
  const [read] = await runtime.queryRaw<{ userId: number }>(
    'SELECT "userId" FROM "support_ticket_reads" WHERE "ticketId" = ?',
    [ticket.id],
  );
  assert.equal(read.userId, user.id);
  const snapshot = await migration.exportMigrationSnapshot(undefined, {
    dataScope: "essential",
    consistent: true,
  });
  assert.ok(snapshot.tables.support_tickets?.some((t) => t.id === ticket.id));
  assert.ok(snapshot.tables.support_ticket_attachments?.length);
});
