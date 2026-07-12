export function tunnelEndpointName(tunnel: any | null | undefined, role: "entry" | "exit", hosts: any[] | undefined) {
  const hostId = Number(role === "entry" ? tunnel?.entryHostId : tunnel?.exitHostId);
  const fromList = hosts?.find((host: any) => Number(host.id) === hostId);
  const fromTunnel = role === "entry" ? tunnel?.entryHost : tunnel?.exitHost;
  return fromList?.name || fromTunnel?.name || `主机 #${hostId}`;
}

export function tunnelHopHostName(tunnel: any | null | undefined, hostId: number, hosts: any[] | undefined) {
  const id = Number(hostId);
  const fromList = hosts?.find((host: any) => Number(host.id) === id);
  const fromTunnel = Array.isArray(tunnel?.hopHosts)
    ? tunnel.hopHosts.find((host: any) => Number(host?.id) === id)
    : null;
  if (fromList?.name || fromTunnel?.name) return fromList?.name || fromTunnel?.name;
  if (Number(tunnel?.entryHostId) === id) return tunnelEndpointName(tunnel, "entry", hosts);
  if (Number(tunnel?.exitHostId) === id) return tunnelEndpointName(tunnel, "exit", hosts);
  return `主机 #${id}`;
}

export function getTunnelLoadBalanceExitNames(tunnel: any | null | undefined, hosts: any[] | undefined) {
  if (!Array.isArray(tunnel?.loadBalanceExits)) return [];
  const names = tunnel.loadBalanceExits
    .map((exit: any) => Number(exit?.hostId || 0))
    .filter((hostId: number) => hostId > 0)
    .map((hostId: number) => tunnelHopHostName(tunnel, hostId, hosts))
    .map((name: string) => String(name || "").trim())
    .filter(Boolean);
  return Array.from(new Set(names));
}

export function getTunnelExitNames(tunnel: any | null | undefined, hosts: any[] | undefined) {
  const primaryExitId = Number(tunnel?.exitHostId || 0);
  const primaryName = primaryExitId > 0 ? tunnelHopHostName(tunnel, primaryExitId, hosts) : "";
  const names = [
    String(primaryName || "").trim(),
    ...getTunnelLoadBalanceExitNames(tunnel, hosts),
  ].filter(Boolean);
  return Array.from(new Set(names));
}

export function getTunnelHopIds(tunnel: any | null | undefined) {
  const hopIds = Array.isArray(tunnel?.hopHostIds)
    ? tunnel.hopHostIds.map((id: any) => Number(id)).filter((id: number) => Number.isFinite(id) && id > 0)
    : [];
  if (hopIds.length >= 2) return hopIds;
  return [Number(tunnel?.entryHostId || 0), Number(tunnel?.exitHostId || 0)].filter((id) => id > 0);
}

export function getTunnelRouteText(tunnel: any | null | undefined, hosts: any[] | undefined) {
  const hopNames = getTunnelHopIds(tunnel)
    .map((hostId: number) => tunnelHopHostName(tunnel, hostId, hosts))
    .map((name: string) => String(name || "").trim())
    .filter(Boolean);
  if (hopNames.length === 0) return "-";
  const extraExitNames = getTunnelLoadBalanceExitNames(tunnel, hosts)
    .filter((name) => !hopNames.includes(name));
  if (extraExitNames.length > 0) {
    return `${hopNames.join(" -> ")}；出口：${getTunnelExitNames(tunnel, hosts).join(" / ")}`;
  }
  return hopNames.join(" -> ");
}
