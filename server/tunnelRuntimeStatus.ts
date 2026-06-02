const tunnelRuntimeStatus = new Map<number, Map<number, boolean>>();

export function recordTunnelRuntimeHostStatus(tunnelId: number, hostId: number, running: boolean) {
  const tid = Number(tunnelId);
  const hid = Number(hostId);
  if (!Number.isFinite(tid) || tid <= 0 || !Number.isFinite(hid) || hid <= 0) return;
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

export function clearTunnelRuntimeStatus(tunnelId: number) {
  tunnelRuntimeStatus.delete(Number(tunnelId));
}
