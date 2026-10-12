import { TRPCError } from "@trpc/server";
import {
  getDatabaseKind,
  queryRaw,
  executeRaw,
  insertAndGetId,
  rawAffectedRows,
  withDatabaseTransaction,
} from "../dbRuntime";
import { boolLiteral, inList, quoteIdentifier as q } from "../dbCompat";
import { getAllSettings } from "./settingsRepository";
import { normalizeSidebarMenuSettings } from "../../shared/sidebarMenu";
import {
  canChangeTicketStatus,
  isTicketFinished,
  type SupportActor,
  type TicketCategory,
  type TicketPriority,
  type TicketService,
  type TicketServiceType,
  type TicketStatus,
  type TicketAttachmentInput,
} from "../../shared/supportTickets";
import {
  getUserEffectiveAllowedHostIds,
  getUserEffectiveAllowedTunnelIds,
  getUserAllowedForwardGroupIds,
} from "./permissionRepository";
import { getTrafficBillingAccessSnapshot } from "./trafficBillingRepository";
import { validateTicketAttachments } from "../supportTicketAttachments";

export type TicketActor = SupportActor & {
  name?: string | null;
  username?: string | null;
};
export type SupportTicket = {
  id: number;
  userId: number;
  title: string;
  status: TicketStatus;
  priority: TicketPriority;
  category: TicketCategory;
  serviceType: TicketServiceType | null;
  serviceId: number | null;
  serviceName: string | null;
  assignedTo: number | null;
  version: number;
  publicVersion: number;
  rating: number | null;
  ratingComment: string | null;
  firstResponseAt: number | null;
  resolvedAt: number | null;
  closedAt: number | null;
  createdAt: number;
  updatedAt: number;
};
type TicketMessage = {
  id: number;
  ticketId: number;
  authorId: number;
  authorName: string;
  authorRole: string;
  kind: "reply" | "event";
  visibility: "public" | "internal";
  content: string;
  createdAt: number;
};
type AttachmentMeta = {
  id: number;
  messageId: number;
  name: string;
  mime: string;
  size: number;
};
const now = () => Math.floor(Date.now() / 1000);
const forbidden = () =>
  new TRPCError({ code: "NOT_FOUND", message: "工单不存在或无权访问" });
const bad = (message: string) =>
  new TRPCError({ code: "BAD_REQUEST", message });

export async function supportTicketsEnabled() {
  const settings = await getAllSettings();
  try {
    return normalizeSidebarMenuSettings(
      JSON.parse(settings.sidebarMenu || "{}"),
    ).tickets;
  } catch {
    return false;
  }
}
export async function requireSupportTicketsEnabled() {
  if (!(await supportTicketsEnabled()))
    throw new TRPCError({ code: "FORBIDDEN", message: "工单系统未开启" });
}

export async function getSupportTicket(actor: SupportActor, id: number) {
  const [ticket] = await queryRaw<SupportTicket>(
    `SELECT * FROM ${q("support_tickets")} WHERE id = ?`,
    [id],
  );
  if (!ticket || (actor.role !== "admin" && Number(ticket.userId) !== actor.id))
    throw forbidden();
  return ticket;
}
function visibleVersion(actor: SupportActor, ticket: SupportTicket) {
  return actor.role === "admin" ? ticket.version : ticket.publicVersion;
}
function publicTicket(actor: SupportActor, ticket: SupportTicket) {
  // Assignment and internal-note timing are staff-only. Keep the mutation revision
  // for optimistic writes, but do not expose staff identities to ordinary users.
  if (actor.role === "admin") return ticket;
  return { ...ticket, assignedTo: null };
}

