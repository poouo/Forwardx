function normalizeAddress(value: unknown) {
  return String(value || "").trim();
}

export function defaultTunnelHostAddress(host: any) {
  return normalizeAddress(host?.entryIp || host?.ipv4 || host?.ipv6 || host?.ip);
}

export function selectTunnelDialAddress(tunnel: any, exitHost: any) {
  return normalizeAddress(tunnel?.connectHost) || defaultTunnelHostAddress(exitHost);
}

export function selectTunnelHopDialAddress(hop: any, hopHost: any) {
  return normalizeAddress(hop?.connectHost) || defaultTunnelHostAddress(hopHost);
}

export function selectEntryGroupTunnelTestAddress(tunnel: any, nextHop: any, nextHost: any) {
  return nextHop
    ? selectTunnelHopDialAddress(nextHop, nextHost) || selectTunnelDialAddress(tunnel, nextHost)
    : selectTunnelDialAddress(tunnel, nextHost);
}
