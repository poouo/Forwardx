import { isForwardRuleProtocolTcpEnabled } from "@shared/forwardTypes";

export type PortAccessLimitSpec = {
  userId: number;
  maxIPs: number;
  ports: number[];
};

export function onlyPortAccessLimitChanged(before: any, after: any) {
  if (!before || !after || Number(before.maxIPs || 0) === Number(after.maxIPs || 0)) return false;
  return ["maxConnections", "gostRateLimitIn", "gostRateLimitOut"].every(key => Number(before[key] || 0) === Number(after[key] || 0));
}

// The caller supplies only enabled/authorized rules on this entry host. A full
// snapshot (including an empty one) also removes limits for deleted rules.
export function portAccessLimitSpecs(
  rules: any[],
  limitsForUser: (userId: number) => { maxIPs?: number; maxConnections?: number },
): PortAccessLimitSpec[] {
  const users = new Map<number, PortAccessLimitSpec>();
  for (const rule of rules) {
    if (rule.tunnelId || !isForwardRuleProtocolTcpEnabled(rule.protocol)) continue;
    const userId = Number(rule.userId);
    const port = Number(rule.sourcePort);
    if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    const limits = limitsForUser(userId);
    const maxIPs = Math.max(0, Math.floor(Number(limits.maxIPs) || 0));
    if (!maxIPs) continue;
    const spec = users.get(userId) || { userId, maxIPs, ports: [] };
    spec.ports.push(port);
    users.set(userId, spec);
  }
  return [...users.values()].sort((a, b) => a.userId - b.userId).map(spec => ({
    ...spec, ports: [...new Set(spec.ports)].sort((a, b) => a - b),
  }));
}

export function portAccessLimitAction(specs: PortAccessLimitSpec[], supported: boolean) {
  if (!supported && !specs.length) return null;
  return {
    statusType: "runtime", op: "apply", forwardType: "port-access-limit-sync",
    sourcePort: 0, targetIp: "", targetPort: 0, protocol: "tcp",
    reportStatus: true, portAccessLimits: specs,
    // This auxiliary action must not keep listener recovery perpetually busy.
    // Agent reconciliation still executes changes and checks its own health.
    knownRunning: supported,
    // Old Agents must report an explicit failure, never silently adopt an
    // unknown structured field as an apparently successful empty action.
    commands: supported ? [] : ["echo 'TCP port access limits require an updated ForwardX Agent; forwarding remains active' >&2; exit 1"],
  };
}
