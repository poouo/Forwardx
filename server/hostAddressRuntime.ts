import * as db from "./db";
import { pushAgentRefresh } from "./agentEvents";
import * as hopRepo from "./repositories/tunnelRepository";
import { clearTunnelRuntimeStatusForHost } from "./tunnelRuntimeStatus";
import { scheduleHostDdnsUpdate } from "./hostDdns";

export function hostIngressAddress(hostLike: any) {
  return String(hostLike?.entryIp || hostLike?.ipv4 || hostLike?.ipv6 || hostLike?.ip || "").trim();
}

export function hostUsesAutomaticIngress(hostLike: any) {
  return !String(hostLike?.entryIp || "").trim();
}

export async function refreshAgentsAffectedByHostAddress(hostId: number, reason: string) {
  const affected = new Set<number>();
  const id = Number(hostId);
  if (Number.isFinite(id) && id > 0) affected.add(id);

  const tunnels = await db.getTunnelsByHost(id);
  await Promise.all((tunnels as any[]).map(async (tunnel: any) => {
    const entryHostId = Number(tunnel?.entryHostId || 0);
    const exitHostId = Number(tunnel?.exitHostId || 0);
    if (entryHostId > 0) affected.add(entryHostId);
    if (exitHostId > 0) affected.add(exitHostId);

    if (Number(tunnel.entryGroupId) > 0) {
      const group = await db.getForwardGroupById(Number(tunnel.entryGroupId));
      for (const member of (group as any)?.members || []) {
        if ((member.isEnabled === true || Number(member.isEnabled) === 1) && Number(member.hostId) > 0) affected.add(Number(member.hostId));
      }
    }

    const hops = await hopRepo.getTunnelHops(Number(tunnel?.id || 0));
    for (const hop of hops || []) {
      const hopHostId = Number((hop as any)?.hostId || 0);
      if (hopHostId > 0) affected.add(hopHostId);
    }

    const exits = await hopRepo.getTunnelExitNodes(Number(tunnel?.id || 0));
    for (const exit of exits || []) {
      const exitHostId = Number((exit as any)?.hostId || 0);
      if (exitHostId > 0) affected.add(exitHostId);
    }
  }));

  for (const affectedHostId of affected) {
    pushAgentRefresh(affectedHostId, reason, { urgent: true });
  }
}

export async function refreshHostAddressRuntime(hostId: number, previousHost: any, reason: string) {
  await db.syncForwardChainsForHost(hostId, previousHost);
  await db.syncTunnelsForHostAddress(hostId, previousHost);
  await db.resetAgentRuntimeStateForHost(hostId);
  clearTunnelRuntimeStatusForHost(hostId);
  await refreshAgentsAffectedByHostAddress(hostId, reason);
}

export async function handleHostAddressChanged(hostId: number, currentHost: any, previousHost: any, reason: string, options: { forceRuntimeRefresh?: boolean; retryDdnsFailures?: boolean } = {}) {
  // Host DNS has its own per-host deduplication and retry scheduler. Do not
  // block forwarding recovery on a slow DNS provider.
  scheduleHostDdnsUpdate(currentHost, reason);
  if (options.forceRuntimeRefresh || hostUsesAutomaticIngress(previousHost)) {
    await refreshHostAddressRuntime(hostId, previousHost, reason);
  }
  // Refresh dependent resources before evaluating their group DNS. A failed
  // DNS request must not prevent the forwarding runtime from receiving its IP.
  await db.runForwardGroupsForHostAddressChange(hostId, reason).catch((error) => {
    console.warn(`[HostAddress] Forward group DDNS refresh failed host=${hostId}: ${error instanceof Error ? error.message : String(error)}`);
    if (options.retryDdnsFailures) throw error;
  });
}
