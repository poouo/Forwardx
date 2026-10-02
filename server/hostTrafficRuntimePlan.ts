import { hostPolicyBool } from "../shared/hostTrafficPolicy";
import { isTunnelRelayFailover } from "../shared/tunnelRelay";

/** Runtime-only copies. Never feed this plan back into port allocation/storage. */
export function planTunnelTrafficParticipation(tunnel: any, hops: any[], exits: any[], entryIds: number[], excluded: ReadonlySet<number>) {
  const next = { ...tunnel };
  const groupedEntries = Number(tunnel.entryGroupId) > 0;
  const groupedExits = Number(tunnel.exitGroupId) > 0 || hostPolicyBool(tunnel.loadBalanceEnabled);
  let nextHops = hops.map((hop) => ({ ...hop }));
  const entryHostIds = groupedEntries ? entryIds.filter((id) => !excluded.has(id)) : [...entryIds];
  let nextExits = exits.map((node) => ({ ...node, isEnabled: hostPolicyBool(node.isEnabled ?? true) && (!groupedExits || !excluded.has(Number(node.hostId))) }));
  let promotedExit: any = null;
  if (groupedEntries && entryHostIds.length === 0) next.isEnabled = false;
  if (groupedEntries && excluded.has(Number(next.entryHostId)) && entryHostIds.length > 0) {
    next.entryHostId = entryHostIds[0];
    if (nextHops.length > 0) nextHops[0].hostId = next.entryHostId;
  }
  if (groupedExits && excluded.has(Number(next.exitHostId))) {
    promotedExit = nextExits.filter((node) => hostPolicyBool(node.isEnabled))
      .sort((a, b) => Number(a.seq) - Number(b.seq))[0] || null;
    if (!promotedExit) next.isEnabled = false;
    else {
      Object.assign(next, { exitHostId: promotedExit.hostId, listenPort: promotedExit.listenPort, mimicPort: promotedExit.mimicPort, connectHost: promotedExit.connectHost || null });
      nextExits = nextExits.filter((node) => Number(node.id) !== Number(promotedExit.id));
      if (nextHops.length >= 2) Object.assign(nextHops[nextHops.length - 1], {
        hostId: next.exitHostId, listenPort: next.listenPort, mimicPort: next.mimicPort, connectHost: next.connectHost,
      });
    }
  }
  // A chain cannot bypass an arbitrary transit hop without changing its saved
  // semantics. A failover relay can, however, drop only the exhausted candidate.
  if (groupedEntries || groupedExits || isTunnelRelayFailover(tunnel, hops)) {
    const transit = nextHops.slice(1, -1);
    if (String(tunnel.relayMode) === "failover") {
      nextHops = nextHops.filter((hop, index) => index === 0 || index === nextHops.length - 1 || !excluded.has(Number(hop.hostId)));
      if (transit.length > 0 && nextHops.length === 2) next.isEnabled = false;
    } else if (transit.some((hop) => excluded.has(Number(hop.hostId)))) next.isEnabled = false;
  }
  return { tunnel: next, hops: nextHops, exits: nextExits, entryHostIds, promotedExit };
}

export function groupRuleTrafficBlocked(rule: any, excluded: ReadonlySet<number>, chainHostIds: number[] = []) {
  return Number(rule.forwardGroupId) > 0 && !hostPolicyBool(rule.isForwardGroupTemplate)
    && (excluded.has(Number(rule.hostId)) || chainHostIds.some((id) => excluded.has(id)));
}
