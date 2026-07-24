type TunnelLatencyWaiter = (version: number) => void;

export class TunnelLatencyRefreshSignals {
  private readonly versions = new Map<number, number>();
  private readonly waiters = new Map<number, Set<TunnelLatencyWaiter>>();

  version(tunnelIdValue: unknown) {
    const tunnelId = Number(tunnelIdValue);
    return Number.isInteger(tunnelId) && tunnelId > 0 ? this.versions.get(tunnelId) || 0 : 0;
  }

  notify(tunnelIdValue: unknown) {
    const tunnelId = Number(tunnelIdValue);
    if (!Number.isInteger(tunnelId) || tunnelId <= 0) return 0;
    const version = (this.versions.get(tunnelId) || 0) + 1;
    this.versions.set(tunnelId, version);
    const pending = this.waiters.get(tunnelId);
    if (!pending) return version;
    this.waiters.delete(tunnelId);
    for (const resolve of pending) resolve(version);
    return version;
  }

  waitForChange(tunnelIdValue: unknown, afterVersion: number, waitMs: number) {
    const tunnelId = Number(tunnelIdValue);
    if (!Number.isInteger(tunnelId) || tunnelId <= 0) return Promise.resolve<number | null>(null);
    const current = this.version(tunnelId);
    if (current !== afterVersion) return Promise.resolve(current);
    const timeoutMs = Math.max(0, Math.floor(Number(waitMs) || 0));
    if (timeoutMs <= 0) return Promise.resolve<number | null>(null);

    return new Promise<number | null>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const complete = (version: number | null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const pending = this.waiters.get(tunnelId);
        pending?.delete(onChange);
        if (pending?.size === 0) this.waiters.delete(tunnelId);
        resolve(version);
      };
      const onChange: TunnelLatencyWaiter = (version) => complete(version);
      const pending = this.waiters.get(tunnelId) || new Set<TunnelLatencyWaiter>();
      pending.add(onChange);
      this.waiters.set(tunnelId, pending);
      timer = setTimeout(() => complete(null), timeoutMs);
    });
  }

  pendingWaiterCount(tunnelIdValue: unknown) {
    return this.waiters.get(Number(tunnelIdValue))?.size || 0;
  }
}

export const tunnelLatencyRefreshSignals = new TunnelLatencyRefreshSignals();

export function notifyTunnelLatencyRefresh(tunnelId: unknown) {
  tunnelLatencyRefreshSignals.notify(tunnelId);
}

function isNewTunnelLatency(row: any, baselineId: number) {
  const latestId = Number(row?.id || 0);
  return latestId > 0 && (baselineId <= 0 || latestId !== baselineId);
}

export async function waitForTunnelLatencyRefresh<T>(input: {
  tunnelId: number;
  baselineId: number;
  loadLatest: (tunnelId: number) => Promise<T>;
  waitMs?: number;
  crossProcessPollMs?: number;
  signals?: TunnelLatencyRefreshSignals;
}) {
  const waitMs = Math.max(0, Number(input.waitMs ?? 4500));
  const requestedPollMs = Number(input.crossProcessPollMs ?? 1000);
  const crossProcessPollMs = Number.isFinite(requestedPollMs)
    ? Math.max(1, requestedPollMs)
    : 1000;
  const deadline = Date.now() + waitMs;
  const signals = input.signals || tunnelLatencyRefreshSignals;
  let observedVersion = signals.version(input.tunnelId);
  let latest = await input.loadLatest(input.tunnelId);
  if (isNewTunnelLatency(latest, input.baselineId)) return latest;

  while (Date.now() < deadline) {
    const nextVersion = await signals.waitForChange(
      input.tunnelId,
      observedVersion,
      Math.min(crossProcessPollMs, deadline - Date.now()),
    );
    if (nextVersion !== null) observedVersion = nextVersion;
    latest = await input.loadLatest(input.tunnelId);
    if (isNewTunnelLatency(latest, input.baselineId)) return latest;
  }

  return latest;
}
