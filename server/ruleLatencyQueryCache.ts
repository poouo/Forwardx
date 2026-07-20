import { createQueryCache } from "./queryCache";

export const ruleTrafficQueryCache = createQueryCache(500);
export const ruleLatencySeriesQueryCache = createQueryCache(300);

export function clearRuleLatencyQueryCaches() {
  ruleTrafficQueryCache.clear();
  ruleLatencySeriesQueryCache.clear();
}
