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

export type TunnelRuntimeTopology = {
  entryHostIds?: number[];
  hopHostIds?: number[];
  primaryExitHostId?: number;
  extraExitHostIds?: number[];
  relayMode?: string;
  loadBalanceEnabled?: boolean;
  loadBalanceStrategy?: string;
};

export function getTunnelRuntimeTopologyStatus(tunnelId: number, topology: TunnelRuntimeTopology) {
  const unique = (values: Array<number | undefined>) => Array.from(new Set(values
    .map(Number)
    .filter((id) => Number.isFinite(id) && id > 0)));
  const hops = unique(topology.hopHostIds || []);
  const entryCandidates = unique(topology.entryHostIds?.length ? topology.entryHostIds : [hops[0]]);
  const useExtraExits = topology.loadBalanceEnabled === true && String(topology.loadBalanceStrategy || "").toLowerCase() !== "none";
  const exitCandidates = unique([
    Number(topology.primaryExitHostId || hops[hops.length - 1] || 0),
    ...(useExtraExits ? topology.extraExitHostIds || [] : []),
  ]);
  const ready = (hostId: number) => isTunnelRuntimeHostReady(tunnelId, hostId);
  const relayCandidates = hops.length >= 3 ? hops.slice(1, -1) : [];
  const entryReady = hops.length < 3 || entryCandidates.some(ready);
  const exitReady = exitCandidates.some(ready);
  const relayReady = relayCandidates.length === 0
    || (String(topology.relayMode || "chain").toLowerCase() === "failover"
      ? relayCandidates.some(ready)
      : relayCandidates.every(ready));
  const observedHostIds = unique([...entryCandidates, ...relayCandidates, ...exitCandidates]);
  return {
    running: entryReady && relayReady && exitReady,
    readyCount: observedHostIds.filter(ready).length,
    hostCount: observedHostIds.length,
    missingHostIds: observedHostIds.filter((hostId) => !ready(hostId)),
  };
}

export function clearTunnelRuntimeStatusForHost(hostId: number) {
  const hid = Number(hostId);
  if (!Number.isFinite(hid) || hid <= 0) return [];
  const affectedTunnelIds: number[] = [];
  for (const [tunnelId, hosts] of tunnelRuntimeStatus.entries()) {
    const deleted = hosts.delete(hid);
    if (deleted) {
      affectedTunnelIds.push(tunnelId);
      bumpTunnelRuntimeGeneration(tunnelId);
    }
    if (hosts.size === 0) tunnelRuntimeStatus.delete(tunnelId);
  }
  return affectedTunnelIds;
}

export function clearTunnelRuntimeStatus(tunnelId: number) {
  const tid = normalizeTunnelId(tunnelId);
  if (!tid) return;
  tunnelRuntimeStatus.delete(tid);
  bumpTunnelRuntimeGeneration(tid);
}
