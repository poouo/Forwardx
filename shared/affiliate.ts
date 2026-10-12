export const AFFILIATE_DEFAULTS = {
  rateBps: 1500,
  firstOrderOnly: true,
  confirmationDays: 7,
  minimumWithdrawalCents: 1000,
  allowBalanceTransfer: true,
  maxCodes: 10,
};
export type AffiliateConfig = typeof AFFILIATE_DEFAULTS;
export function commissionCents(amountCents: number, rateBps: number) {
  if (
    !Number.isSafeInteger(amountCents) ||
    amountCents < 0 ||
    !Number.isInteger(rateBps) ||
    rateBps < 0 ||
    rateBps > 10000
  )
    throw new Error("Invalid commission amount");
  return Number((BigInt(amountCents) * BigInt(rateBps)) / 10000n);
}
export const AFFILIATE_STATUS_LABELS: Record<string, string> = {
  pending: "待确认",
  available: "已确认",
  cancelled: "已取消",
  paid: "已打款",
  rejected: "已驳回",
  commission: "佣金入账",
  reversal: "佣金冲正",
  withdrawal: "申请提现",
  withdrawal_return: "提现退回",
  transfer: "转入余额",
  payout: "提现打款",
  cancellation: "取消返佣",
  account_update: "账户设置",
};