export async function listSupportServices(
  actor: SupportActor,
  input: {
    search?: string;
    type?: TicketServiceType;
    id?: number;
    offset?: number;
  } = {},
) {
  const admin = actor.role === "admin";
  const [hostIds, tunnelIds, groupIds, billing] = admin
    ? [[], [], [], null]
    : await Promise.all([
        getUserEffectiveAllowedHostIds(actor.id),
        getUserEffectiveAllowedTunnelIds(actor.id),
        getUserAllowedForwardGroupIds(actor.id),
        getTrafficBillingAccessSnapshot(actor.id),
      ]);
  // Only direct grants/owned resources and usable billing resources, never the
  // expanded topology scope (which includes hidden relay/exit infrastructure).
  const access = (
    ids: number[],
    active: number[] = [],
    usable: number[] = [],
  ) => [...new Set([...ids.filter((id) => !active.includes(id)), ...usable])];
  const queries: string[] = [];
  const params: unknown[] = [];
  const add = (
    type: TicketServiceType,
    table: string,
    name: string,
    condition: string,
    values: unknown[] = [],
    join = "",
  ) => {
    if (input.type && input.type !== type) return;
    let where = condition;
    if (input.id) {
      where += " AND a.id = ?";
      values = [...values, input.id];
    }
    queries.push(
      `SELECT '${type}' AS ${q("type")}, a.id AS id, ${name} AS name FROM ${q(table)} a ${join} WHERE ${where}`,
    );
    params.push(...values);
  };
  add(
    "subscription",
    "user_subscriptions",
    `COALESCE(p.${q("name")}, 'Subscription')`,
    `a.${q("userId")} = ?`,
    [actor.id],
    `LEFT JOIN ${q("subscription_plans")} p ON p.id = a.${q("planId")}`,
  );
  add(
    "rule",
    "forward_rules",
    `a.${q("name")}`,
    `a.${q("userId")} = ? AND a.${q("pendingDelete")} = ${boolLiteral(false)} AND COALESCE(a.${q("forwardGroupRuleId")}, 0) = 0`,
    [actor.id],
  );
  for (const [type, table, ids, active, usable] of [
    [
      "host",
      "hosts",
      hostIds,
      billing?.activeResourceIds.hostIds,
      billing?.usableResourceIds.hostIds,
    ],
    [
      "tunnel",
      "tunnels",
      tunnelIds,
      billing?.activeResourceIds.tunnelIds,
      billing?.usableResourceIds.tunnelIds,
    ],
    [
      "group",
      "forward_groups",
      groupIds,
      billing?.activeResourceIds.forwardGroupIds,
      billing?.usableResourceIds.forwardGroupIds,
    ],
  ] as const) {
    const allowed = inList(access(ids, active, usable));
    const restricted = inList(active || []);
    const condition = admin
      ? "1=1"
      : billing?.status === "failed"
        ? "1=0"
        : `(a.id IN ${allowed.sql} OR (a.${q("userId")} = ?${active?.length ? ` AND a.id NOT IN ${restricted.sql}` : ""}))`;
    add(
      type,
      table,
      `a.${q("name")}`,
      condition,
      admin || billing?.status === "failed"
        ? []
        : [
            ...allowed.params,
            actor.id,
            ...(active?.length ? restricted.params : []),
          ],
    );
  }
  // Billing labels are derived from the authorized linked resource, not the
  // config description (which may contain private administrative details).
  if (admin || billing?.enabled) {
    const usable = billing?.usableResourceIds;
    const host = inList(usable?.hostIds || []),
      tunnel = inList(usable?.tunnelIds || []),
      group = inList(usable?.forwardGroupIds || []);
    add(
      "billing",
      "traffic_billing_configs",
      `COALESCE(h.${q("name")}, t.${q("name")}, g.${q("name")}, 'Service')`,
      admin
        ? "1=1"
        : `a.${q("enabled")} = ${boolLiteral(true)} AND ((a.${q("resourceType")} = 'host' AND a.${q("resourceId")} IN ${host.sql}) OR (a.${q("resourceType")} = 'tunnel' AND a.${q("resourceId")} IN ${tunnel.sql}) OR (a.${q("resourceType")} = 'forward_group' AND a.${q("resourceId")} IN ${group.sql}))`,
      admin ? [] : [...host.params, ...tunnel.params, ...group.params],
      `LEFT JOIN ${q("hosts")} h ON a.${q("resourceType")} = 'host' AND h.id = a.${q("resourceId")} LEFT JOIN ${q("tunnels")} t ON a.${q("resourceType")} = 'tunnel' AND t.id = a.${q("resourceId")} LEFT JOIN ${q("forward_groups")} g ON a.${q("resourceType")} = 'forward_group' AND g.id = a.${q("resourceId")}`,
    );
  }
  if (!queries.length)
    return { items: [] as TicketService[], nextOffset: null };
  const search = `%${(input.search || "").toLowerCase()}%`;
  const items = await queryRaw<TicketService>(
    `SELECT * FROM (${queries.join(" UNION ALL ")}) services WHERE LOWER(name) LIKE ? ORDER BY ${q("type")}, id DESC LIMIT 51 OFFSET ?`,
    [...params, search, input.offset || 0],
  );
  return {
    items: items.slice(0, 50).map((item) => ({ ...item, id: Number(item.id) })),
    nextOffset: items.length > 50 ? (input.offset || 0) + 50 : null,
  };
}

