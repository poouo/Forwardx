export const FORWARD_TYPES = ["iptables", "nftables", "realm", "socat", "gost", "nginx"] as const;

export type ForwardType = (typeof FORWARD_TYPES)[number];
export type ForwardRuleProtocol = "tcp" | "udp" | "both";

export const FORWARD_TYPE_LABELS: Record<ForwardType, string> = {
  iptables: "iptables",
  nftables: "nftables",
  realm: "realm",
  socat: "socat",
  gost: "gost",
  nginx: "nginx",
};

export const FORWARD_RULE_PROTOCOL_LABELS: Record<ForwardRuleProtocol, string> = {
  tcp: "TCP",
  udp: "UDP",
  both: "TCP + UDP",
};

export function normalizeForwardRuleProtocol(protocol: unknown, fallback: ForwardRuleProtocol = "tcp"): ForwardRuleProtocol {
  const raw = String(protocol ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "tcp" || raw === "udp" || raw === "both") return raw;
  const compact = raw.replace(/[\s_+\/-]+/g, "");
  if (compact === "tcpudp" || compact === "udptcp" || compact === "tcpandudp" || compact === "udpandtcp") return "both";
  return fallback;
}

export function forwardRuleProtocols(protocol: unknown, fallback: ForwardRuleProtocol = "tcp"): Array<"tcp" | "udp"> {
  const normalized = normalizeForwardRuleProtocol(protocol, fallback);
  if (normalized === "udp") return ["udp"];
  if (normalized === "both") return ["tcp", "udp"];
  return ["tcp"];
}

export function isForwardRuleProtocolTcpEnabled(protocol: unknown, fallback: ForwardRuleProtocol = "tcp") {
  return normalizeForwardRuleProtocol(protocol, fallback) !== "udp";
}

export function isForwardRuleProtocolUdpEnabled(protocol: unknown, fallback: ForwardRuleProtocol = "tcp") {
  return normalizeForwardRuleProtocol(protocol, fallback) !== "tcp";
}

export function formatForwardRuleProtocol(protocol: string | null | undefined) {
  if (protocol == null || String(protocol).trim() === "") return "-";
  return FORWARD_RULE_PROTOCOL_LABELS[normalizeForwardRuleProtocol(protocol)];
}

export const TUNNEL_PROTOCOLS = ["forwardx", "tls", "wss", "tcp", "mtls", "mwss", "mtcp", "nginx_stream", "nginx_tls"] as const;

export type TunnelProtocol = (typeof TUNNEL_PROTOCOLS)[number];

export const FORWARD_PROTOCOLS = Array.from(new Set([...FORWARD_TYPES, ...TUNNEL_PROTOCOLS])) as Array<ForwardType | TunnelProtocol>;

export type ForwardProtocolKey = ForwardType | TunnelProtocol;

export type ForwardProtocolSettings = Record<ForwardProtocolKey, boolean>;

export const FORWARD_PROTOCOL_LABELS: Record<ForwardProtocolKey, string> = {
  iptables: "iptables",
  nftables: "nftables",
  realm: "realm",
  socat: "socat",
  gost: "gost",
  nginx: "Nginx",
  forwardx: "ForwardX",
  tls: "GOST TLS",
  wss: "GOST WSS",
  tcp: "GOST TCP",
  mtls: "GOST MTLS",
  mwss: "GOST MWSS",
  mtcp: "GOST MTCP",
  nginx_stream: "Nginx",
  nginx_tls: "Nginx",
};

export const DEFAULT_FORWARD_PROTOCOL_SETTINGS: ForwardProtocolSettings = {
  iptables: true,
  nftables: true,
  realm: true,
  socat: true,
  gost: true,
  nginx: true,
  forwardx: true,
  tls: true,
  wss: true,
  tcp: true,
  mtls: true,
  mwss: true,
  mtcp: true,
  nginx_stream: true,
  nginx_tls: true,
};

export function normalizeForwardProtocolSettings(input?: Partial<Record<string, unknown>> | null): ForwardProtocolSettings {
  const out: ForwardProtocolSettings = { ...DEFAULT_FORWARD_PROTOCOL_SETTINGS };
  if (!input) return out;
  for (const key of FORWARD_PROTOCOLS) {
    const value = input[key];
    if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "string") out[key] = value === "true";
  }
  return out;
}

export function isForwardProtocolEnabled(settings: Partial<Record<string, unknown>> | null | undefined, key: ForwardProtocolKey) {
  return normalizeForwardProtocolSettings(settings)[key] !== false;
}
