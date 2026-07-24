import { appendPanelLog } from "./_core/panelLogger";
import { getDdnsSettings, updateDdnsRecord } from "./ddns";
import * as db from "./db";

const HOST_DDNS_RETRY_BASE_MS = 60_000;
const HOST_DDNS_RETRY_MAX_MS = 30 * 60_000;

type HostDdnsRetryState = {
  failures: number;
  retryAt: number;
};

type HostDdnsRetryTimer = ReturnType<typeof setTimeout>;
type SetHostDdnsRetryTimer = (callback: () => void, delayMs: number) => HostDdnsRetryTimer;
type ClearHostDdnsRetryTimer = (timer: HostDdnsRetryTimer) => void;

export class HostDdnsRetryScheduler {
  private readonly pending = new Map<number, { retryAt: number; timer: HostDdnsRetryTimer }>();

  constructor(
    private readonly retry: (hostId: number) => void | Promise<void>,
    private readonly now: () => number = Date.now,
    private readonly setTimer: SetHostDdnsRetryTimer = setTimeout,
    private readonly clearTimer: ClearHostDdnsRetryTimer = clearTimeout,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  replace(hostIdValue: unknown, retryAtValue: unknown) {
    const hostId = Number(hostIdValue);
    const retryAt = Number(retryAtValue);
    if (!Number.isInteger(hostId) || hostId <= 0) return false;
    const existing = this.pending.get(hostId);
    if (!Number.isFinite(retryAt) || retryAt <= 0) {
      if (existing) this.clearTimer(existing.timer);
      this.pending.delete(hostId);
      return false;
    }
    if (existing?.retryAt === retryAt) return true;
    if (existing) this.clearTimer(existing.timer);
    const delayMs = Math.max(0, retryAt - this.now()) + 25;
    const timer = this.setTimer(() => {
      const current = this.pending.get(hostId);
      if (!current || current.timer !== timer) return;
      this.pending.delete(hostId);
      void Promise.resolve(this.retry(hostId)).catch(this.onError);
    }, delayMs);
    timer.unref?.();
    this.pending.set(hostId, { retryAt, timer });
    return true;
  }

  retryAt(hostIdValue: unknown) {
    return this.pending.get(Number(hostIdValue))?.retryAt ?? null;
  }
}

export class HostDdnsUpdateCoordinator {
  private readonly inFlight = new Set<number>();
  private readonly rerunRequested = new Set<number>();
  private readonly immediateRerunRequested = new Set<number>();
  private readonly retries = new Map<number, HostDdnsRetryState>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly retryBaseMs = HOST_DDNS_RETRY_BASE_MS,
    private readonly retryMaxMs = HOST_DDNS_RETRY_MAX_MS,
  ) {}

  tryStart(hostId: number, options: { force?: boolean } = {}) {
    if (!Number.isInteger(hostId) || hostId <= 0) return false;
    if (options.force) this.retries.delete(hostId);
    if (this.inFlight.has(hostId)) {
      this.rerunRequested.add(hostId);
      if (options.force) this.immediateRerunRequested.add(hostId);
      return false;
    }
    this.inFlight.add(hostId);
    return true;
  }

  finish(hostId: number) {
    if (!this.inFlight.delete(hostId)) {
      return { rerunRequested: false, immediate: false };
    }
    return {
      rerunRequested: this.rerunRequested.delete(hostId),
      immediate: this.immediateRerunRequested.delete(hostId),
    };
  }

  recordSuccess(hostId: number) {
    this.retries.delete(hostId);
  }

  recordFailure(hostId: number) {
    const failures = (this.retries.get(hostId)?.failures || 0) + 1;
    const delay = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** Math.min(failures - 1, 30)));
    const retryAt = this.now() + delay;
    this.retries.set(hostId, { failures, retryAt });
    return retryAt;
  }

  canReconcile(hostId: number) {
    if (!Number.isFinite(hostId) || hostId <= 0 || this.inFlight.has(hostId)) return false;
    return (this.retries.get(hostId)?.retryAt || 0) <= this.now();
  }
}

const hostDdnsUpdates = new HostDdnsUpdateCoordinator();
const hostDdnsRetryScheduler = new HostDdnsRetryScheduler(
  retryHostDdnsUpdate,
  Date.now,
  setTimeout,
  clearTimeout,
  (error) => {
    appendPanelLog("warn", `[HostDDNS] retry wake failed: ${error instanceof Error ? error.message : String(error)}`);
  },
);

function clearHostDdnsRetry(hostId: number) {
  hostDdnsUpdates.recordSuccess(hostId);
  hostDdnsRetryScheduler.replace(hostId, null);
}

