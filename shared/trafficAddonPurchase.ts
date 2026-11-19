export const MAX_TRAFFIC_ADDON_QUANTITY = 100;

export function validateTrafficAddonQuantity(quantity: number) {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_TRAFFIC_ADDON_QUANTITY) {
    throw new Error(`购买数量必须为 1 至 ${MAX_TRAFFIC_ADDON_QUANTITY} 的整数`);
  }
}

/** Quotes use integer bytes/cents; the server always reads unit values from its database. */
export function trafficAddonPurchaseTotals(unitTrafficBytes: number, unitPriceCents: number, quantity = 1) {
  validateTrafficAddonQuantity(quantity);
  const trafficBytes = unitTrafficBytes * quantity;
  const priceCents = unitPriceCents * quantity;
  if (!Number.isSafeInteger(unitTrafficBytes) || unitTrafficBytes <= 0
    || !Number.isSafeInteger(unitPriceCents) || unitPriceCents < 0
    || !Number.isSafeInteger(trafficBytes) || !Number.isSafeInteger(priceCents)) {
    throw new Error("流量包金额或流量超出有效范围");
  }
  return { quantity, unitTrafficBytes, unitPriceCents, trafficBytes, priceCents };
}
