const tunnelRuntimeStatus = new Map<number, Map<number, boolean>>();
const tunnelRuntimeGeneration = new Map<number, number>();

function normalizeTunnelId(tunnelId: unknown) {
  const id = Number(tunnelId);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

export function bumpTunnelRuntimeGeneration(tunnelId: number) {
  const tid = normalizeTunnelId(tunnelId);
  if (!tid) return 0;
  const current = tunnelRuntimeGeneration.get(tid) || 0;
  const next = current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
  tunnelRuntimeGeneration.set(tid, next);
  return next;
}

export function getTunnelRuntimeGeneration(tunnelId: number) {
  const tid = normalizeTunnelId(tunnelId);
  return tid ? tunnelRuntimeGeneration.get(tid) || 0 : 0;
}

export function recordTunnelRuntimeHostStatus(tunnelId: number, hostId: number, running: boolean) {
  const tid = normalizeTunnelId(tunnelId);
  const hid = Number(hostId);
  if (!tid || !Number.isFinite(hid) || hid <= 0) return;
  let hosts = tunnelRuntimeStatus.get(tid);
  if (!hosts) {
    hosts = new Map<number, boolean>();
    tunnelRuntimeStatus.set(tid, hosts);
  }
  hosts.set(hid, !!running);
}

export function isTunnelRuntimeHostReady(tunnelId: number, hostId: number) {
  return tunnelRuntimeStatus.get(Number(tunnelId))?.get(Number(hostId)) === true;
}

export function getTunnelRuntimeHostStatus(tunnelId: number, hostId: number) {
  return tunnelRuntimeStatus.get(Number(tunnelId))?.get(Number(hostId));
}

export function getTunnelRuntimeReadyCount(tunnelId: number, hostIds: number[]) {
  const hosts = tunnelRuntimeStatus.get(Number(tunnelId));
  if (!hosts) return 0;
  return hostIds.filter((hostId) => hosts.get(Number(hostId)) === true).length;
}

export function clearTunnelRuntimeStatusForHost(hostId: number) {
  const hid = Number(hostId);
  if (!Number.isFinite(hid) || hid <= 0) return;
  for (const [tunnelId, hosts] of tunnelRuntimeStatus.entries()) {
    const deleted = hosts.delete(hid);
    if (deleted) bumpTunnelRuntimeGeneration(tunnelId);
    if (hosts.size === 0) tunnelRuntimeStatus.delete(tunnelId);
  }
}

export function clearTunnelRuntimeStatus(tunnelId: number) {
  const tid = normalizeTunnelId(tunnelId);
  if (!tid) return;
  tunnelRuntimeStatus.delete(tid);
  bumpTunnelRuntimeGeneration(tid);
}