export async function listSupportTickets(
  actor: SupportActor,
  input: {
    page: number;
    status?: TicketStatus;
    priority?: TicketPriority;
    category?: TicketCategory;
    search?: string;
    assigned?: "me" | "unassigned";
    unread?: boolean;
  },
) {
  const clauses = [actor.role === "admin" ? "1=1" : `t.${q("userId")} = ?`];
  const params: unknown[] = actor.role === "admin" ? [] : [actor.id];
  for (const field of ["status", "priority", "category"] as const)
    if (input[field]) {
      clauses.push(`t.${q(field)} = ?`);
      params.push(input[field]);
    }
  if (input.search) {
    clauses.push(
      `(LOWER(t.${q("title")}) LIKE ? OR LOWER(COALESCE(t.${q("serviceName")}, '')) LIKE ? OR t.id = ?${actor.role === "admin" ? ` OR LOWER(COALESCE(u.${q("username")}, '')) LIKE ?` : ""})`,
    );
    params.push(
      `%${input.search.toLowerCase()}%`,
      `%${input.search.toLowerCase()}%`,
      Number(input.search.replace(/^#/, "")) || 0,
    );
    if (actor.role === "admin") params.push(`%${input.search.toLowerCase()}%`);
  }
  if (actor.role === "admin" && input.assigned) {
    clauses.push(
      input.assigned === "me"
        ? `t.${q("assignedTo")} = ?`
        : `t.${q("assignedTo")} IS NULL`,
    );
    if (input.assigned === "me") params.push(actor.id);
  }
  const version = actor.role === "admin" ? "version" : "publicVersion";
  const unread = `t.${q(version)} > COALESCE(r.${q("version")}, 0)`;
  if (input.unread) clauses.push(unread);
  const from = `FROM ${q("support_tickets")} t LEFT JOIN ${q("users")} u ON u.id = t.${q("userId")} LEFT JOIN ${q("support_ticket_reads")} r ON r.${q("ticketId")} = t.id AND r.${q("userId")} = ? WHERE ${clauses.join(" AND ")}`;
  const values = [actor.id, ...params];
  const [count] = await queryRaw<{ total: number }>(
    `SELECT COUNT(*) AS total ${from}`,
    values,
  );
  const items = await queryRaw<
    SupportTicket & { ownerName: string; unread: number }
  >(
    `SELECT t.*, COALESCE(u.${q("displayRemark")}, u.${q("name")}, u.${q("username")}, '') AS ${q("ownerName")}, CASE WHEN ${unread} THEN 1 ELSE 0 END AS unread ${from} ORDER BY t.${q("updatedAt")} DESC, t.id DESC LIMIT 20 OFFSET ?`,
    [...values, (input.page - 1) * 20],
  );
  return {
    items: items.map((t) => ({
      ...publicTicket(actor, t),
      ownerName: actor.role === "admin" ? t.ownerName : "",
      unread: !!t.unread,
    })),
    total: Number(count.total),
    pageSize: 20,
  };
}

export async function supportTicketSummary(actor: SupportActor) {
  const version = actor.role === "admin" ? "version" : "publicVersion";
  const rows = await queryRaw<{
    status: TicketStatus;
    total: number;
    unread: number;
  }>(
    `SELECT t.${q("status")} AS status, COUNT(*) AS total, SUM(CASE WHEN t.${q(version)} > COALESCE(r.${q("version")}, 0) THEN 1 ELSE 0 END) AS unread FROM ${q("support_tickets")} t LEFT JOIN ${q("support_ticket_reads")} r ON r.${q("ticketId")} = t.id AND r.${q("userId")} = ? ${actor.role === "admin" ? "" : `WHERE t.${q("userId")} = ?`} GROUP BY t.${q("status")}`,
    actor.role === "admin" ? [actor.id] : [actor.id, actor.id],
  );
  return {
    total: rows.reduce((n, r) => n + Number(r.total), 0),
    unread: rows.reduce((n, r) => n + Number(r.unread), 0),
    statuses: Object.fromEntries(
      rows.map((r) => [r.status, Number(r.total)]),
    ) as Partial<Record<TicketStatus, number>>,
  };
}

export async function supportTicketDetail(actor: SupportActor, id: number) {
  const ticket = await getSupportTicket(actor, id);
  const [owner] =
    actor.role === "admin"
      ? await queryRaw<{ name: string }>(
          `SELECT COALESCE(${q("displayRemark")}, ${q("name")}, ${q("username")}) AS name FROM ${q("users")} WHERE id = ?`,
          [ticket.userId],
        )
      : [];
  return { ...publicTicket(actor, ticket), ownerName: owner?.name || "" };
}

export async function supportTicketMessages(
  actor: SupportActor,
  id: number,
  cursor?: number,
) {
  const ticket = await getSupportTicket(actor, id);
  const rows = await queryRaw<TicketMessage>(
    `SELECT * FROM ${q("support_ticket_messages")} WHERE ${q("ticketId")} = ? ${actor.role === "admin" ? "" : `AND ${q("visibility")} = 'public'`} ${cursor ? "AND id < ?" : ""} ORDER BY id DESC LIMIT 51`,
    cursor ? [id, cursor] : [id],
  );
  const messages = rows.slice(0, 50);
  const ids = inList(messages.map((m) => m.id));
  const attachments = messages.length
    ? await queryRaw<AttachmentMeta>(
        `SELECT id, ${q("messageId")}, name, mime, size FROM ${q("support_ticket_attachments")} WHERE ${q("messageId")} IN ${ids.sql}`,
        ids.params,
      )
    : [];
  return {
    items: messages
      .reverse()
      .map((m) => ({
        ...m,
        authorName:
          actor.role === "admin" || Number(m.authorId) === actor.id
            ? m.authorName
            : "",
        attachments: attachments.filter((a) => a.messageId === m.id),
      })),
    nextCursor: rows.length > 50 ? Number(rows[49].id) : null,
    seenVersion: visibleVersion(actor, ticket),
  };
}

export async function readSupportTicket(
  actor: SupportActor,
  id: number,
  version: number,
) {
  const ticket = await getSupportTicket(actor, id);
  const value = Math.min(version, visibleVersion(actor, ticket));
  const table = q("support_ticket_reads"),
    v = q("version"),
    user = q("userId"),
    ticketId = q("ticketId");
  if (getDatabaseKind() === "mysql") {
    await executeRaw(
      `INSERT INTO ${table} (${ticketId}, ${user}, ${v}) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE ${v} = GREATEST(${v}, VALUES(${v}))`,
      [id, actor.id, value],
    );
  } else {
    const greatest = getDatabaseKind() === "sqlite" ? "MAX" : "GREATEST";
    await executeRaw(
      `INSERT INTO ${table} (${ticketId}, ${user}, ${v}) VALUES (?, ?, ?) ON CONFLICT (${ticketId}, ${user}) DO UPDATE SET ${v} = ${greatest}(${table}.${v}, excluded.${v})`,
      [id, actor.id, value],
    );
  }
}

async function actorLock(actor: SupportActor) {
  const rows = await queryRaw(
    `SELECT id FROM ${q("users")} WHERE id = ?${getDatabaseKind() === "sqlite" ? "" : " FOR UPDATE"}`,
    [actor.id],
  );
  if (!rows.length) throw forbidden();
}
async function requireAttachmentBudget(
  actor: SupportActor,
  files: ReturnType<typeof validateTicketAttachments>,
  ticketId?: number,
) {
  const incoming = files.reduce((total, file) => total + file.size, 0);
  if (!incoming) return;
  const [daily] = await queryRaw<{ size: number }>(
    `SELECT COALESCE(SUM(a.${q("size")}), 0) AS size FROM ${q("support_ticket_attachments")} a INNER JOIN ${q("support_ticket_messages")} m ON m.id = a.${q("messageId")} WHERE m.${q("authorId")} = ? AND m.${q("createdAt")} >= ?`,
    [actor.id, now() - 86400],
  );
  if (Number(daily.size) + incoming > 50 * 1024 * 1024)
    throw bad("每天附件总量最多 50 MB");
  if (ticketId) {
    const [total] = await queryRaw<{ size: number }>(
      `SELECT COALESCE(SUM(${q("size")}), 0) AS size FROM ${q("support_ticket_attachments")} WHERE ${q("ticketId")} = ?`,
      [ticketId],
    );
    if (Number(total.size) + incoming > 20 * 1024 * 1024)
      throw bad("每个工单附件总量最多 20 MB");
  }
}
async function addMessage(
  actor: TicketActor,
  id: number,
  content: string,
  visibility = "public",
  kind = "reply",
  files: ReturnType<typeof validateTicketAttachments> = [],
) {
  const messageId = await insertAndGetId("support_ticket_messages", {
    ticketId: id,
    authorId: actor.id,
    authorName: (actor.name || actor.username || `#${actor.id}`).slice(0, 160),
    authorRole: actor.role,
    kind,
    visibility,
    content,
    createdAt: now(),
  });
  for (const file of files)
    await insertAndGetId("support_ticket_attachments", {
      ...file,
      ticketId: id,
      messageId,
    });
  return messageId;
}
async function updateTicket(
  ticket: SupportTicket,
  patch: Record<string, unknown>,
  publicChange: boolean,
) {
  const nextVersion = Number(ticket.version) + 1;
  const changes = {
    ...patch,
    version: nextVersion,
    ...(publicChange ? { publicVersion: nextVersion, updatedAt: now() } : {}),
  };
  const result = await executeRaw(
    `UPDATE ${q("support_tickets")} SET ${Object.keys(changes)
      .map((k) => `${q(k)} = ?`)
      .join(", ")} WHERE id = ? AND ${q("version")} = ?`,
    [...Object.values(changes), ticket.id, ticket.version],
  );
  if (!rawAffectedRows(result))
    throw new TRPCError({
      code: "CONFLICT",
      message: "工单已有更新，请刷新后重试",
    });
  return nextVersion;
}
function requireVersion(ticket: SupportTicket, expectedVersion: number) {
  if (Number(ticket.version) !== expectedVersion)
    throw new TRPCError({
      code: "CONFLICT",
      message: "工单已有更新，请刷新后重试",
    });
}

export async function createSupportTicket(
  actor: TicketActor,
  input: {
    title: string;
    content: string;
    priority: TicketPriority;
    category: TicketCategory;
    service?: { type: TicketServiceType; id: number } | null;
    attachments?: TicketAttachmentInput[];
  },
) {
  const files = validateTicketAttachments(input.attachments);
  const service = input.service
    ? (await listSupportServices(actor, input.service)).items.find(
        (s) => s.id === input.service!.id && s.type === input.service!.type,
      )
    : null;
  if (input.service && !service)
    throw bad("所选服务不存在或无权使用，请重新选择");
  return withDatabaseTransaction(async () => {
    await actorLock(actor);
    await requireAttachmentBudget(actor, files);
    if (actor.role !== "admin") {
      const [limits] = await queryRaw<{ active: number; daily: number }>(
        `SELECT SUM(CASE WHEN ${q("status")} NOT IN ('resolved', 'closed') THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN ${q("createdAt")} >= ? THEN 1 ELSE 0 END) AS daily FROM ${q("support_tickets")} WHERE ${q("userId")} = ?`,
        [now() - 86400, actor.id],
      );
      if (Number(limits.active) >= 10 || Number(limits.daily) >= 20)
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message:
            "未完成工单最多 10 个，每天最多提交 20 个，请优先回复已有工单",
        });
    }
    const id = await insertAndGetId("support_tickets", {
      userId: actor.id,
      title: input.title,
      priority: input.priority,
      category: input.category,
      serviceType: service?.type || null,
      serviceId: service?.id || null,
      serviceName: service?.name || null,
      status: "open",
      version: 1,
      publicVersion: 1,
      createdAt: now(),
      updatedAt: now(),
    });
    await addMessage(actor, id, input.content, "public", "reply", files);
    await readSupportTicket(actor, id, 1);
    return { id };
  });
}

