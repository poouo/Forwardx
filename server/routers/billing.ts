import { z } from "zod";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { appendPanelLog } from "../_core/panelLogger";
import * as db from "../db";
import { refreshUserForwardEndpoints } from "./helpers";
import { adjustUserBalanceCommand, setUserBalanceCommand } from "../services/userCommandService";
import { clearForwardxAiSettingsCache } from "../ai/settings";

const dateInput = z.string().trim().optional().nullable();

function parseDate(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function getRequestIp(ctx: { req: { ip?: string; socket: { remoteAddress?: string } } }) {
  return ctx.req.ip || ctx.req.socket.remoteAddress || "unknown";
}

export const billingRouter = router({
  featureStatus: protectedProcedure.query(async () => ({
    redemptionEnabled: (await db.getSetting("redemptionEnabled")) !== "false",
    discountEnabled: (await db.getSetting("discountEnabled")) !== "false",
  })),

  setFeatureStatus: adminProcedure
    .input(z.object({
      redemptionEnabled: z.boolean().optional(),
      discountEnabled: z.boolean().optional(),
    }))
    .mutation(async ({ input }) => {
      if (input.redemptionEnabled !== undefined) await db.setSetting("redemptionEnabled", input.redemptionEnabled ? "true" : "false");
      if (input.discountEnabled !== undefined) await db.setSetting("discountEnabled", input.discountEnabled ? "true" : "false");
      clearForwardxAiSettingsCache();
      appendPanelLog("info", `[Billing] feature status updated redemption=${input.redemptionEnabled ?? "-"} discount=${input.discountEnabled ?? "-"}`);
      return {
        redemptionEnabled: (await db.getSetting("redemptionEnabled")) !== "false",
        discountEnabled: (await db.getSetting("discountEnabled")) !== "false",
      };
    }),

  me: protectedProcedure.query(async ({ ctx }) => {
    const balanceCents = await db.getUserBalance(ctx.user.id);
    const transactions = await db.listBalanceTransactions(ctx.user.id, 50);
    return { balanceCents, transactions };
  }),

  listTransactions: adminProcedure
    .input(z.object({ userId: z.number().int().positive().optional(), limit: z.number().int().min(1).max(500).default(100) }).optional())
    .query(async ({ input }) => db.listBalanceTransactions(input?.userId, input?.limit || 100)),

  ledger: protectedProcedure
    .input(z.object({
      userId: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }).optional())
    .query(async ({ input, ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      return db.listBillingLedger({
        viewerUserId: ctx.user.id,
        isAdmin,
        userId: isAdmin ? input?.userId : undefined,
        limit: input?.limit || 100,
      });
    }),

  adminRecharge: adminProcedure
    .input(z.object({
      userId: z.number().int().positive(),
      amountCents: z.number().int().min(1).max(100_000_000),
      description: z.string().trim().max(200).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const result = await adjustUserBalanceCommand({
        actor: ctx.user,
        targetUserId: input.userId,
        amountCents: input.amountCents,
        description: input.description || "管理员手动充值",
        reasonPrefix: "balance-recharged",
      });
      appendPanelLog("info", `[Balance] admin recharge user=${input.userId} amount=${input.amountCents} operator=${ctx.user.id}`);
      return result;
    }),


  adminSetBalance: adminProcedure
    .input(z.object({
      userId: z.number().int().positive(),
      balanceCents: z.number().int().min(0).max(100_000_000),
      description: z.string().trim().max(200).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const result = await setUserBalanceCommand({
        actor: ctx.user,
        targetUserId: input.userId,
        balanceCents: input.balanceCents,
        description: input.description || "管理员手动修改余额",
        reasonPrefix: "balance-adjusted",
      });
      appendPanelLog("info", `[Balance] admin set user=${input.userId} balance=${input.balanceCents} delta=${result.amountCents} operator=${ctx.user.id}`);
      return result;
    }),
  purchasePlanWithBalance: protectedProcedure
    .input(z.object({
      planId: z.number().int().positive(),
      discountCode: z.string().trim().max(64).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const plan = await db.getSubscriptionPlanById(input.planId);
      if (!plan || !plan.isActive || !plan.isStoreVisible) throw new Error("套餐不可购买");
      let discountCodeId: number | null = null;
      if (input.discountCode) {
        if ((await db.getSetting("discountEnabled")) === "false") throw new Error("折扣码功能已关闭");
        const preview = await db.previewDiscount(input.discountCode, Number(plan.priceCents || 0), input.planId);
        discountCodeId = preview.discountCodeId;
      }
      const result = await db.purchasePlanWithBalance(ctx.user.id, input.planId, discountCodeId);
      await refreshUserForwardEndpoints(ctx.user.id, "balance-plan-purchased");
      appendPanelLog("info", `[Plan] balance purchase user=${ctx.user.id} plan=${input.planId}`);
      return result;
    }),

  purchaseTrafficAddonWithBalance: protectedProcedure
    .input(z.object({
      addonId: z.number().int().positive(),
      subscriptionId: z.number().int().positive().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const result = await db.purchaseTrafficAddonWithBalance(ctx.user.id, input.addonId, input.subscriptionId);
      await refreshUserForwardEndpoints(ctx.user.id, "traffic-addon-purchased");
      appendPanelLog("info", `[TrafficAddon] balance purchase user=${ctx.user.id} addon=${input.addonId} bytes=${result.trafficBytes}`);
      return result;
    }),

  adminAddTrafficAddon: adminProcedure
    .input(z.object({
      userId: z.number().int().positive(),
      trafficBytes: z.number().int().positive(),
      subscriptionId: z.number().int().positive().optional().nullable(),
      description: z.string().trim().max(200).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const result = await db.adminAddUserTrafficAddon({
        userId: input.userId,
        trafficBytes: input.trafficBytes,
        subscriptionId: input.subscriptionId ?? null,
        operatorUserId: ctx.user.id,
        description: input.description || null,
      });
      await refreshUserForwardEndpoints(input.userId, "traffic-addon-admin");
      appendPanelLog("info", `[TrafficAddon] admin add user=${input.userId} operator=${ctx.user.id} bytes=${input.trafficBytes}`);
      return result;
    }),

  previewDiscount: protectedProcedure
    .input(z.object({
      code: z.string().trim().min(1).max(64),
      amountCents: z.number().int().min(0).max(100_000_000),
      planId: z.number().int().positive().optional(),
    }))
    .mutation(async ({ input }) => {
      if ((await db.getSetting("discountEnabled")) === "false") throw new Error("折扣码功能已关闭");
      return db.previewDiscount(input.code, input.amountCents, input.planId);
    }),

  redeem: protectedProcedure
    .input(z.object({ code: z.string().trim().min(1).max(64) }))
    .mutation(async ({ input, ctx }) => {
      if ((await db.getSetting("redemptionEnabled")) === "false") throw new Error("兑换码功能已关闭");
      const result = await db.redeemCode(ctx.user.id, input.code, getRequestIp(ctx));
      const recovery = await db.recoverUserForwardAccessIfEligible(ctx.user.id);
      await refreshUserForwardEndpoints(ctx.user.id, "code-redeemed");
      appendPanelLog("info", `[Redeem] user=${ctx.user.id} type=${result.type}`);
      return { ...result, forwardAccessRestored: recovery.restored };
    }),

  listRedemptionCodes: adminProcedure.query(async () => db.listRedemptionCodes()),

  createRedemptionCodes: adminProcedure
    .input(z.object({
      type: z.enum(["plan", "balance"]),
      code: z.string().trim().max(64).optional(),
      count: z.number().int().min(1).max(500).default(1),
      planId: z.number().int().positive().optional().nullable(),
      durationDays: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365)]).optional().nullable(),
      amountCents: z.number().int().min(0).max(100_000_000).default(0),
      startsAt: dateInput,
      expiresAt: dateInput,
    }))
    .mutation(async ({ input, ctx }) => {
      if (input.type === "plan" && !input.planId) throw new Error("套餐兑换码必须选择套餐");
      if (input.type === "balance" && input.amountCents <= 0) throw new Error("余额兑换码金额必须大于 0");
      const codes = await db.createRedemptionCodes({
        type: input.type,
        code: input.code || undefined,
        planId: input.type === "plan" ? input.planId ?? null : null,
        durationDays: input.type === "plan" ? input.durationDays ?? 30 : null,
        amountCents: input.type === "balance" ? input.amountCents : 0,
        startsAt: parseDate(input.startsAt),
        expiresAt: parseDate(input.expiresAt),
        isActive: true,
        createdByUserId: ctx.user.id,
      } as any, input.count);
      appendPanelLog("info", `[Redeem] created count=${codes.length} type=${input.type}`);
      return { codes };
    }),

  deleteRedemptionCode: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db.deleteRedemptionCode(input.id);
      return { success: true };
    }),

  deleteRedemptionCodes: adminProcedure
    .input(z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) }))
    .mutation(async ({ input }) => {
      const ids = Array.from(new Set(input.ids));
      for (const id of ids) await db.deleteRedemptionCode(id);
      return { success: true, deleted: ids.length };
    }),

  listDiscountCodes: adminProcedure.query(async () => db.listDiscountCodes()),

  createDiscountCode: adminProcedure
    .input(z.object({
      code: z.string().trim().max(64).optional(),
      discountType: z.enum(["percent", "amount"]),
      discountValue: z.number().int().min(1).max(100_000_000),
      maxUses: z.number().int().min(0).max(1_000_000).default(0),
      planIds: z.array(z.number().int().positive()).default([]),
      startsAt: dateInput,
      expiresAt: dateInput,
    }))
    .mutation(async ({ input, ctx }) => {
      if (input.discountType === "percent" && input.discountValue > 100) throw new Error("百分比折扣不能超过 100");
      return db.createDiscountCode({
        code: input.code || undefined,
        discountType: input.discountType,
        discountValue: input.discountValue,
        maxUses: input.maxUses,
        startsAt: parseDate(input.startsAt),
        expiresAt: parseDate(input.expiresAt),
        isActive: true,
        createdByUserId: ctx.user.id,
      } as any, input.planIds);
    }),

  deleteDiscountCode: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db.deleteDiscountCode(input.id);
      return { success: true };
    }),
});
