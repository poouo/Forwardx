export type HostIpFamily = "ipv4" | "ipv6";
export type HostDdnsIpVersion = HostIpFamily | "both";
export const MAX_HOST_ADDRESSES = 128;

/** Canonical IP literals only; usable by the server and browser alike. */
export function normalizeHostIp(value: unknown, family: HostIpFamily): string {
  if (typeof value !== "string") return "";
  const ip = value.trim();
  if (family === "ipv4") {
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return "";
    const parts = ip.split(".").map(Number);
    return parts.every(part => part >= 0 && part <= 255) ? parts.join(".") : "";
  }
  if (!ip.includes(":") || /[%\[\]/?#@\s]/.test(ip)) return "";
  try { return new URL(`http://[${ip}]/`).hostname.slice(1, -1); } catch { return ""; }
}
export function parseHostAddresses(value: unknown, family: HostIpFamily): string[] {
  let list = value;
  if (typeof value === "string") { try { list = JSON.parse(value); } catch { list = []; } }
  if (!Array.isArray(list)) return [];
  return [...new Set(list.slice(0, MAX_HOST_ADDRESSES * 2).map(ip => normalizeHostIp(ip, family)).filter(Boolean))].sort().slice(0, MAX_HOST_ADDRESSES);
}
export function hostAddressOptions(host: any, family: HostIpFamily) {
  const current = normalizeHostIp(host?.[family], family) || normalizeHostIp(host?.ip, family);
  return withHostPrimary(parseHostAddresses(host?.[`${family}Addresses`], family), current, family);
}
export function withHostPrimary(addresses: string[], primary: unknown, family: HostIpFamily): string[] {
  const ip = normalizeHostIp(primary, family);
  const list = parseHostAddresses(addresses, family);
  if (!ip || list.includes(ip)) return list;
  return [...list.slice(0, MAX_HOST_ADDRESSES - 1), ip].sort();
}
export function normalizeHostDdnsIpVersion(value: unknown, recordType?: unknown): HostDdnsIpVersion {
  if (value === "both" || (!value && recordType === "BOTH")) return "both";
  return value === "ipv6" || (!value && recordType === "AAAA") ? "ipv6" : "ipv4";
}