export async function replySupportTicket(
  actor: TicketActor,
  input: {
    id: number;
    version: number;
    content: string;
    internal?: boolean;
    status?: TicketStatus;
    attachments?: TicketAttachmentInput[];
  },
) {
  if (input.internal && actor.role !== "admin") throw forbidden();
  const files = validateTicketAttachments(input.attachments);
  return withDatabaseTransaction(async () => {
    await actorLock(actor);
    const ticket = await getSupportTicket(actor, input.id);
    requireVersion(ticket, input.version);
    await requireAttachmentBudget(actor, files, ticket.id);
    if (ticket.status === "closed" && !input.internal)
      throw bad("工单已关闭，请先重新打开再回复");
    if (actor.role !== "admin") {
      const [limit] = await queryRaw<{ recent: number; last: number }>(
        `SELECT COUNT(*) AS recent, MAX(${q("createdAt")}) AS last FROM ${q("support_ticket_messages")} WHERE ${q("authorId")} = ? AND ${q("kind")} = 'reply' AND ${q("createdAt")} >= ?`,
        [actor.id, now() - 3600],
      );
      if (Number(limit.recent) >= 100 || Number(limit.last) > now() - 3)
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "回复过于频繁，请稍后重试",
        });
    }
    if (input.status && (actor.role !== "admin" || input.internal))
      throw bad("内部备注不能更改工单状态");
    const status = input.internal
      ? ticket.status
      : actor.role === "admin"
        ? input.status || "waiting_user"
        : "open";
    const patch = input.internal
      ? {}
      : {
          status,
          resolvedAt: isTicketFinished(status) ? now() : null,
          closedAt: status === "closed" ? now() : null,
          ...(actor.role === "admin" && !ticket.firstResponseAt
            ? { firstResponseAt: now() }
            : {}),
          ...(!isTicketFinished(status)
            ? { rating: null, ratingComment: null }
            : {}),
        };
    const version = await updateTicket(ticket, patch, !input.internal);
    await addMessage(
      actor,
      input.id,
      input.content,
      input.internal ? "internal" : "public",
      "reply",
      files,
    );
    if (status !== ticket.status)
      await addMessage(
        actor,
        input.id,
        JSON.stringify({ action: "status", from: ticket.status, to: status }),
        "public",
        "event",
      );
    await readSupportTicket(actor, input.id, version);
    return { id: input.id, version };
  });
}

