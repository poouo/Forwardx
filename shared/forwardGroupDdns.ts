import { normalizeHostIp } from "./hostAddresses";

// CNAME is retained for saved configurations, not offered for new groups.
export type ForwardGroupRecordType = "A" | "AAAA" | "BOTH" | "CNAME";

export function normalizeForwardGroupRecordType(value: unknown): ForwardGroupRecordType {
  const type = String(value || "A").trim().toUpperCase();
  return type === "AAAA" || type === "BOTH" || type === "CNAME" ? type : "A";
}

export function splitForwardGroupDdnsValues(value: string): string[] {
  return [...new Set(value.split(",").map(item => item.trim()).filter(Boolean))];
}

export function forwardGroupDdnsHostValue(host: any, recordType: ForwardGroupRecordType): string {
  const unbracket = (value: unknown) => String(value || "").trim().replace(/^\[([^\]]+)\]$/, "$1");
  const manual = unbracket(host?.entryIp);
  if (recordType === "CNAME") {
    if (manual && !normalizeHostIp(manual, "ipv4") && !normalizeHostIp(manual, "ipv6")) return manual;
    return host?.ddnsEnabled ? String(host?.ddnsDomain || "").trim() : "";
  }
  const families = recordType === "BOTH" ? ["ipv4", "ipv6"] as const
    : [recordType === "AAAA" ? "ipv6" : "ipv4"] as const;
  return families.map(family => normalizeHostIp(manual, family)
    || normalizeHostIp(unbracket(host?.[family]), family)
    || normalizeHostIp(unbracket(host?.ip), family))
    .filter(Boolean).join(",");
}

/** Keep the existing comma-separated runtime state readable across upgrades. */
export function forwardGroupDdnsRecordSets(recordType: ForwardGroupRecordType, values: string[]) {
  const unique = splitForwardGroupDdnsValues(values.join(","));
  if (recordType === "CNAME") return [{ recordType, values: unique }];
  // Include empty families: removing the last IPv6 member must remove stale
  // AAAA records instead of leaving them pointed at an unhealthy host.
  return ([{ recordType: "A", family: "ipv4" }, { recordType: "AAAA", family: "ipv6" }] as const)
    .filter(record => recordType === "BOTH" || record.recordType === recordType)
    .map(({ recordType, family }) => ({ recordType,
      values: [...new Set(unique.map(value => normalizeHostIp(value, family)).filter(Boolean))],
    }));
}
