export type LinkProbeMethod = "tcp" | "ping";
export type RuleLatencyProbeMethod = "tcping" | "ping";

export function isUdpOnlyProtocol(protocol: unknown) {
  return String(protocol || "").trim().toLowerCase() === "udp";
}

export function linkProbeMethodForProtocol(protocol: unknown): LinkProbeMethod {
  return isUdpOnlyProtocol(protocol) ? "ping" : "tcp";
}

export function ruleLatencyProbeMethodForProtocol(protocol: unknown): RuleLatencyProbeMethod {
  return isUdpOnlyProtocol(protocol) ? "ping" : "tcping";
}

export function linkProbeMethodForRule(rule: any): LinkProbeMethod {
  return linkProbeMethodForProtocol(rule?.protocol);
}

export function ruleLatencyProbeMethodForRule(rule: any): RuleLatencyProbeMethod {
  return ruleLatencyProbeMethodForProtocol(rule?.protocol);
}

export function normalizeLinkProbeMethod(method: unknown): LinkProbeMethod {
  return String(method || "").trim().toLowerCase() === "ping" ? "ping" : "tcp";
}
