import { queryRaw } from "./dbRuntime";
import { quoteIdentifier as q } from "./dbCompat";

export const AFFILIATE_TABLES = [
  "affiliate_accounts",
  "affiliate_codes",
  "affiliate_referrals",
  "affiliate_commissions",
  "affiliate_withdrawals",
  "affiliate_ledger",
] as const;
export function validateAffiliateSnapshot(
  tables: Record<string, Record<string, any>[]>,
) {
  if (!AFFILIATE_TABLES.some((name) => tables[name]?.length)) return false;
  if (AFFILIATE_TABLES.some((name) => !Array.isArray(tables[name])))
    throw new Error("推广账务备份不完整，请使用完整导出的备份");
  const accounts = new Map<number, number>();
  const sums = new Map<number, number>();
  for (const account of tables.affiliate_accounts) {
    const userId = Number(account.userId),
      balance = Number(account.availableCents);
    if (
      !Number.isSafeInteger(userId) ||
      !userId ||
      !Number.isSafeInteger(balance) ||
      accounts.has(userId)
    )
      throw new Error("推广账户备份数据无效");
    accounts.set(userId, balance);
  }
  for (const row of tables.affiliate_ledger) {
    const userId = Number(row.userId),
      amount = Number(row.amountCents);
    if (!accounts.has(userId) || !Number.isSafeInteger(amount))
      throw new Error("推广佣金流水备份无效");
    sums.set(userId, (sums.get(userId) || 0) + amount);
  }
  for (const [userId, balance] of accounts)
    if ((sums.get(userId) || 0) !== balance)
      throw new Error("推广佣金余额与流水不一致，请检查备份");
  return true;
}
export async function assertAffiliateImportSafe(
  tables: Record<string, Record<string, any>[]>,
) {
  if (!validateAffiliateSnapshot(tables)) return;
  // Financial rows are an indivisible snapshot, not ordinary duplicate-reused resources.
  // Reusing old commission statuses while adding newer ledger rows would double-settle.
  for (const name of AFFILIATE_TABLES) {
    if ((await queryRaw(`SELECT id FROM ${q(name)} LIMIT 1`)).length)
      throw new Error(
        "目标已有推广数据，不能合并推广账务；请导入没有推广数据的目标数据库",
      );
  }
}
