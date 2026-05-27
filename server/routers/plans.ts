import { z } from "zod";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { appendPanelLog } from "../_core/panelLogger";
import * as db from "../db";
import { refreshUserForwardEndpoints } from "./helpers";

const planInput = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).nullable().optional(),
  priceCents: z.number().int().min(0).max(100_000_000),
  currency: z.string().trim().min(3).max(8).default("CNY"),
  durationDays: z.union([
    z.literal(30),
    z.literal(90),
    z.literal(180),
    z.literal(365),
    z.literal(730),
  ]).default(30),
  portCount: z.number().int().min(1).max(1024).default(20),
  trafficLimit: z.number().int().min(0).default(0),
  rateLimitMbps: z.number().int().min(0).default(0),
  maxRules: z.number().int().min(0).default(20),
  maxConnections: z.number().int().min(0).max(1_000_000).default(2000),
  maxIPs: z.number().int().min(0).max(100_000).default(10),
  isActive: z.boolean().default(true),
  isStoreVisible: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  hostIds: z.array(z.number().int().positive()).default([]),
  tunnelIds: z.array(z.number().int().positive()).default([]),
});

export const plansRouter = router({
  storeStatus: protectedProcedure.query(async () => {
    return { enabled: (await db.getSetting("storeEnabled")) === "true" };
  }),
  setStoreEnabled: adminProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      await db.setSetting("storeEnabled", input.enabled ? "true" : "false");
      appendPanelLog("info", `[Store] ${input.enabled ? "enabled" : "disabled"}`);
      return { success: true };
    }),
  list: adminProcedure.query(async () => {
    return db.listSubscriptionPlans(true);
  }),
  storeList: protectedProcedure.query(async () => {
    if ((await db.getSetting("storeEnabled")) !== "true") return [];
    return db.listSubscriptionPlans(false);
  }),
  create: adminProcedure
    .input(planInput)
    .mutation(async ({ input }) => {
      const { hostIds, tunnelIds, ...data } = input;
      if (hostIds.length === 0 && tunnelIds.length === 0) throw new Error("套餐至少需要绑定一个主机或隧道");
      return db.createSubscriptionPlan({
        ...data,
        description: data.description || null,
        currency: data.currency.toUpperCase(),
      } as any, hostIds, tunnelIds);
    }),
  update: adminProcedure
    .input(planInput.extend({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const { id, hostIds, tunnelIds, ...data } = input;
      if (hostIds.length === 0 && tunnelIds.length === 0) throw new Error("套餐至少需要绑定一个主机或隧道");
      return db.updateSubscriptionPlan(id, {
        ...data,
        description: data.description || null,
        currency: data.currency.toUpperCase(),
      } as any, hostIds, tunnelIds);
    }),
  delete: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db.deleteSubscriptionPlan(input.id);
      return { success: true };
    }),
  subscriptions: adminProcedure
    .input(z.object({ userId: z.number().optional() }).optional())
    .query(async ({ input }) => {
      await db.expireUserSubscriptions();
      return db.listUserSubscriptions(input?.userId);
    }),
  mySubscriptions: protectedProcedure.query(async ({ ctx }) => {
    await db.expireUserSubscriptions();
    return db.listUserSubscriptions(ctx.user.id);
  }),
  assign: adminProcedure
    .input(z.object({
      userId: z.number().int().positive(),
      planId: z.number().int().positive(),
    }))
    .mutation(async ({ input }) => {
      const result = await db.applySubscriptionToUser(input.userId, input.planId, "admin", null);
      await refreshUserForwardEndpoints(input.userId, "plan-assigned");
      appendPanelLog("info", `[Plan] assigned user=${input.userId} plan=${input.planId} ports=${result.portRangeStart}-${result.portRangeEnd}`);
      return result;
    }),
  cancelSubscription: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const subscriptions = await db.listUserSubscriptions();
      const subscription = (subscriptions as any[]).find((item) => Number(item.id) === Number(input.id));
      await db.cancelUserSubscription(input.id);
      if (subscription?.userId) {
        await db.syncUserSubscriptionEntitlements(Number(subscription.userId));
        await refreshUserForwardEndpoints(Number(subscription.userId), "subscription-cancelled");
      }
      return { success: true };
    }),
});
