import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { appendPanelLog } from "../_core/panelLogger";
import { withDatabaseTransaction } from "../dbRuntime";
import * as tickets from "../repositories/supportTicketRepository";
import { notifySupportTicket } from "../supportTicketNotifications";
import { getAllSettings, setSetting } from "../repositories/settingsRepository";
import {
  TICKET_ATTACHMENT_MAX_BYTES,
  TICKET_ATTACHMENT_MAX_COUNT,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_SERVICE_TYPES,
  TICKET_STATUSES,
} from "../../shared/supportTickets";

const procedure = protectedProcedure.use(async ({ next }) => {
  await tickets.requireSupportTicketsEnabled();
  return next();
});
const staffProcedure = adminProcedure.use(async ({ next }) => {
  await tickets.requireSupportTicketsEnabled();
  return next();
});
const id = z.number().int().positive();
const revision = z.object({ id, version: z.number().int().positive() });
const attachments = z
  .array(
    z.object({
      name: z.string().min(1).max(160),
      mime: z.string().max(64),
      base64: z.string().max(Math.ceil(TICKET_ATTACHMENT_MAX_BYTES / 3) * 4),
    }),
  )
  .max(TICKET_ATTACHMENT_MAX_COUNT)
  .default([]);
const content = z.string().trim().max(20000);
const message = z
  .object({ content, attachments })
  .refine((v) => v.content.length > 0 || v.attachments.length > 0, {
    message: "请填写内容或添加附件",
  });

