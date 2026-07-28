import { isIP } from "node:net";

export type ResolvedTargetIpCacheEntry = {
  raw: string;
  ip: string;
};

function normalizeDnsName(value: unknown): string {
  return String(value || "").trim().replace(/\.$/, "").toLowerCase();
}

export function selectResolvedTargetIp(
  raw: string,
  resolved: string,
  cached?: ResolvedTargetIpCacheEntry,
): string {
  const target = String(raw || "").trim();
  const candidate = String(resolved || "").trim();
  if (isIP(candidate)) return candidate;

  const cachedIp = String(cached?.ip || "").trim();
  if (
    cachedIp
    && isIP(cachedIp)
    && normalizeDnsName(cached?.raw) === normalizeDnsName(target)
  ) {
    return cachedIp;
  }

  return target;
}