export async function updateSupportTicket(
  actor: TicketActor,
  input: {
    id: number;
    version: number;
    status?: TicketStatus;
    priority?: TicketPriority;
    category?: TicketCategory;
    assignedTo?: number | null;
  },
) {
  return withDatabaseTransaction(async () => {
    if (actor.role !== "admin") {
      await actorLock(actor);
      const [recent] = await queryRaw<{ total: number }>(
        `SELECT COUNT(*) AS total FROM ${q("support_ticket_messages")} WHERE ${q("authorId")} = ? AND ${q("kind")} = 'event' AND ${q("createdAt")} >= ?`,
        [actor.id, now() - 60],
      );
      if (Number(recent.total) >= 20)
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "操作过于频繁，请稍后重试",
        });
    }
    const ticket = await getSupportTicket(actor, input.id);
    requireVersion(ticket, input.version);
    if (
      input.status &&
      !canChangeTicketStatus(actor, ticket.userId, input.status)
    )
      throw forbidden();
    if (
      actor.role !== "admin" &&
      (input.priority !== undefined ||
        input.category !== undefined ||
        input.assignedTo !== undefined)
    )
      throw forbidden();
    if (
      actor.role !== "admin" &&
      input.status === "open" &&
      !isTicketFinished(ticket.status)
    )
      throw bad("当前工单无需重新打开");
    if (input.assignedTo) {
      const [staff] = await queryRaw(
        `SELECT id FROM ${q("users")} WHERE id = ? AND role = 'admin' AND ${q("accountEnabled")} = ${boolLiteral(true)}`,
        [input.assignedTo],
      );
      if (!staff) throw bad("请选择有效的管理员");
    }
    const changes: Record<string, unknown> = {};
    const events: { key: string; from: unknown; to: unknown }[] = [];
    for (const key of ["status", "priority", "category", "assignedTo"] as const)
      if (input[key] !== undefined && input[key] !== ticket[key]) {
        changes[key] = input[key];
        events.push({ key, from: ticket[key], to: input[key] });
      }
    if (!events.length) return { id: input.id, version: ticket.version };
    if (changes.status) {
      changes.resolvedAt = isTicketFinished(input.status!)
        ? ticket.resolvedAt || now()
        : null;
      changes.closedAt = input.status === "closed" ? now() : null;
      if (!isTicketFinished(input.status!)) {
        changes.rating = null;
        changes.ratingComment = null;
      }
    }
    const publicChange = events.some((e) => e.key !== "assignedTo");
    const version = await updateTicket(ticket, changes, publicChange);
    for (const event of events)
      await addMessage(
        actor,
        input.id,
        JSON.stringify({ action: event.key, from: event.from, to: event.to }),
        event.key === "assignedTo" ? "internal" : "public",
        "event",
      );
    await readSupportTicket(actor, input.id, version);
    return { id: input.id, version };
  });
}

