import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { AFFILIATE_DEFAULTS, commissionCents } from "../../shared/affiliate";
import { normalizeSidebarMenuSettings } from "../../shared/sidebarMenu";
import { boolLiteral, boolValue, quoteIdentifier as q } from "../dbCompat";
import {
  executeRaw,
  queryRaw,
  insertAndGetId,
  getDatabaseKind,
  withDatabaseTransaction,
} from "../dbRuntime";
import { getSetting, setSetting } from "./settingsRepository";
import {
  addUserBalance,
  recoverUserForwardAccessIfEligible,
} from "./billingRepository";
import { withTrafficBillingUserLock } from "../keyedTaskLock";

export const affiliateConfigInput = z.object({
  rateBps: z.number().int().min(0).max(10000),
  firstOrderOnly: z.boolean(),
  confirmationDays: z.number().int().min(0).max(365),
  minimumWithdrawalCents: z.number().int().min(1).max(100_000_000),
  allowBalanceTransfer: z.boolean(),
  maxCodes: z.number().int().min(1).max(50),
});
type Account = {
  userId: number;
  availableCents: number;
  blocked: boolean | number;
  rateBps: number | null;
};
type Commission = {
  id: number;
  userId: number;
  referredUserId: number;
  orderNo: string;
  orderAmountCents: number;
  amountCents: number;
  rateBps: number;
  status: string;
  confirmAt: number;
  reason: string | null;
  createdAt: number;
  settledAt: number | null;
};
type Withdrawal = {
  id: number;
  userId: number;
  amountCents: number;
  method: string;
  account: string;
  payee: string;
  status: string;
  note: string | null;
  operatorUserId: number | null;
  requestKey: string;
  createdAt: number;
  reviewedAt: number | null;
};
type Code = {
  id: number;
  userId: number;
  code: string;
  active: boolean | number;
  createdAt: number;
};
const now = () => Math.floor(Date.now() / 1000);
const lockedRead = () => (getDatabaseKind() === "sqlite" ? "" : " FOR UPDATE");
const fail = (message: string) =>
  new TRPCError({ code: "BAD_REQUEST", message });
