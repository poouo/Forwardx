import {
  buildLinkAvailabilityIndex,
  type LinkAvailabilityResult,
  type LinkAvailabilitySource,
  type LinkAvailabilityStatus,
} from "../client/src/lib/linkAvailability";
import { getForwardProtocolSettings, isTunnelProtocolEnabled } from "./forwardProtocolSettings";
import { getForwardGroups } from "./repositories/forwardGroupRepository";
import { getHostStatusRows } from "./repositories/hostRepository";
import { getLatestTunnelLatencies } from "./repositories/metricsRepository";
import {
  getTunnelExitNodesByTunnelIds,
  getTunnelHopsByTunnelIds,
  getTunnelsByIds,
} from "./repositories/tunnelRepository";

export type PublicLinkAvailabilitySummary = {
  status: LinkAvailabilityStatus;
  available: boolean;
  source: LinkAvailabilitySource;
  message: string;
  usableMemberIds?: number[];
};

export type LinkAvailabilitySummaryIndex = {
  tunnelAvailabilityById: Map<number, LinkAvailabilityResult>;
  groupAvailabilityById: Map<number, LinkAvailabilityResult>;
};

function positiveIds(values: Iterable<unknown>) {
  return Array.from(new Set(Array.from(values)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0)));
}

export function publicLinkAvailabilitySummary(
  state: LinkAvailabilityResult | null | undefined,
  visibleMemberIds?: Iterable<number>,
): PublicLinkAvailabilitySummary | null {
  if (!state) return null;
  const visibleMembers = visibleMemberIds === undefined
    ? null
    : new Set(positiveIds(visibleMemberIds));
  const usableMemberIds = positiveIds(state.usableMemberIds)
    .filter((id) => !visibleMembers || visibleMembers.has(id));
  return {
    status: state.status,
    available: state.available,
    source: state.source,
    message: state.message,
    ...(usableMemberIds.length > 0 ? { usableMemberIds } : {}),
  };
}

export function buildLinkAvailabilitySummaryIndex(input: {
  hosts?: any[];
  tunnels?: any[];
  groups?: any[];
  isTunnelSupported?: (tunnel: any) => boolean;
}): LinkAvailabilitySummaryIndex {
  return buildLinkAvailabilityIndex({
    hosts: input.hosts || [],
    tunnels: input.tunnels || [],
    groups: input.groups || [],
    isTunnelSupported: input.isTunnelSupported,
  });
}

export async function buildForwardGroupAvailabilitySummaryIndex(
  groups: any[],
  supportingGroups: any[] = [],
): Promise<LinkAvailabilitySummaryIndex> {
  let allGroups = Array.from(new Map([...groups, ...supportingGroups]
    .map((group) => [Number(group.id), group])).values());
  const tunnelIds = positiveIds(allGroups.flatMap((group) => (group.members || [])
    .filter((member: any) => member?.memberType === "tunnel")
    .map((member: any) => member?.tunnelId)));
  if (tunnelIds.length === 0) return buildLinkAvailabilitySummaryIndex({ groups: allGroups });

  const tunnels = await getTunnelsByIds(tunnelIds) as any[];
  const [hops, exits, latestLatencyByTunnel, protocolSettings] = await Promise.all([
    getTunnelHopsByTunnelIds(tunnelIds),
    getTunnelExitNodesByTunnelIds(tunnelIds),
    getLatestTunnelLatencies(tunnelIds),
    getForwardProtocolSettings(),
  ]);
  const knownGroupIds = new Set(allGroups.map((group) => Number(group.id)));
  const endpointGroupIds = positiveIds(tunnels.flatMap((tunnel) => [tunnel.entryGroupId, tunnel.exitGroupId]))
    .filter((id) => !knownGroupIds.has(id));
  if (endpointGroupIds.length > 0) {
    const endpointGroups = await getForwardGroups(undefined, { includeRuntime: false, ids: endpointGroupIds });
    allGroups = Array.from(new Map([...allGroups, ...(endpointGroups as any[])]
      .map((group) => [Number(group.id), group])).values());
  }

  const hopIdsByTunnel = new Map<number, number[]>();
  for (const hop of hops as any[]) {
    const id = Number(hop.tunnelId);
    const ids = hopIdsByTunnel.get(id) || [];
    ids.push(Number(hop.hostId));
    hopIdsByTunnel.set(id, ids);
  }
  const exitsByTunnel = new Map<number, any[]>();
  for (const exit of exits as any[]) {
    const id = Number(exit.tunnelId);
    const items = exitsByTunnel.get(id) || [];
    items.push(exit);
    exitsByTunnel.set(id, items);
  }
  const hostIds = positiveIds([
    ...tunnels.flatMap((tunnel) => [tunnel.entryHostId, tunnel.exitHostId]),
    ...(hops as any[]).map((hop) => hop.hostId),
    ...(exits as any[]).map((exit) => exit.hostId),
    ...allGroups.flatMap((group) => (group.members || []).map((member: any) => member?.host?.id || member?.hostId)),
  ]);
  const hosts = await getHostStatusRows({ hostIds });
  const availabilityTunnels = tunnels.map((tunnel) => {
    const latestLatency = latestLatencyByTunnel.get(Number(tunnel.id));
    const fallbackLatency = typeof tunnel.lastLatencyMs === "number" && Number.isFinite(tunnel.lastLatencyMs)
      ? Number(tunnel.lastLatencyMs)
      : null;
    return {
      ...tunnel,
      hopHostIds: hopIdsByTunnel.get(Number(tunnel.id)) || [],
      loadBalanceExits: exitsByTunnel.get(Number(tunnel.id)) || [],
      latestLatencyMs: latestLatency ? (latestLatency.isTimeout ? null : latestLatency.latencyMs) : fallbackLatency,
      latestLatencyIsTimeout: latestLatency
        ? latestLatency.isTimeout
        : tunnel.lastTestStatus === "failed" && fallbackLatency === null,
      latestLatencyAt: latestLatency?.recordedAt ?? tunnel.lastTestAt ?? null,
    };
  });
  return buildLinkAvailabilitySummaryIndex({
    hosts,
    tunnels: availabilityTunnels,
    groups: allGroups,
    isTunnelSupported: (tunnel) => isTunnelProtocolEnabled(protocolSettings, tunnel),
  });
}