export async function rateSupportTicket(
  actor: TicketActor,
  input: { id: number; version: number; rating: number; comment: string },
) {
  return withDatabaseTransaction(async () => {
    const ticket = await getSupportTicket(actor, input.id);
    if (Number(ticket.userId) !== actor.id || !isTicketFinished(ticket.status))
      throw bad("仅可评价本人已结束的工单");
    requireVersion(ticket, input.version);
    if (ticket.rating) throw bad("该工单已评价");
    const version = await updateTicket(
      ticket,
      { rating: input.rating, ratingComment: input.comment },
      true,
    );
    await addMessage(
      actor,
      input.id,
      JSON.stringify({ action: "rating", to: input.rating }),
      "public",
      "event",
    );
    await readSupportTicket(actor, input.id, version);
    return { id: input.id };
  });
}

export async function supportTicketAttachment(
  actor: SupportActor,
  attachmentId: number,
) {
  const [attachment] = await queryRaw<
    AttachmentMeta & { ticketId: number; base64: string; visibility: string }
  >(
    `SELECT a.*, m.${q("visibility")} AS visibility FROM ${q("support_ticket_attachments")} a INNER JOIN ${q("support_ticket_messages")} m ON m.id = a.${q("messageId")} WHERE a.id = ?`,
    [attachmentId],
  );
  if (!attachment) throw forbidden();
  await getSupportTicket(actor, attachment.ticketId);
  if (attachment.visibility === "internal" && actor.role !== "admin")
    throw forbidden();
  return {
    name: attachment.name,
    mime: attachment.mime,
    base64: attachment.base64,
    size: attachment.size,
  };
}

