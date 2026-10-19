import { isIP } from "node:net";
import { hostAddressOptions, normalizeHostIp } from "../shared/hostAddresses";

function addressToken(value: unknown) {
  const token = String(value || "").trim().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "").toLowerCase();
  return normalizeHostIp(token, "ipv6") || token;
}

function isLocalAddress(target: string) {
  if (["localhost", "ip6-localhost", "0.0.0.0", "::", "0:0:0:0:0:0:0:0", "::1", "0:0:0:0:0:0:0:1"].includes(target)) return true;
  if (/^(?:0x[0-9a-f]+|\d+)$/.test(target)) {
    const value = target.startsWith("0x") ? Number.parseInt(target.slice(2), 16) : Number(target);
    if (Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff && Math.floor(value / 0x1000000) === 127) return true;
  }
  return isIP(target) === 4 && target.startsWith("127.");
}

export function assertNoDirectSelfForwardLoop(options: {
  host?: any;
  sourcePort: number;
  targetIp: unknown;
  targetPort: number;
  tunnelId?: number | null;
}) {
  const port = Number(options.sourcePort || 0);
  if (port <= 0 || port !== Number(options.targetPort || 0) || Number(options.tunnelId || 0) > 0) return;
  const target = addressToken(options.targetIp);
  if (!target) return;
  const host = options.host;
  const addresses = [host?.ip, ...hostAddressOptions(host, "ipv4"), ...hostAddressOptions(host, "ipv6"), host?.entryIp, host?.tunnelEntryIp, host?.ddnsDomain].map(addressToken).filter(Boolean);
  if (isLocalAddress(target) || addresses.includes(target)) {
    throw new Error(`禁止将本机 ${port} 端口转发回自身同端口，这会造成转发死循环`);
  }
}
