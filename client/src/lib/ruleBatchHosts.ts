import { t } from "@/i18n";
import { forwardGroupRouteMembers } from "@shared/forwardGroup";

export type RuleBatchHost = { id: number; name: string; address: string };
export type RuleBatchHostContext = {
  hostById: ReadonlyMap<number, any>;
  tunnelById: ReadonlyMap<number, any>;
  forwardGroupById: ReadonlyMap<number, any>;
};

/** Listening/entry hosts only: exit and relay machines are not rule owners. */
export function getRuleBatchEntryHosts(rule: any, context: RuleBatchHostContext): RuleBatchHost[] {
  const result = new Map<number, RuleBatchHost>();
  const addHost = (value: unknown, nested?: any) => {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) return;
    // Shared resources may expose a permitted display summary without granting
    // access to hosts.options. Never fetch extra host details to fill this in.
    const host = context.hostById.get(id) || (Number(nested?.id) === id ? nested : null);
    if (!host && result.has(id)) return;
    result.set(id, {
      id, name: String(host?.name || t("主机 #{0}", [id])),
      address: String(host?.entryIp || (host?.ddnsEnabled && host?.ddnsDomain) || host?.ipv4 || host?.ip || host?.ipv6 || ""),
    });
  };
  const entryGroup = (resource: any) => Number(resource?.entryGroupId) > 0
    ? context.forwardGroupById.get(Number(resource.entryGroupId)) || resource.entryGroup
    : null;
  const tunnelHost = (tunnel: any, id: number) => Number(tunnel?.entryHost?.id) === id
    ? tunnel.entryHost : tunnel?.hopHosts?.find((host: any) => Number(host.id) === id);
  const addEntryGroup = (group: any, tunnel?: any) => {
    for (const member of forwardGroupRouteMembers(group)) {
      if (member.memberType !== "tunnel") addHost(member.hostId, member.host || tunnelHost(tunnel, Number(member.hostId)));
    }
  };
  const addTunnel = (tunnel: any) => {
    const entries = entryGroup(tunnel);
    if (entries) { addEntryGroup(entries, tunnel); return; }
    const id = Number(tunnel?.entryHostId || tunnel?.hopHostIds?.[0]);
    addHost(id, tunnelHost(tunnel, id));
  };
  const group = context.forwardGroupById.get(Number(rule?.forwardGroupId));
  if (group) {
    const entries = entryGroup(group);
    if (entries) {
      addEntryGroup(entries);
    } else {
      const members = forwardGroupRouteMembers(group);
      // Without an external entry group, only the first node of a serial
      // chain accepts client traffic; failover members are alternative entries.
      for (const member of group.groupMode === "chain" ? members.slice(0, 1) : members) {
        if (Number(member.tunnelId) > 0) addTunnel(context.tunnelById.get(Number(member.tunnelId)) || member.tunnel);
        else addHost(member.hostId, member.host);
      }
    }
  } else if (Number(rule?.tunnelId) > 0) {
    const tunnel = context.tunnelById.get(Number(rule.tunnelId));
    if (tunnel) addTunnel(tunnel);
    else addHost(rule.hostId);
  } else {
    addHost(rule?.hostId, rule?.host);
  }
  return [...result.values()];
}

export function matchesRuleBatchHost(hosts: readonly RuleBatchHost[], hostId: string) {
  return hostId === "all" || hosts.some(host => host.id === Number(hostId));
}

export function ruleBatchHostLabel(host: RuleBatchHost) {
  return host.address ? `${host.name} · ${host.address}` : host.name;
}

export function ruleBatchHostOptions(index: ReadonlyMap<number, readonly RuleBatchHost[]>): RuleBatchHost[] {
  const hosts = new Map<number, RuleBatchHost>();
  for (const entries of index.values()) for (const host of entries) hosts.set(host.id, host);
  return [...hosts.values()].sort((left, right) => left.name.localeCompare(right.name) || left.id - right.id);
}