export async function supportStaff() {
  return queryRaw<{ id: number; name: string }>(
    `SELECT id, COALESCE(${q("displayRemark")}, ${q("name")}, ${q("username")}) AS name FROM ${q("users")} WHERE role = 'admin' AND ${q("accountEnabled")} = ${boolLiteral(true)} ORDER BY id`,
  );
}
export async function deleteSupportTicket(
  actor: SupportActor,
  id: number,
  version: number,
) {
  if (actor.role !== "admin") throw forbidden();
  return withDatabaseTransaction(async () => {
    const ticket = await getSupportTicket(actor, id);
    requireVersion(ticket, version);
    if (ticket.status !== "closed") throw bad("请先关闭工单，再删除历史记录");
    // Claim the revision before cleanup; an in-flight reply/reopen must conflict.
    await updateTicket(ticket, {}, false);
    for (const table of [
      "support_ticket_attachments",
      "support_ticket_messages",
      "support_ticket_reads",
    ])
      await executeRaw(`DELETE FROM ${q(table)} WHERE ${q("ticketId")} = ?`, [
        id,
      ]);
    await executeRaw(`DELETE FROM ${q("support_tickets")} WHERE id = ?`, [id]);
  });
}
export async function supportCannedReplies() {
  return queryRaw<{ id: number; title: string; content: string }>(
    `SELECT id, title, content FROM ${q("support_canned_replies")} ORDER BY id DESC LIMIT 100`,
  );
}
export async function saveSupportCannedReply(input: {
  id?: number;
  title: string;
  content: string;
}) {
  if (input.id)
    await executeRaw(
      `UPDATE ${q("support_canned_replies")} SET title = ?, content = ?, ${q("updatedAt")} = ? WHERE id = ?`,
      [input.title, input.content, now(), input.id],
    );
  else {
    const [count] = await queryRaw<{ total: number }>(
      `SELECT COUNT(*) AS total FROM ${q("support_canned_replies")}`,
    );
    if (Number(count.total) >= 100) throw bad("快捷回复最多 100 条");
    await insertAndGetId("support_canned_replies", {
      title: input.title,
      content: input.content,
      updatedAt: now(),
    });
  }
}
export async function deleteSupportCannedReply(id: number) {
  await executeRaw(`DELETE FROM ${q("support_canned_replies")} WHERE id = ?`, [
    id,
  ]);
}