function finishHostDdnsUpdate(hostId: number, retryAt: number | null = null) {
  const outcome = hostDdnsUpdates.finish(hostId);
  if (retryAt) hostDdnsRetryScheduler.replace(hostId, retryAt);
  if (outcome.immediate) clearHostDdnsRetry(hostId);
  if (outcome.rerunRequested && hostDdnsUpdates.canReconcile(hostId)) {
    void retryHostDdnsUpdate(hostId, { force: outcome.immediate });
  }
}

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

function hostNeedsDdnsUpdate(host: any) {
  const hostId = Number(host?.id || 0);
  const domain = String(host?.ddnsDomain || "").trim();
  if (!hostId || !host?.ddnsEnabled || !domain) return false;
  const target = hostDdnsTargetValue(host);
  if (!target.value) return false;
  return String(host?.lastDdnsValue || "") !== target.value || !!host?.lastDdnsError;
}

async function retryHostDdnsUpdate(hostId: number, options: { force?: boolean } = {}) {
  if (!hostDdnsUpdates.canReconcile(hostId)) return;
  if (!hostDdnsUpdates.tryStart(hostId, options)) return;
  await executeHostDdnsUpdate(hostId, () => db.getHostById(hostId), "host-ddns-retry", options);
}

async function executeHostDdnsUpdate(
  hostId: number,
  loadHost: () => any | Promise<any>,
  reason: string,
  options: { force?: boolean } = {},
) {
  let host: any;
  let retryAt: number | null = null;
  try {
    host = await loadHost();
    if (!host) {
      clearHostDdnsRetry(hostId);
      return;
    }

    const domain = String(host?.ddnsDomain || "").trim().replace(/\.+$/, "").toLowerCase();
    if (!host?.ddnsEnabled || !domain) {
      clearHostDdnsRetry(hostId);
      return;
    }

    const target = hostDdnsTargetValue(host);
    if (!target.value) {
      clearHostDdnsRetry(hostId);
      await db.updateHost(hostId, { lastDdnsError: `No reported ${target.ipVersion.toUpperCase()} address` } as any);
      return;
    }
    if (!options.force && String(host?.lastDdnsValue || "") === target.value && !host?.lastDdnsError) {
      clearHostDdnsRetry(hostId);
      return;
    }

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
    clearHostDdnsRetry(hostId);
    appendPanelLog("info", `[HostDDNS] host=${hostId} ${target.recordType} ${domain} -> ${target.value} reason=${reason}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    retryAt = hostDdnsUpdates.recordFailure(hostId);
    await db.updateHost(hostId, { lastDdnsError: message } as any).catch(() => undefined);
    const domain = String(host?.ddnsDomain || "").trim().replace(/\.+$/, "").toLowerCase() || "-";
    const value = host ? hostDdnsTargetValue(host).value || "-" : "-";
    appendPanelLog("warn", `[HostDDNS] host=${hostId} update failed domain=${domain} value=${value}: ${message}`);
  } finally {
    // Arm retries only after releasing the per-host in-flight guard. Otherwise
    // a very slow error write could consume its own timer before work can run.
    finishHostDdnsUpdate(hostId, retryAt);
  }
}

export function scheduleHostDdnsUpdate(
  host: any,
  reason = "agent-address-changed",
  options: { force?: boolean } = {},
) {
  const hostId = Number(host?.id || 0);
  if (!Number.isInteger(hostId) || hostId <= 0) return false;
  if (options.force) hostDdnsRetryScheduler.replace(hostId, null);
  if (!hostDdnsUpdates.tryStart(hostId, options)) return false;
  const domain = String(host?.ddnsDomain || "").trim();
  const target = hostDdnsTargetValue(host);
  const willAttemptProviderUpdate = options.force
    ? !!host?.ddnsEnabled && !!domain && !!target.value
    : hostNeedsDdnsUpdate(host);
  void executeHostDdnsUpdate(hostId, () => host, reason, options);
  return willAttemptProviderUpdate;
}

export async function reconcileHostDdnsRecords(
  reason = "host-ddns-reconcile",
  options: { force?: boolean } = {},
) {
  const settings = await getDdnsSettings();
  if (!settings.enabled || settings.provider === "disabled") return 0;
  const hosts = await db.getHosts();
  let queued = 0;
  for (const host of hosts as any[]) {
    const hostId = Number(host?.id || 0);
    const domain = String(host?.ddnsDomain || "").trim();
    if (!hostId || !host?.ddnsEnabled || !domain) continue;
    const target = hostDdnsTargetValue(host);
    if (!target.value) continue;
    if (!options.force && String(host?.lastDdnsValue || "") === target.value && !host?.lastDdnsError) continue;
    if (!options.force && !hostDdnsUpdates.canReconcile(hostId)) continue;
    if (scheduleHostDdnsUpdate(host, reason, options)) queued += 1;
  }
  return queued;
}
