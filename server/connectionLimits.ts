import { isForwardRuleProtocolTcpEnabled, isForwardRuleProtocolUdpEnabled } from "../shared/forwardTypes";

export type ConnectionLimitSpec = { userId: number; maxConnections: number; tcpPorts: number[]; udpPorts: number[] };

// All enabled entry listeners on this host, including tunnels and chain rules.
export function connectionLimitSpecs(rules: any[], limitsForUser: (id: number) => { maxConnections?: number }): ConnectionLimitSpec[] {
  const users = new Map<number, ConnectionLimitSpec>();
  for (const rule of rules) {
    const userId = Number(rule.userId), port = Number(rule.sourcePort);
    if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    const maxConnections = Math.max(0, Math.floor(Number(limitsForUser(userId).maxConnections) || 0));
    if (!maxConnections) continue;
    const spec = users.get(userId) || { userId, maxConnections, tcpPorts: [], udpPorts: [] };
    if (isForwardRuleProtocolTcpEnabled(rule.protocol)) spec.tcpPorts.push(port);
    if (isForwardRuleProtocolUdpEnabled(rule.protocol)) spec.udpPorts.push(port);
    users.set(userId, spec);
  }
  return [...users.values()].sort((a, b) => a.userId - b.userId).map(spec => ({
    ...spec, tcpPorts: [...new Set(spec.tcpPorts)].sort((a, b) => a - b), udpPorts: [...new Set(spec.udpPorts)].sort((a, b) => a - b),
  })).filter(spec => spec.tcpPorts.length || spec.udpPorts.length);
}

export function connectionLimitAction(specs: ConnectionLimitSpec[], supported: boolean) {
  if (!supported && !specs.length) return null;
  return {
    statusType: "runtime", op: "apply", forwardType: "connection-limit-sync",
    sourcePort: 0, targetIp: "", targetPort: 0, protocol: "both", reportStatus: true,
    connectionLimits: specs, knownRunning: supported,
    commands: supported ? [] : ["echo '连接数限制未生效：请升级 ForwardX Agent，节点需要 nftables 和 CAP_NET_ADMIN。' >&2; exit 1"],
  };
}
