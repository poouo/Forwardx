export type MultiHopAddressHost = {
  ip?: string | null;
  ipv4?: string | null;
  ipv6?: string | null;
  entryIp?: string | null;
  tunnelEntryIp?: string | null;
};

function addressKey(value: unknown) {
  const text = String(value || "").trim();
  const unwrapped = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1).trim() : text;
  return unwrapped.toLowerCase();
}

export function sameMultiHopAddress(a: unknown, b: unknown) {
  const left = addressKey(a);
  const right = addressKey(b);
  return !!left && !!right && left === right;
}

export function selectedMultiHopConnectHost(input: {
  host: MultiHopAddressHost | undefined;
  index: number;
  externalEntry: boolean;
  useTunnelEntryIp: boolean;
  useIpv6: boolean;
}) {
  if (input.index === 0 && !input.externalEntry) return null;
  const privateAddr = String(input.host?.tunnelEntryIp || "").trim();
  const ipv6Addr = String(input.host?.ipv6 || "").trim();
  if (input.useTunnelEntryIp && privateAddr) return privateAddr;
  if (input.useIpv6 && ipv6Addr) return ipv6Addr;

  // null means the host's default public/entry address. Keeping the mode
  // separate from the address matters when public and private values match.
  return null;
}

export function multiHopAddressSelection(input: {
  host: MultiHopAddressHost | undefined;
  connectHost: unknown;
  index: number;
  externalEntry: boolean;
}) {
  if (input.index === 0 && !input.externalEntry) {
    return { useTunnelEntryIp: false, useIpv6: false };
  }
  const connectHost = String(input.connectHost || "").trim();
  const privateAddr = String(input.host?.tunnelEntryIp || "").trim();
  const ipv6Addr = String(input.host?.ipv6 || "").trim();
  const useTunnelEntryIp = !!connectHost && !!privateAddr && sameMultiHopAddress(connectHost, privateAddr);
  return {
    useTunnelEntryIp,
    useIpv6: !useTunnelEntryIp && !!connectHost && !!ipv6Addr && sameMultiHopAddress(connectHost, ipv6Addr),
  };
}
