export const MAX_PRODUCT_STOCK = 1_000_000_000;

export function productStock(product: { stockLimit?: number; stockUsed?: number }) {
  const limit = Math.max(0, Number(product.stockLimit) || 0);
  const used = Math.max(0, Number(product.stockUsed) || 0);
  return { unlimited: limit === 0, remaining: limit === 0 ? null : Math.max(0, limit - used), soldOut: limit > 0 && used >= limit };
}

export function productStockText(product: { stockLimit?: number; stockUsed?: number }) {
  const stock = productStock(product);
  return stock.unlimited ? "∞" : String(stock.remaining);
}
