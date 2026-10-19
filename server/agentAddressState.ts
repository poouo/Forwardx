import { normalizeAgentAddress } from "./agentInputValidation";
import { normalizeHostIp, parseHostAddresses, withHostPrimary, type HostIpFamily } from "../shared/hostAddresses";

export type AgentReportedAddress = {
  ip: string;
  ipv4: string | null;
  ipv6: string | null;
  ipv4Addresses: string;
  ipv6Addresses: string;
};

export function mergeAgentReportedAddress(body: any, existingHost?: any): AgentReportedAddress {
  const safeIpv4 = normalizeHostIp(body?.ipv4, "ipv4");
  const safeIpv6 = normalizeHostIp(body?.ipv6, "ipv6");
  const safeIp = normalizeAgentAddress(body?.ip);
  const previousIpv4 = normalizeHostIp(existingHost?.ipv4, "ipv4");
  const previousIpv6 = normalizeHostIp(existingHost?.ipv6, "ipv6");
  const previousIp = normalizeAgentAddress(existingHost?.ip);
  const resolve = (family: HostIpFamily, reported: string, previous: string) => {
    const field = `${family}Addresses`, preferred = normalizeHostIp(existingHost?.[family === "ipv4" ? "preferredIpv4" : "preferredIpv6"], family);
    const fresh = Array.isArray(body?.[field]);
    const inventory = parseHostAddresses(fresh ? body[field] : existingHost?.[field], family);
    // A new Agent's complete list replaces stale aliases. Empty startup reports
    // without a valid primary retain the last usable inventory, not delete it.
    const addresses = parseHostAddresses([...(inventory.length || reported ? inventory : parseHostAddresses(existingHost?.[field], family)), reported || (!fresh ? previous : "")], family);
    const primary = preferred && addresses.includes(preferred) ? preferred : reported || (addresses.includes(previous) ? previous : "") || addresses[0] || previous || null;
    return { primary, addresses: JSON.stringify(withHostPrimary(addresses, primary, family)) };
  };
  const v4 = resolve("ipv4", safeIpv4, previousIpv4), v6 = resolve("ipv6", safeIpv6, previousIpv6);
  const ipv4 = v4.primary, ipv6 = v6.primary;
  return {
    ip: ipv4 || ipv6 || safeIp || previousIp || "unknown",
    ipv4,
    ipv6,
    ipv4Addresses: v4.addresses,
    ipv6Addresses: v6.addresses,
  };
}
