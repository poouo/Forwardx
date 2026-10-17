import { z } from "zod";
import {
  adminProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from "../_core/trpc";
import * as affiliates from "../repositories/affiliateRepository";
import { refreshUserForwardEndpoints } from "./helpers";
import { appendPanelLog } from "../_core/panelLogger";
import { resolvePanelUrl } from "../agentPanelUrl";
import { withDatabaseTransaction } from "../dbRuntime";
import { setSetting } from "../repositories/settingsRepository";

const id = z.number().int().positive();
const money = z.number().int().min(1).max(100_000_000);
const requestKey = z.string().uuid();
const list = z.object({
  kind: z.enum(["commissions", "withdrawals", "ledger", "referrals"]),
  page: z.number().int().min(1).max(1_000_000).default(1),
  status: z
    .enum(["all", "pending", "available", "cancelled", "paid", "rejected"])
    .default("all"),
  userId: id.optional(),
});
const tables = {
  commissions: "affiliate_commissions",
  withdrawals: "affiliate_withdrawals",
  ledger: "affiliate_ledger",
  referrals: "affiliate_referrals",
} as const;
export const affiliatesRouter = router({
  registrationStatus: publicProcedure.query(async () => ({
    enabled: await affiliates.affiliatesEnabled(),
  })),
  status: protectedProcedure.query(({ ctx }) =>
    affiliates.affiliateStatus(ctx.user.id),
  ),
  me: protectedProcedure.query(async ({ ctx }) => ({
    ...(await affiliates.affiliateOverview(ctx.user.id)),
    panelUrl: await resolvePanelUrl(ctx.req),
  })),
  createCode: protectedProcedure.mutation(({ ctx }) =>
    affiliates.createAffiliateCode(ctx.user.id),
  ),
  setCodeActive: protectedProcedure
    .input(z.object({ id, active: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await affiliates.setAffiliateCodeActive(
        ctx.user.id,
        input.id,
        input.active,
      );
      return { success: true };
    }),
  list: protectedProcedure.input(list).query(({ ctx, input }) =>
    affiliates.listAffiliateRows(tables[input.kind], {
      ...input,
      userId: ctx.user.id,
    }),
  ),
  requestWithdrawal: protectedProcedure
    .input(
      z.object({
        amountCents: money,
        method: z.enum(["alipay", "wxpay", "bank"]),
        account: z.string().trim().min(1).max(500),
        payee: z.string().trim().min(1).max(120),
        requestKey,
      }),
    )
    .mutation(({ ctx, input }) =>
      affiliates.requestAffiliateWithdrawal(ctx.user.id, input),
    ),
  transfer: protectedProcedure
    .input(z.object({ amountCents: money, requestKey }))
    .mutation(async ({ ctx, input }) => {
      await affiliates.transferAffiliateBalance(
        ctx.user.id,
        input.amountCents,
        input.requestKey,
      );
      await refreshUserForwardEndpoints(
        ctx.user.id,
        "affiliate-balance-transferred",
      );
      return { success: true };
    }),
  adminOverview: adminProcedure
    .input(
      z.object({
        page: z.number().int().min(1).max(1_000_000).default(1),
        search: z.string().trim().max(100).default(""),
      }),
    )
    .query(({ input }) =>
      affiliates.affiliateAdminOverview(input.page, input.search),
    ),
  adminList: adminProcedure
    .input(list)
    .query(({ input }) =>
      affiliates.listAffiliateRows(tables[input.kind], input),
    ),
  saveConfig: adminProcedure
    .input(affiliates.affiliateSettingsInput)
    .mutation(async ({ ctx, input }) => {
      await withDatabaseTransaction(async () => {
        await affiliates.saveAffiliateConfig(input);
        await setSetting("affiliateEnabled", String(input.enabled));
      });
      appendPanelLog(
        "info",
        `[Affiliate] settings updated operator=${ctx.user.id} enabled=${input.enabled}`,
      );
      return { success: true };
    }),
  updateAccount: adminProcedure
    .input(
      z.object({
        userId: id,
        blocked: z.boolean(),
        rateBps: z.number().int().min(0).max(10000).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await affiliates.updateAffiliateAccount(
        ctx.user.id,
        input.userId,
        input.blocked,
        input.rateBps,
      );
      return { success: true };
    }),
  reviewWithdrawal: adminProcedure
    .input(
      z.object({
        id,
        status: z.enum(["paid", "rejected"]),
        note: z.string().trim().min(1).max(1000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await affiliates.reviewAffiliateWithdrawal(
        ctx.user.id,
        input.id,
        input.status,
        input.note,
      );
      appendPanelLog(
        "info",
        `[Affiliate] withdrawal=${input.id} status=${input.status} operator=${ctx.user.id}`,
      );
      return { success: true };
    }),
  cancelCommission: adminProcedure
    .input(z.object({ id, reason: z.string().trim().min(1).max(1000) }))
    .mutation(async ({ ctx, input }) => {
      await affiliates.cancelAffiliateCommission(
        ctx.user.id,
        input.id,
        input.reason,
      );
      appendPanelLog(
        "info",
        `[Affiliate] commission cancelled id=${input.id} operator=${ctx.user.id}`,
      );
      return { success: true };
    }),
});
