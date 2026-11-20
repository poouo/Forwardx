export const MAX_PLAN_PURCHASE_QUANTITY = 100;
export const MAX_PLAN_PURCHASE_AMOUNT_CENTS = 100_000_000;
export const PLAN_BILLING_CYCLE_DAYS = [30, 90, 180, 365, 730] as const;
export type PlanCyclePriceRule = { durationDays: number } & (
  { kind: "fixed"; priceCents: number } | { kind: "percent"; pricePercent: number }
);
export type PlanCyclePrice = {
  durationDays: number;
  priceCents: number;
  referencePriceCents?: number;
  discountPercent?: number;
};

type PlanPricing = PlanCyclePrice & { cyclePrices?: string | null };

const monthsByDays = new Map<number, number>([[30, 1], [90, 3], [180, 6], [365, 12], [730, 24]]);

export function readPlanCyclePrices(stored: string | null | undefined): PlanCyclePriceRule[] {
  if (!stored) return [];
  try {
    const rows: unknown = JSON.parse(stored);
    if (!Array.isArray(rows)) return [];
    return rows.filter(row => row && monthsByDays.has(row.durationDays) && (
      (row.kind === "fixed" && row.durationDays !== 30 && Number.isSafeInteger(row.priceCents) && row.priceCents >= 0 && row.priceCents <= MAX_PLAN_PURCHASE_AMOUNT_CENTS)
      || (row.kind === "percent" && Number.isFinite(row.pricePercent) && row.pricePercent >= 1 && row.pricePercent <= 100)
    ));
  } catch {
    return [];
  }
}

export function planBillingCycles(plan: PlanPricing): PlanCyclePrice[] {
  const base = { durationDays: Number(plan.durationDays), priceCents: Number(plan.priceCents) };
  if (base.durationDays !== 30) return [base];
  const options = new Map<number, PlanCyclePrice>([[base.durationDays, base]]);
  for (const cycle of readPlanCyclePrices(plan.cyclePrices)) {
    if (cycle.kind === "fixed") {
      options.set(cycle.durationDays, { durationDays: cycle.durationDays, priceCents: cycle.priceCents });
    } else {
      const referencePriceCents = base.priceCents * (monthsByDays.get(cycle.durationDays) ?? 1);
      const priceCents = Math.round(referencePriceCents * cycle.pricePercent / 100);
      options.set(cycle.durationDays, {
        durationDays: cycle.durationDays,
        priceCents,
        ...(priceCents < referencePriceCents && {
          referencePriceCents,
          discountPercent: 100 - cycle.pricePercent,
        }),
      });
    }
  }
  return [...options.values()].sort((a, b) => a.durationDays - b.durationDays);
}

export function planCyclePurchaseTotals(plan: PlanPricing, quantity = 1, billingCycleDays = Number(plan.durationDays)) {
  const cycles = planBillingCycles(plan);
  const cycle = cycles.find(option => option.durationDays === billingCycleDays);
  if (!cycle) throw new Error("所选付款周期不可购买");
  if (cycles.length === 1 && quantity !== 1) throw new Error("该套餐每次只能购买一份");
  return planPurchaseTotals(cycle.priceCents, cycle.durationDays, quantity);
}

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