export async function affiliatesEnabled() {
  try {
    return normalizeSidebarMenuSettings(
      JSON.parse((await getSetting("sidebarMenu")) || "{}"),
    ).affiliates;
  } catch {
    return false;
  }
}
export async function affiliateConfig() {
  try {
    return affiliateConfigInput.parse({
      ...AFFILIATE_DEFAULTS,
      ...JSON.parse((await getSetting("affiliateConfig")) || "{}"),
    });
  } catch {
    return { ...AFFILIATE_DEFAULTS };
  }
}
export async function saveAffiliateConfig(
  input: z.infer<typeof affiliateConfigInput>,
) {
  await setSetting(
    "affiliateConfig",
    JSON.stringify(affiliateConfigInput.parse(input)),
  );
}
async function requireEnabled() {
  if (!(await affiliatesEnabled()))
    throw new TRPCError({ code: "FORBIDDEN", message: "推广返佣未开启" });
}
async function lockAccount(userId: number) {
  const cols = `${q("userId")}, ${q("availableCents")}, ${q("blocked")}, ${q("createdAt")}`;
  const conflict =
    getDatabaseKind() === "mysql"
      ? `ON DUPLICATE KEY UPDATE ${q("userId")} = VALUES(${q("userId")})`
      : `ON CONFLICT (${q("userId")}) DO UPDATE SET ${q("userId")} = excluded.${q("userId")}`;
  // A real database row lock serializes all wallet changes across panel instances.
  await executeRaw(
    `INSERT INTO ${q("affiliate_accounts")} (${cols}) VALUES (?, 0, ?, ?) ${conflict}`,
    [userId, boolValue(false), now()],
  );
  const [account] = await queryRaw<Account>(
    `SELECT * FROM ${q("affiliate_accounts")} WHERE ${q("userId")} = ?${lockedRead()}`,
    [userId],
  );
  return account;
}
async function ledger(
  userId: number,
  type: string,
  amountCents: number,
  reference: string,
  operatorUserId?: number,
  note?: string,
) {
  await executeRaw(
    `UPDATE ${q("affiliate_accounts")} SET ${q("availableCents")} = ${q("availableCents")} + ? WHERE ${q("userId")} = ?`,
    [amountCents, userId],
  );
  const [account] = await queryRaw<Account>(
    `SELECT * FROM ${q("affiliate_accounts")} WHERE ${q("userId")} = ?`,
    [userId],
  );
  await insertAndGetId("affiliate_ledger", {
    userId,
    type,
    amountCents,
    balanceAfterCents: Number(account.availableCents),
    reference,
    operatorUserId: operatorUserId ?? null,
    note: note || null,
    createdAt: now(),
  });
}
async function settleLocked(userId: number) {
  const due = await queryRaw<Commission>(
    `SELECT * FROM ${q("affiliate_commissions")} WHERE ${q("userId")} = ? AND status = 'pending' AND ${q("confirmAt")} <= ? ORDER BY id${lockedRead()}`,
    [userId, now()],
  );
  for (const row of due) {
    await executeRaw(
      `UPDATE ${q("affiliate_commissions")} SET status = 'available', ${q("settledAt")} = ? WHERE id = ? AND status = 'pending'`,
      [now(), row.id],
    );
    await ledger(userId, "commission", Number(row.amountCents), String(row.id));
  }
}
export async function settleAffiliateCommissions(userId?: number) {
  const accounts = await queryRaw<{ userId: number }>(
    `SELECT DISTINCT ${q("userId")} FROM ${q("affiliate_commissions")} WHERE status = 'pending' AND ${q("confirmAt")} <= ?${userId ? ` AND ${q("userId")} = ?` : ""} LIMIT 200`,
    userId ? [now(), userId] : [now()],
  );
  for (const account of accounts)
    await withDatabaseTransaction(async () => {
      await lockAccount(Number(account.userId));
      await settleLocked(Number(account.userId));
    });
}
export async function createAffiliateCode(userId: number) {
  await requireEnabled();
  return withDatabaseTransaction(async () => {
    const account = await lockAccount(userId);
    if (account.blocked) throw fail("推广账户已停用");
    const config = await affiliateConfig();
    const [count] = await queryRaw<{ total: number }>(
      `SELECT COUNT(*) AS total FROM ${q("affiliate_codes")} WHERE ${q("userId")} = ?`,
      [userId],
    );
    if (Number(count.total) >= config.maxCodes)
      throw fail("邀请码数量已达上限");
    const code = crypto.randomBytes(10).toString("hex");
    const id = await insertAndGetId("affiliate_codes", {
      userId,
      code,
      active: boolValue(true),
      createdAt: now(),
    });
    return { id, code };
  });
}
export async function setAffiliateCodeActive(
  userId: number,
  id: number,
  active: boolean,
) {
  return withDatabaseTransaction(async () => {
    const account = await lockAccount(userId);
    if (active) {
      await requireEnabled();
      if (account.blocked) throw fail("推广账户已停用");
    }
    await executeRaw(
      `UPDATE ${q("affiliate_codes")} SET active = ? WHERE id = ? AND ${q("userId")} = ?`,
      [boolValue(active), id, userId],
    );
  });
}
// Registration is the only binding point: never rebind an existing account.
export async function bindAffiliateReferral(userId: number, code?: string) {
  return withDatabaseTransaction(() =>
    bindAffiliateReferralLocked(userId, code),
  );
}
async function bindAffiliateReferralLocked(userId: number, code?: string) {
  if (!code || !(await affiliatesEnabled())) return false;
  const [invite] = await queryRaw<Code>(
    `SELECT * FROM ${q("affiliate_codes")} WHERE code = ? AND active = ${boolLiteral(true)}`,
    [code],
  );
  if (!invite || Number(invite.userId) === userId) return false;
  const [owner] = await queryRaw<{ id: number }>(
    `SELECT id FROM ${q("users")} WHERE id = ? AND ${q("accountEnabled")} = ${boolLiteral(true)}`,
    [invite.userId],
  );
  if (!owner) return false;
  const account = await lockAccount(Number(invite.userId));
  if (account.blocked) return false;
  const active = await queryRaw(
    `SELECT id FROM ${q("affiliate_codes")} WHERE id = ? AND active = ${boolLiteral(true)}${lockedRead()}`,
    [invite.id],
  );
  if (!active.length) return false;
  await insertAndGetId("affiliate_referrals", {
    userId,
    affiliateUserId: Number(invite.userId),
    codeId: invite.id,
    createdAt: now(),
  });
  return true;
}
// Must be called in the order-fulfillment transaction; no recharge/credits count.
export async function accrueAffiliateCommission(orderNo: string) {
  return withDatabaseTransaction(() =>
    accrueAffiliateCommissionLocked(orderNo),
  );
}
async function accrueAffiliateCommissionLocked(orderNo: string) {
  if (!(await affiliatesEnabled())) return;
  const [order] = await queryRaw<{
    userId: number;
    planId: number | null;
    amountCents: number;
    currency: string;
    status: string;
    createdAt: number;
    orderType: string;
  }>(`SELECT * FROM ${q("payment_orders")} WHERE ${q("outTradeNo")} = ?`, [
    orderNo,
  ]);
  if (
    !order ||
    order.status !== "completed" ||
    !order.planId ||
    order.orderType === "test" ||
    order.currency.toUpperCase() !== "CNY" ||
    Number(order.amountCents) <= 0
  )
    return;
  const [referral] = await queryRaw<{
    affiliateUserId: number;
    createdAt: number;
  }>(`SELECT * FROM ${q("affiliate_referrals")} WHERE ${q("userId")} = ?`, [
    order.userId,
  ]);
  if (
    !referral ||
    Number(referral.affiliateUserId) === Number(order.userId) ||
    Number(order.createdAt) < Number(referral.createdAt)
  )
    return;
  const [owner] = await queryRaw<{ id: number }>(
    `SELECT id FROM ${q("users")} WHERE id = ? AND ${q("accountEnabled")} = ${boolLiteral(true)}`,
    [referral.affiliateUserId],
  );
  if (!owner) return;
  const account = await lockAccount(Number(referral.affiliateUserId));
  if (account.blocked) return;
  const existing = await queryRaw(
    `SELECT id FROM ${q("affiliate_commissions")} WHERE ${q("orderNo")} = ?${lockedRead()}`,
    [orderNo],
  );
  if (existing.length) return;
  const config = await affiliateConfig();
  if (config.firstOrderOnly) {
    // Includes zero-rate/disabled-period purchases: changing settings never makes a later order the first order.
    const previous = await queryRaw(
      `SELECT id FROM ${q("payment_orders")} WHERE ${q("userId")} = ? AND ${q("outTradeNo")} <> ? AND ${q("planId")} IS NOT NULL AND ${q("amountCents")} > 0 AND COALESCE(${q("orderType")}, '') <> 'test' AND status = 'completed' LIMIT 1${lockedRead()}`,
      [order.userId, orderNo],
    );
    if (previous.length) return;
  }
  const rateBps =
    account.rateBps == null ? config.rateBps : Number(account.rateBps);
  const amountCents = commissionCents(Number(order.amountCents), rateBps);
  if (!amountCents) return;
  await insertAndGetId("affiliate_commissions", {
    userId: Number(referral.affiliateUserId),
    referredUserId: Number(order.userId),
    orderNo,
    orderAmountCents: Number(order.amountCents),
    amountCents,
    rateBps,
    status: "pending",
    confirmAt: now() + config.confirmationDays * 86400,
    createdAt: now(),
  });
  await settleLocked(Number(referral.affiliateUserId));
}
export async function affiliateStatus(userId: number) {
  const [row] = await queryRaw<{ total: number }>(
    `SELECT COUNT(*) AS total FROM ${q("affiliate_accounts")} WHERE ${q("userId")} = ?`,
    [userId],
  );
  return {
    enabled: await affiliatesEnabled(),
    hasHistory: Number(row.total) > 0,
  };
}
export async function affiliateOverview(userId: number) {
  await settleAffiliateCommissions(userId);
  const [account] = await queryRaw<Account>(
    `SELECT * FROM ${q("affiliate_accounts")} WHERE ${q("userId")} = ?`,
    [userId],
  );
  const [invites] = await queryRaw<{ total: number }>(
    `SELECT COUNT(*) AS total FROM ${q("affiliate_referrals")} WHERE ${q("affiliateUserId")} = ?`,
    [userId],
  );
  const [sums] = await queryRaw<{ pending: number; confirmed: number }>(
    `SELECT COALESCE(SUM(CASE WHEN status = 'pending' THEN ${q("amountCents")} ELSE 0 END), 0) AS pending, COALESCE(SUM(CASE WHEN status = 'available' THEN ${q("amountCents")} ELSE 0 END), 0) AS confirmed FROM ${q("affiliate_commissions")} WHERE ${q("userId")} = ?`,
    [userId],
  );
  const config = await affiliateConfig();
  return {
    ...(await affiliateStatus(userId)),
    config,
    rateBps:
      account?.rateBps == null ? config.rateBps : Number(account.rateBps),
    blocked: !!account?.blocked,
    availableCents: Number(account?.availableCents || 0),
    invitedCount: Number(invites.total),
    pendingCents: Number(sums.pending),
    confirmedCents: Number(sums.confirmed),
    codes: await queryRaw<Code>(
      `SELECT * FROM ${q("affiliate_codes")} WHERE ${q("userId")} = ? ORDER BY id DESC`,
      [userId],
    ),
  };
}
export async function listAffiliateRows(
  table:
    | "affiliate_commissions"
    | "affiliate_withdrawals"
    | "affiliate_ledger"
    | "affiliate_referrals",
  input: { userId?: number; page: number; status?: string },
) {
  const column = table === "affiliate_referrals" ? "affiliateUserId" : "userId";
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (input.userId !== undefined) {
    conditions.push(`${q(column)} = ?`);
    params.push(input.userId);
  }
  if (
    input.status &&
    input.status !== "all" &&
    ["affiliate_commissions", "affiliate_withdrawals"].includes(table)
  ) {
    conditions.push("status = ?");
    params.push(input.status);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  const [count] = await queryRaw<{ total: number }>(
    `SELECT COUNT(*) AS total FROM ${q(table)}${where}`,
    params,
  );
  const items = await queryRaw<
    Commission &
      Withdrawal & {
        type: string;
        reference: string;
        balanceAfterCents: number;
        affiliateUserId: number;
        codeId: number;
      }
  >(`SELECT * FROM ${q(table)}${where} ORDER BY id DESC LIMIT 20 OFFSET ?`, [
    ...params,
    (input.page - 1) * 20,
  ]);
  return { items, total: Number(count.total) };
}
export async function requestAffiliateWithdrawal(
  userId: number,
  input: {
    amountCents: number;
    method: string;
    account: string;
    payee: string;
    requestKey: string;
  },
) {
  return withDatabaseTransaction(async () => {
    const account = await lockAccount(userId);
    const [existing] = await queryRaw<Withdrawal>(
      `SELECT * FROM ${q("affiliate_withdrawals")} WHERE ${q("userId")} = ? AND ${q("requestKey")} = ?`,
      [userId, input.requestKey],
    );
    if (existing) return { id: existing.id };
    if (account.blocked) throw fail("推广账户已停用");
    await settleLocked(userId);
    const config = await affiliateConfig();
    if (input.amountCents < config.minimumWithdrawalCents)
      throw fail("未达到最低提现金额");
    const [current] = await queryRaw<Account>(
      `SELECT * FROM ${q("affiliate_accounts")} WHERE ${q("userId")} = ?`,
      [userId],
    );
    if (Number(current.availableCents) < input.amountCents)
      throw fail("可用佣金不足");
    const [pending] = await queryRaw<{ total: number }>(
      `SELECT COUNT(*) AS total FROM ${q("affiliate_withdrawals")} WHERE ${q("userId")} = ? AND status = 'pending'`,
      [userId],
    );
    if (Number(pending.total) >= 5) throw fail("待审核提现过多，请等待处理");
    const id = await insertAndGetId("affiliate_withdrawals", {
      userId,
      ...input,
      createdAt: now(),
      status: "pending",
    });
    await ledger(userId, "withdrawal", -input.amountCents, String(id));
    return { id };
  });
}
export async function reviewAffiliateWithdrawal(
  operatorUserId: number,
  id: number,
  status: "paid" | "rejected",
  note: string,
) {
  return withDatabaseTransaction(async () => {
    const [snapshot] = await queryRaw<Withdrawal>(
      `SELECT * FROM ${q("affiliate_withdrawals")} WHERE id = ?`,
      [id],
    );
    if (!snapshot) throw fail("提现申请不存在");
    const account = await lockAccount(Number(snapshot.userId));
    const [row] = await queryRaw<Withdrawal>(
      `SELECT * FROM ${q("affiliate_withdrawals")} WHERE id = ?${lockedRead()}`,
      [id],
    );
    if (row.status !== "pending")
      throw new TRPCError({
        code: "CONFLICT",
        message: "提现申请已处理，请刷新",
      });
    if (
      status === "paid" &&
      (account.blocked || Number(account.availableCents) < 0)
    )
      throw fail("账户已停用或存在冲正欠款，不能打款");
    await executeRaw(
      `UPDATE ${q("affiliate_withdrawals")} SET status = ?, note = ?, ${q("operatorUserId")} = ?, ${q("reviewedAt")} = ? WHERE id = ?`,
      [status, note, operatorUserId, now(), id],
    );
    await ledger(
      Number(row.userId),
      status === "rejected" ? "withdrawal_return" : "payout",
      status === "rejected" ? Number(row.amountCents) : 0,
      String(id),
      operatorUserId,
      note,
    );
  });
}
export async function transferAffiliateBalance(
  userId: number,
  amountCents: number,
  requestKey: string,
) {
  return withTrafficBillingUserLock(userId, () =>
    withDatabaseTransaction(async () => {
      const account = await lockAccount(userId);
      const [previous] = await queryRaw(
        `SELECT id FROM ${q("affiliate_ledger")} WHERE ${q("userId")} = ? AND type = 'transfer' AND reference = ?`,
        [userId, requestKey],
      );
      if (previous) return;
      if (account.blocked) throw fail("推广账户已停用");
      if (!(await affiliateConfig()).allowBalanceTransfer)
        throw fail("佣金转余额未开启");
      await settleLocked(userId);
      const [current] = await queryRaw<Account>(
        `SELECT * FROM ${q("affiliate_accounts")} WHERE ${q("userId")} = ?`,
        [userId],
      );
      if (Number(current.availableCents) < amountCents)
        throw fail("可用佣金不足");
      await ledger(userId, "transfer", -amountCents, requestKey);
      await addUserBalance(userId, amountCents, {
        type: "affiliate_transfer",
        description: "推广佣金转入余额",
      });
      await recoverUserForwardAccessIfEligible(userId);
    }),
  );
}
export async function cancelAffiliateCommission(
  operatorUserId: number,
  id: number,
  reason: string,
) {
  return withDatabaseTransaction(async () => {
    const [snapshot] = await queryRaw<Commission>(
      `SELECT * FROM ${q("affiliate_commissions")} WHERE id = ?`,
      [id],
    );
    if (!snapshot) throw fail("返佣记录不存在");
    await lockAccount(Number(snapshot.userId));
    const [row] = await queryRaw<Commission>(
      `SELECT * FROM ${q("affiliate_commissions")} WHERE id = ?${lockedRead()}`,
      [id],
    );
    if (row.status === "cancelled") return;
    if (row.status === "available")
      await ledger(
        Number(row.userId),
        "reversal",
        -Number(row.amountCents),
        String(id),
        operatorUserId,
        reason,
      );
    else
      await ledger(
        Number(row.userId),
        "cancellation",
        0,
        String(id),
        operatorUserId,
        reason,
      );
    // Negative available balance is intentional debt after money has left the wallet.
    await executeRaw(
      `UPDATE ${q("affiliate_commissions")} SET status = 'cancelled', reason = ? WHERE id = ?`,
      [reason, id],
    );
  });
}
export async function updateAffiliateAccount(
  operatorUserId: number,
  userId: number,
  blocked: boolean,
  rateBps: number | null,
) {
  return withDatabaseTransaction(async () => {
    await lockAccount(userId);
    await executeRaw(
      `UPDATE ${q("affiliate_accounts")} SET blocked = ?, ${q("rateBps")} = ? WHERE ${q("userId")} = ?`,
      [boolValue(blocked), rateBps, userId],
    );
    await ledger(
      userId,
      "account_update",
      0,
      crypto.randomUUID(),
      operatorUserId,
      `blocked=${blocked};rateBps=${rateBps ?? "default"}`,
    );
  });
}
export async function affiliateAdminOverview(page: number, search = "") {
  await settleAffiliateCommissions();
  const [totals] = await queryRaw<{
    pendingCents: number;
    confirmedCents: number;
    totalInvites: number;
    pendingWithdrawals: number;
  }>(
    `SELECT (SELECT COALESCE(SUM(${q("amountCents")}),0) FROM ${q("affiliate_commissions")} WHERE status='pending') AS ${q("pendingCents")}, (SELECT COALESCE(SUM(${q("amountCents")}),0) FROM ${q("affiliate_commissions")} WHERE status='available') AS ${q("confirmedCents")}, (SELECT COUNT(*) FROM ${q("affiliate_referrals")}) AS ${q("totalInvites")}, (SELECT COALESCE(SUM(${q("amountCents")}),0) FROM ${q("affiliate_withdrawals")} WHERE status='pending') AS ${q("pendingWithdrawals")}`,
  );
  const where = search ? ` WHERE (u.username LIKE ? OR u.name LIKE ?)` : "";
  const params = search ? [`%${search}%`, `%${search}%`] : [];
  const from = `FROM ${q("affiliate_accounts")} a LEFT JOIN ${q("users")} u ON u.id = a.${q("userId")}`;
  const [count] = await queryRaw<{ total: number }>(
    `SELECT COUNT(*) AS total ${from}${where}`,
    params,
  );
  const accounts = await queryRaw<
    Account & { username: string | null; name: string | null; invites: number }
  >(
    `SELECT a.*, u.username, u.name, (SELECT COUNT(*) FROM ${q("affiliate_referrals")} r WHERE r.${q("affiliateUserId")} = a.${q("userId")}) AS invites ${from}${where} ORDER BY a.id DESC LIMIT 20 OFFSET ?`,
    [...params, (page - 1) * 20],
  );
  return {
    config: await affiliateConfig(),
    enabled: await affiliatesEnabled(),
    totals,
    accounts,
    total: Number(count.total),
  };
}
