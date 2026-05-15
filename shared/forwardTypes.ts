export const FORWARD_TYPES = ["iptables", "realm", "socat", "gost"] as const;

export type ForwardType = (typeof FORWARD_TYPES)[number];

export const FORWARD_TYPE_LABELS: Record<ForwardType, string> = {
  iptables: "iptables",
  realm: "realm",
  socat: "socat",
  gost: "gost",
};

