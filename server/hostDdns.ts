import { appendPanelLog } from "./_core/panelLogger";
import { getDdnsSettings, updateDdnsRecord } from "./ddns";
import * as db from "./db";

function normalizeRecordType(value: unknown) {
  return String(value || "A").toUpperCase() === "AAAA" ? "AAAA" : "A";
}

function normalizeIpVersion(value: unknown, recordType: string) {
  if (value === "ipv6" || (!value && normalizeRecordType(recordType) === "AAAA")) return "ipv6";
  return "ipv4";
}

export function hostDdnsTargetValue(host: any) {
  const recordType = normalizeRecordType(host?.ddnsRecordType);
  const ipVersion = normalizeIpVersion(host?.ddnsIpVersion, recordType);
  const value = String(ipVersion === "ipv6" ? host?.ipv6 || "" : host?.ipv4 || "").trim();
  return { recordType, ipVersion, value };
}

export function scheduleHostDdnsUpdate(host: any, reason = "agent-address-changed") {
  const hostId = Number(host?.id || 0);
  const domain = String(host?.ddnsDomain || "").trim().replace(/\.+$/, "").toLowerCase();
  if (!hostId || !host?.ddnsEnabled || !domain) return;

  const target = hostDdnsTargetValue(host);
  if (!target.value) {
    void db.updateHost(hostId, { lastDdnsError: `No reported ${target.ipVersion.toUpperCase()} address` } as any).catch(() => undefined);
    return;
  }
  if (String(host?.lastDdnsValue || "") === target.value && !host?.lastDdnsError) return;

  void (async () => {
    try {
      const settings = await getDdnsSettings();
      if (!settings.enabled || settings.provider === "disabled") {
        throw new Error("DDNS service is not enabled in system settings");
      }
      await updateDdnsRecord({
        domain,
        recordType: target.recordType,
        value: target.value,
        groupId: -hostId,
      });
      await db.updateHost(hostId, {
        lastDdnsValue: target.value,
        lastDdnsAt: new Date(),
        lastDdnsError: null,
      } as any);
      appendPanelLog("info", `[HostDDNS] host=${hostId} ${target.recordType} ${domain} -> ${target.value} reason=${reason}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.updateHost(hostId, { lastDdnsError: message } as any).catch(() => undefined);
      appendPanelLog("warn", `[HostDDNS] host=${hostId} update failed domain=${domain} value=${target.value}: ${message}`);
    }
  })();
}

export async function reconcileHostDdnsRecords(reason = "host-ddns-reconcile") {
  const hosts = await db.getHosts();
  let queued = 0;
  for (const host of hosts as any[]) {
    const hostId = Number(host?.id || 0);
    const domain = String(host?.ddnsDomain || "").trim();
    if (!hostId || !host?.ddnsEnabled || !domain) continue;
    const target = hostDdnsTargetValue(host);
    if (!target.value) continue;
    if (String(host?.lastDdnsValue || "") === target.value && !host?.lastDdnsError) continue;
    scheduleHostDdnsUpdate(host, reason);
    queued += 1;
  }
  return queued;
}
