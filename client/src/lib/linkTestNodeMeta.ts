import { normalizeCountryCode } from "@/lib/countryFeatures";

export type LinkTestNodeMeta = {
  label?: string | null;
  emoji?: string | null;
  countryCode?: string | null;
  region?: string | null;
  address?: string | null;
};

export function countryCodeToEmoji(countryCode: unknown) {
  const code = normalizeCountryCode(countryCode);
  if (!code) return "";
  return String.fromCodePoint(...[...code].map((char) => 127397 + char.charCodeAt(0)));
}

export function normalizeLinkTestNodeKey(value: unknown) {
  return String(value || "")
    .replace(/^第\s*\d+\s*跳\s*/i, "")
    .replace(/^\d+\s*\/\s*\d+\s*/, "")
    .trim()
    .toLowerCase();
}

export function hostDisplayName(host: any | null | undefined) {
  const id = Number(host?.id || 0);
  return String(host?.name || (id > 0 ? `主机 #${id}` : "")).trim();
}

export function hostAddressCandidates(host: any | null | undefined) {
  return [host?.entryIp, host?.ipv4, host?.ipv6, host?.ip, host?.tunnelEntryIp]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

export function hostRegionText(host: any | null | undefined) {
  return [host?.geoCountryName || host?.geoCountryCode, host?.geoRegion]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" / ");
}

export function hostNodeMeta(host: any | null | undefined, fallbackLabel?: string): LinkTestNodeMeta | undefined {
  const label = hostDisplayName(host) || String(fallbackLabel || "").trim();
  if (!label) return undefined;
  const countryCode = normalizeCountryCode(host?.geoCountryCode);
  return {
    label,
    emoji: String(host?.geoEmoji || "").trim() || countryCodeToEmoji(host?.geoCountryCode) || null,
    countryCode: countryCode || null,
    region: hostRegionText(host) || null,
    address: hostAddressCandidates(host).join(" / ") || null,
  };
}

export function targetGeoNodeMeta(
  label: string,
  address: string,
  geo: {
    geoCountryCode?: string | null;
    geoCountryName?: string | null;
    geoRegion?: string | null;
    geoEmoji?: string | null;
    resolvedAddress?: string | null;
  } | null | undefined,
): LinkTestNodeMeta {
  const countryCode = normalizeCountryCode(geo?.geoCountryCode);
  const region = [geo?.geoCountryName || geo?.geoCountryCode, geo?.geoRegion]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" / ");
  const resolvedAddress = String(geo?.resolvedAddress || "").trim();
  return {
    label: String(label || address || "目标").trim(),
    emoji: String(geo?.geoEmoji || "").trim() || countryCodeToEmoji(geo?.geoCountryCode) || null,
    countryCode: countryCode || null,
    region: region || null,
    address: [address, resolvedAddress && resolvedAddress !== address ? resolvedAddress : ""].filter(Boolean).join(" / ") || null,
  };
}

export function addNodeMetaAliases(
  metaMap: Record<string, LinkTestNodeMeta | undefined>,
  aliases: Array<unknown>,
  meta: LinkTestNodeMeta | undefined,
) {
  if (!meta) return;
  const keys = new Set<string>();
  aliases.forEach((alias) => {
    const text = String(alias || "").trim();
    if (!text) return;
    keys.add(text);
    const normalized = normalizeLinkTestNodeKey(text);
    if (normalized) keys.add(normalized);
  });
  const label = String(meta.label || "").trim();
  if (label) {
    keys.add(label);
    keys.add(normalizeLinkTestNodeKey(label));
  }
  keys.forEach((key) => {
    if (key) metaMap[key] = meta;
  });
}

export function addHostNodeMeta(
  metaMap: Record<string, LinkTestNodeMeta | undefined>,
  host: any | null | undefined,
  aliases: Array<unknown> = [],
) {
  const meta = hostNodeMeta(host);
  if (!meta) return;
  addNodeMetaAliases(metaMap, [
    host?.id ? `主机 #${host.id}` : "",
    host?.id ? `主机${host.id}` : "",
    host?.id ? String(host.id) : "",
    ...hostAddressCandidates(host),
    ...aliases,
  ], meta);
}

export function findHostByAddress(hosts: any[] | undefined, address: unknown) {
  const key = normalizeLinkTestNodeKey(String(address || "").replace(/^\[/, "").replace(/\]$/, ""));
  if (!key) return null;
  return (hosts || []).find((host: any) => hostAddressCandidates(host).some((candidate) => normalizeLinkTestNodeKey(candidate) === key)) || null;
}
