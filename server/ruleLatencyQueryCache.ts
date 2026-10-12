import { createQueryCache } from "./queryCache";

export const ruleTrafficQueryCache = createQueryCache(500);
export const ruleLatencySeriesQueryCache = createQueryCache(300);
// Monthly history is requested only by open charts. Keep a small, independent
// cache so frequent Agent reports do not invalidate expensive range queries.
export const latencyHistoryQueryCache = createQueryCache(60);

export function clearRuleLatencyQueryCaches() {
  ruleTrafficQueryCache.clear();
  ruleLatencySeriesQueryCache.clear();
}
