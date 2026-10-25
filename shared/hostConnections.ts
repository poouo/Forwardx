/** Current sockets in the Agent's network namespace; not lifetime connections. */
export type HostSocketCount = {
  status: "ok" | "unavailable";
  total?: number;
  inUse?: number;
  timeWait?: number;
  ipv6Included: boolean;
  reason?: "unsupported-platform" | "permission-denied" | "summary-missing" | "summary-unreadable" | "summary-invalid" | "ipv6-summary-missing";
};

export type HostConnectionStats = {
  version: 1;
  scope: "network-namespace";
  source: "proc-sockstat";
  sampledAt: number;
  tcp: HostSocketCount;
  udp: HostSocketCount;
};