export const supportTicketsRouter = router({
  settings: adminProcedure.query(async () => {
    const settings = await getAllSettings();
    return {
      enabled: settings.supportTicketsEnabled === "true",
      notificationsEnabled: settings.supportTicketNotificationsEnabled !== "false",
    };
  }),
  saveSettings: adminProcedure
    .input(z.object({ enabled: z.boolean().optional(), notificationsEnabled: z.boolean().optional() })
      .refine(input => input.enabled !== undefined || input.notificationsEnabled !== undefined))
    .mutation(async ({ ctx, input }) => {
      await withDatabaseTransaction(async () => {
        if (input.enabled !== undefined) await setSetting("supportTicketsEnabled", String(input.enabled));
        if (input.notificationsEnabled !== undefined) await setSetting("supportTicketNotificationsEnabled", String(input.notificationsEnabled));
      });
      appendPanelLog("info", `[Support] settings updated operator=${ctx.user.id} enabled=${input.enabled ?? "unchanged"} notificationsEnabled=${input.notificationsEnabled ?? "unchanged"}`);
      return { success: true };
    }),
  status: protectedProcedure.query(async () => ({
    enabled: await tickets.supportTicketsEnabled(),
  })),
  summary: procedure.query(({ ctx }) => tickets.supportTicketSummary(ctx.user)),
  services: procedure
    .input(
      z
        .object({
          search: z.string().trim().max(120).optional(),
          type: z.enum(TICKET_SERVICE_TYPES).optional(),
          offset: z.number().int().min(0).max(100000).optional(),
        })
        .default({}),
    )
    .query(({ ctx, input }) => tickets.listSupportServices(ctx.user, input)),
  list: procedure
    .input(
      z.object({
        page: z.number().int().min(1).max(100000).default(1),
        search: z.string().trim().max(120).optional(),
        status: z.enum(TICKET_STATUSES).optional(),
        priority: z.enum(TICKET_PRIORITIES).optional(),
        category: z.enum(TICKET_CATEGORIES).optional(),
        assigned: z.enum(["me", "unassigned"]).optional(),
        unread: z.boolean().optional(),
      }),
    )
    .query(({ ctx, input }) => tickets.listSupportTickets(ctx.user, input)),
  detail: procedure
    .input(z.object({ id }))
    .query(({ ctx, input }) => tickets.supportTicketDetail(ctx.user, input.id)),
  messages: procedure
    .input(z.object({ id, cursor: id.nullish() }))
    .query(({ ctx, input }) =>
      tickets.supportTicketMessages(
        ctx.user,
        input.id,
        input.cursor || undefined,
      ),
    ),
  markRead: procedure.input(revision).mutation(async ({ ctx, input }) => {
    await tickets.readSupportTicket(ctx.user, input.id, input.version);
    return { success: true };
  }),
  create: procedure
    .input(
      z
        .object({
          title: z.string().trim().min(1).max(160),
          priority: z.enum(TICKET_PRIORITIES).default("normal"),
          category: z.enum(TICKET_CATEGORIES).default("technical"),
          service: z
            .object({ type: z.enum(TICKET_SERVICE_TYPES), id })
            .nullish(),
        })
        .and(message),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await tickets.createSupportTicket(ctx.user, input);
      appendPanelLog(
        "info",
        `[Support] created ticket=${result.id} user=${ctx.user.id}`,
      );
      notifySupportTicket(ctx.user, result.id, true);
      return result;
    }),
  reply: procedure
    .input(
      revision
        .extend({
          content,
          attachments,
          internal: z.boolean().default(false),
          status: z.enum(TICKET_STATUSES).optional(),
        })
        .refine((v) => v.content.length > 0 || v.attachments.length > 0, {
          message: "请填写内容或添加附件",
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await tickets.replySupportTicket(ctx.user, input);
      appendPanelLog(
        "info",
        `[Support] ${input.internal ? "note" : "reply"} ticket=${input.id} user=${ctx.user.id}`,
      );
      if (!input.internal) notifySupportTicket(ctx.user, input.id);
      return result;
    }),
  update: procedure
    .input(
      revision.extend({
        status: z.enum(TICKET_STATUSES).optional(),
        priority: z.enum(TICKET_PRIORITIES).optional(),
        category: z.enum(TICKET_CATEGORIES).optional(),
        assignedTo: id.nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await tickets.updateSupportTicket(ctx.user, input);
      appendPanelLog(
        "info",
        `[Support] updated ticket=${input.id} user=${ctx.user.id}`,
      );
      if (input.status || input.priority || input.category)
        notifySupportTicket(ctx.user, input.id);
      return result;
    }),
  bulkStatus: staffProcedure
    .input(
      z.object({
        tickets: z.array(revision).min(1).max(50),
        status: z.enum(TICKET_STATUSES),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (new Set(input.tickets.map((t) => t.id)).size !== input.tickets.length)
        throw new TRPCError({ code: "BAD_REQUEST", message: "工单重复" });
      await withDatabaseTransaction(async () => {
        for (const ticket of [...input.tickets].sort((a, b) => a.id - b.id))
          await tickets.updateSupportTicket(ctx.user, {
            ...ticket,
            status: input.status,
          });
      });
      for (const ticket of input.tickets)
        notifySupportTicket(ctx.user, ticket.id);
      appendPanelLog(
        "info",
        `[Support] bulk status=${input.status} count=${input.tickets.length} user=${ctx.user.id}`,
      );
      return { success: true };
    }),
  rate: procedure
    .input(
      revision.extend({
        rating: z.number().int().min(1).max(5),
        comment: z.string().trim().max(1000).default(""),
      }),
    )
    .mutation(({ ctx, input }) => tickets.rateSupportTicket(ctx.user, input)),
  delete: staffProcedure.input(revision).mutation(async ({ ctx, input }) => {
    await tickets.deleteSupportTicket(ctx.user, input.id, input.version);
    appendPanelLog(
      "info",
      `[Support] deleted ticket=${input.id} user=${ctx.user.id}`,
    );
    return { success: true };
  }),
  attachment: procedure
    .input(z.object({ id }))
    .query(({ ctx, input }) =>
      tickets.supportTicketAttachment(ctx.user, input.id),
    ),
  staff: staffProcedure.query(() => tickets.supportStaff()),
  cannedReplies: staffProcedure.query(() => tickets.supportCannedReplies()),
  saveCannedReply: staffProcedure
    .input(
      z.object({
        id: id.optional(),
        title: z.string().trim().min(1).max(120),
        content: z.string().trim().min(1).max(20000),
      }),
    )
    .mutation(async ({ input }) => {
      await tickets.saveSupportCannedReply(input);
      return { success: true };
    }),
  deleteCannedReply: staffProcedure
    .input(z.object({ id }))
    .mutation(async ({ input }) => {
      await tickets.deleteSupportCannedReply(input.id);
      return { success: true };
    }),
});
