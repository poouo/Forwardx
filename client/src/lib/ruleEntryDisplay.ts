export type EntryAddressFamily = "ipv4" | "ipv6" | "hostname" | "unknown";

export type RuleEntryAddress = {
  label: string;
  value: string;
};

function cleanAddressLiteral(value: unknown) {
  let text = String(value || "").trim();
  if (!text) return "";
  text = text.replace(/^tcp:\/\//i, "").trim();
  if (text.startsWith("[") && text.includes("]")) return text.slice(1, text.indexOf("]")).trim();
  return text;
}

function isIpv4Literal(value: string) {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

export function getEntryAddressFamily(value: unknown): EntryAddressFamily {
  const text = cleanAddressLiteral(value);
  if (!text) return "unknown";
  if (isIpv4Literal(text)) return "ipv4";
  const withoutZone = text.replace(/%.+$/, "");
  if (withoutZone.includes(":") && /^[0-9a-f:.]+$/i.test(withoutZone)) return "ipv6";
  if (/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i.test(text)) return "hostname";
  return "unknown";
}

export function filterRuleEntryAddressesForDisplay<T extends RuleEntryAddress>(entries: readonly T[]): T[] {
  const hasIpv4OrHostname = entries.some((entry) => {
    const family = getEntryAddressFamily(entry.value);
    return family === "ipv4" || family === "hostname";
  });
  if (!hasIpv4OrHostname) return entries.slice();
  return entries.filter((entry) => getEntryAddressFamily(entry.value) !== "ipv6");
}
