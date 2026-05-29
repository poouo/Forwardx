export const FORWARD_TYPES = ["iptables", "nftables", "realm", "socat", "gost"] as const;

export type ForwardType = (typeof FORWARD_TYPES)[number];

// 连接数和 IP 数统计精度受限的转发类型（用户态代理，非内核级转发）。
// 这些类型通过 conntrack 近似统计连接，但无法像 iptables/nftables
// 那样在内核层面精确限制和计数每 IP 连接。
export const FORWARD_TYPES_WITH_APPROXIMATE_STATS: ReadonlySet<ForwardType> = new Set(["realm", "socat", "gost"]);

// 基于 FORWARD_TYPES_WITH_APPROXIMATE_STATS 对应的中文提示
export const APPROXIMATE_STATS_HINT = "连接数和 IP 数统计基于 conntrack 近似值，实际精度受转发工具自身连接管理影响，仅供参考";

export const FORWARD_TYPE_LABELS: Record<ForwardType, string> = {
  iptables: "iptables",
  nftables: "nftables",
  realm: "realm",
  socat: "socat",
  gost: "gost",
};

export const TUNNEL_PROTOCOLS = ["forwardx", "tls", "wss", "tcp", "mtls", "mwss", "mtcp"] as const;

export type TunnelProtocol = (typeof TUNNEL_PROTOCOLS)[number];

export type ForwardProtocolKey = ForwardType | TunnelProtocol;

export type ForwardProtocolSettings = Record<ForwardProtocolKey, boolean>;

export const FORWARD_PROTOCOL_LABELS: Record<ForwardProtocolKey, string> = {
  iptables: "iptables",
  nftables: "nftables",
  realm: "realm",
  socat: "socat",
  gost: "gost",
  forwardx: "ForwardX",
  tls: "GOST TLS",
  wss: "GOST WSS",
  tcp: "GOST TCP",
  mtls: "GOST MTLS",
  mwss: "GOST MWSS",
  mtcp: "GOST MTCP",
};

export const DEFAULT_FORWARD_PROTOCOL_SETTINGS: ForwardProtocolSettings = {
  iptables: true,
  nftables: true,
  realm: true,
  socat: true,
  gost: true,
  forwardx: true,
  tls: true,
  wss: true,
  tcp: true,
  mtls: true,
  mwss: true,
  mtcp: true,
};

export function normalizeForwardProtocolSettings(input?: Partial<Record<string, unknown>> | null): ForwardProtocolSettings {
  const out: ForwardProtocolSettings = { ...DEFAULT_FORWARD_PROTOCOL_SETTINGS };
  if (!input) return out;
  for (const key of [...FORWARD_TYPES, ...TUNNEL_PROTOCOLS]) {
    const value = input[key];
    if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "string") out[key] = value === "true";
  }
  return out;
}

export function isForwardProtocolEnabled(settings: Partial<Record<string, unknown>> | null | undefined, key: ForwardProtocolKey) {
  return normalizeForwardProtocolSettings(settings)[key] !== false;
}
