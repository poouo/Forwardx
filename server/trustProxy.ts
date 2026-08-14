export type TrustProxySetting = boolean | number | string | string[];

/**
 * Parse FORWARDX_TRUST_PROXY without silently turning an invalid value into
 * `true`. The default remains Express's loopback-only behavior.
 */
export function resolveTrustProxySetting(value: unknown): TrustProxySetting {
  const raw = String(value ?? "").trim();
  if (!raw || raw.toLowerCase() === "loopback") return "loopback";
  if (["false", "none", "off", "0"].includes(raw.toLowerCase())) return false;
  // Never enable unrestricted proxy trust from an environment typo or a
  // copied `true` value. That would let clients spoof req.ip and collapse
  // authentication limits onto (or away from) an arbitrary address.
  if (["true", "all", "on", "*"].includes(raw.toLowerCase())) return false;
  if (/^\d+$/.test(raw)) return Math.max(0, Number(raw));
  const entries = raw.split(",").map((item) => item.trim()).filter(Boolean);
  return entries.length === 1 ? entries[0] : entries;
}
