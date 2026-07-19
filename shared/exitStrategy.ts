export const EXIT_GROUP_STRATEGIES = [
  "none",
  "fallback",
  "round_robin",
  "random",
  "ip_hash",
] as const;

export type ExitGroupStrategy = (typeof EXIT_GROUP_STRATEGIES)[number];

export const EXIT_GROUP_STRATEGY_LABELS: Record<ExitGroupStrategy, string> = {
  none: "不使用",
  fallback: "主备模式 - 自上而下",
  round_robin: "轮询模式 - 依次轮换",
  random: "随机模式 - 随机选择",
  ip_hash: "哈希模式 - 来源 IP 哈希",
};

export function normalizeExitGroupStrategy(value: unknown): ExitGroupStrategy {
  const normalized = String(value || "").trim().toLowerCase();
  return (EXIT_GROUP_STRATEGIES as readonly string[]).includes(normalized)
    ? normalized as ExitGroupStrategy
    : "round_robin";
}

export function exitGroupUsesMultipleExits(value: unknown) {
  return normalizeExitGroupStrategy(value) !== "none";
}
