/** Ordinary multi-entry forwarding is fan-out, not a sequential host chain. */
export function portEntryProbeHosts(group: any, hosts: any[] = []) {
  if (group?.groupMode !== "port") return [];
  const byId = new Map(hosts.map(host => [Number(host.id), host]));
  const seen = new Set<number>();
  return [...(group.members || [])].sort((a, b) => Number(a.priority) - Number(b.priority))
    .filter(member => member.memberType === "host" && (member.isEnabled === true || Number(member.isEnabled) === 1))
    .flatMap(member => {
      const hostId = Number(member.hostId);
      if (!(hostId > 0) || seen.has(hostId)) return [];
      seen.add(hostId);
      const host = byId.get(hostId) || member.host || {id:hostId};
      return [{hostId, host, label:String(host.name || `主机 #${hostId}`)}];
    });
}
