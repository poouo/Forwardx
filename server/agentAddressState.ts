import { normalizeAgentAddress } from "./agentInputValidation";

export type AgentReportedAddress = {
  ip: string;
  ipv4: string | null;
  ipv6: string | null;
};

export function mergeAgentReportedAddress(body: any, existingHost?: any): AgentReportedAddress {
  const safeIpv4 = normalizeAgentAddress(body?.ipv4);
  const safeIpv6 = normalizeAgentAddress(body?.ipv6);
  const safeIp = normalizeAgentAddress(body?.ip);
  const previousIpv4 = normalizeAgentAddress(existingHost?.ipv4);
  const previousIpv6 = normalizeAgentAddress(existingHost?.ipv6);
  const previousIp = normalizeAgentAddress(existingHost?.ip);
  const ipv4 = safeIpv4 || previousIpv4 || null;
  const ipv6 = safeIpv6 || previousIpv6 || null;
  return {
    ip: safeIpv4 || safeIp || previousIp || ipv4 || safeIpv6 || ipv6 || "unknown",
    ipv4,
    ipv6,
  };
}
