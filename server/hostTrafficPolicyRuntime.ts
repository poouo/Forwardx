import { getForwardGroups, scheduleForwardGroupFailover } from "./repositories/forwardGroupRepository";
import { getTunnels, getTunnelHopsByTunnelIds, getTunnelExitNodesByTunnelIds } from "./repositories/tunnelRepository";
import { getForwardGroupChildRules } from "./repositories/forwardRuleRepository";
import { pushAgentRefresh } from "./agentEvents";

export async function refreshHostTrafficPolicyRuntime(hostId: number) {
  const [groups, tunnels] = await Promise.all([getForwardGroups(), getTunnels()]);
  const affectedHosts = new Set<number>([hostId]);
  const affectedTunnels = new Set<number>();
  const tunnelIds = (tunnels as any[]).map((tunnel) => Number(tunnel.id));
  const [hops, exits] = await Promise.all([getTunnelHopsByTunnelIds(tunnelIds), getTunnelExitNodesByTunnelIds(tunnelIds)]);
  const hopsByTunnel = new Map<number, any[]>();
  const exitsByTunnel = new Map<number, any[]>();
  for (const [rows, map] of [[hops, hopsByTunnel], [exits, exitsByTunnel]] as const) {
    for (const row of rows as any[]) {
      const id = Number(row.tunnelId);
      const items = map.get(id) || [];
      items.push(row);
      map.set(id, items);
    }
  }
  const topology = (tunnels as any[]).map((tunnel) => ({ tunnel, hops: hopsByTunnel.get(Number(tunnel.id)) || [], exits: exitsByTunnel.get(Number(tunnel.id)) || [] }));
  for (const { tunnel, hops, exits } of topology) {
    if ([tunnel.entryHostId, tunnel.exitHostId, ...hops.map((h: any) => h.hostId), ...exits.map((e: any) => e.hostId)].map(Number).includes(hostId)) {
      affectedTunnels.add(Number(tunnel.id));
    }
  }
  const affectedGroups = new Set<number>();
  for (const group of groups as any[]) {
    if ((group.members || []).some((m: any) => Number(m.hostId) === hostId || affectedTunnels.has(Number(m.tunnelId)))) affectedGroups.add(Number(group.id));
  }
  for (const group of groups as any[]) {
    if (affectedGroups.has(Number(group.entryGroupId))) affectedGroups.add(Number(group.id));
  }
  for (const { tunnel, hops, exits } of topology) {
    if (affectedTunnels.has(Number(tunnel.id)) || affectedGroups.has(Number(tunnel.entryGroupId)) || affectedGroups.has(Number(tunnel.exitGroupId))) {
      [tunnel.entryHostId, tunnel.exitHostId, ...hops.map((h: any) => h.hostId), ...exits.map((e: any) => e.hostId)].forEach((id) => affectedHosts.add(Number(id)));
    }
  }
  for (const group of groups as any[]) {
    if (!affectedGroups.has(Number(group.id))) continue;
    for (const member of group.members || []) affectedHosts.add(Number(member.hostId));
    for (const rule of await getForwardGroupChildRules(Number(group.id))) affectedHosts.add(Number(rule.hostId));
  }
  // Includes exit groups for status; no configuration/port allocation is changed.
  scheduleForwardGroupFailover([...affectedGroups]);
  for (const id of affectedHosts) if (id > 0) pushAgentRefresh(id, "host-traffic-policy-changed", { urgent: true });
}
