import { z } from "zod";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { appendPanelLog } from "../_core/panelLogger";
import * as db from "../db";

const resourceTypeSchema = z.enum(["host", "tunnel", "forward_group"]);

export const trafficBillingRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const [summary, usableResourceIds] = await Promise.all([
      db.getTrafficBillingSummary(ctx.user.id),
      ctx.user.role === "admin"
        ? Promise.resolve({ hostIds: [], tunnelIds: [], forwardGroupIds: [] })
        : db.getUserUsableTrafficBillingResourceIds(ctx.user.id),
    ]);
    return {
      ...summary,
      usableResourceIds,
      hasUsableResources: usableResourceIds.hostIds.length > 0 || usableResourceIds.tunnelIds.length > 0 || usableResourceIds.forwardGroupIds.length > 0,
    };
  }),

  configs: adminProcedure.query(async () => {
    const [enabled, configs] = await Promise.all([
      db.isTrafficBillingEnabled(),
      db.listTrafficBillingConfigs(),
    ]);
    return { enabled, configs };
  }),

  storeResources: protectedProcedure.query(async () => {
    const enabled = await db.isTrafficBillingEnabled();
    if (!enabled) return { enabled, configs: [] };
    return {
      enabled,
      configs: (await db.listTrafficBillingConfigs()).filter((item: any) => item.enabled && !item.requiresPermission),
    };
  }),

  setEnabled: adminProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      await db.setSetting("trafficBillingEnabled", input.enabled ? "true" : "false");
      appendPanelLog("info", `[TrafficBilling] feature ${input.enabled ? "enabled" : "disabled"}`);
      return { enabled: input.enabled };
    }),

  saveConfig: adminProcedure
    .input(z.object({
      id: z.number().optional(),
      resourceType: resourceTypeSchema,
      resourceId: z.number().int().positive(),
      enabled: z.boolean().default(true),
      requiresPermission: z.boolean().default(false),
      description: z.string().trim().max(500).optional(),
      pricePerGbCents: z.number().int().min(0).max(100_000_000).optional(),
      pricePerGbMilliCents: z.number().int().min(0).max(100_000_000_000).optional(),
      multiplier: z.number().int().min(1).max(5000).optional(),
    }))
    .mutation(async ({ input }) => {
      const config = await db.upsertTrafficBillingConfig(input as any);
      appendPanelLog("info", `[TrafficBilling] config saved ${input.resourceType}=${input.resourceId} priceMilli=${input.pricePerGbMilliCents ?? 0} requiresPermission=${input.requiresPermission}`);
      return config;
    }),

  deleteConfig: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db.deleteTrafficBillingConfig(input.id);
      return { success: true };
    }),

  records: protectedProcedure
    .input(z.object({
      userId: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }).optional())
    .query(async ({ input, ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      return db.listTrafficBillingRecords({
        userId: isAdmin ? input?.userId : ctx.user.id,
        limit: input?.limit || 100,
      });
    }),
});
