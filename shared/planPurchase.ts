export const MAX_PLAN_PURCHASE_QUANTITY = 100;
export const MAX_PLAN_PURCHASE_AMOUNT_CENTS = 100_000_000;

/** A quantity buys periods of one subscription, not additional entitlements. */
export function planPurchaseTotals(unitPriceCents: number, unitDurationDays: number, quantity = 1) {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_PLAN_PURCHASE_QUANTITY) {
    throw new Error(`购买期数必须为 1 至 ${MAX_PLAN_PURCHASE_QUANTITY} 的整数`);
  }
  if (unitDurationDays === 0 && quantity !== 1) throw new Error("永久套餐只能购买一期");
  const priceCents = unitPriceCents * quantity;
  const durationDays = unitDurationDays * quantity;
  if (!Number.isSafeInteger(unitPriceCents) || unitPriceCents < 0
    || !Number.isSafeInteger(unitDurationDays) || unitDurationDays < 0
    || !Number.isSafeInteger(priceCents) || priceCents > MAX_PLAN_PURCHASE_AMOUNT_CENTS
    || !Number.isSafeInteger(durationDays) || durationDays > 3_650_000) {
    throw new Error("套餐金额或有效期超出有效范围");
  }
  return { quantity, priceCents, durationDays };
}
