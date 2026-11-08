import { isForwardRuleProtocolTcpEnabled, isForwardRuleProtocolUdpEnabled } from "../shared/forwardTypes";

export type IPAccessLimitSpec = { userId: number; maxIPs: number; tcpPorts: number[]; udpPorts: number[] };

// Entry rules only, already expanded/authorized for the requesting Agent.
// Different IP addresses share one quota across TCP, UDP and all entry ports.
export function ipAccessLimitSpecs(rules: any[], limitsForUser: (id: number) => { maxIPs?: number }): IPAccessLimitSpec[] {
  const users = new Map<number, IPAccessLimitSpec>();
  for (const rule of rules) {
    const userId = Number(rule.userId), port = Number(rule.sourcePort);
    if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    const maxIPs = Math.max(0, Math.floor(Number(limitsForUser(userId).maxIPs) || 0));
    if (!maxIPs) continue;
    const spec = users.get(userId) || { userId, maxIPs, tcpPorts: [], udpPorts: [] };
    if (isForwardRuleProtocolTcpEnabled(rule.protocol)) spec.tcpPorts.push(port);
    if (isForwardRuleProtocolUdpEnabled(rule.protocol)) spec.udpPorts.push(port);
    users.set(userId, spec);
  }
  return [...users.values()].sort((a, b) => a.userId - b.userId).map(spec => ({
    ...spec, tcpPorts: [...new Set(spec.tcpPorts)].sort((a, b) => a - b), udpPorts: [...new Set(spec.udpPorts)].sort((a, b) => a - b),
  })).filter(spec => spec.tcpPorts.length || spec.udpPorts.length);
}

export function ipAccessLimitAction(specs: IPAccessLimitSpec[], supported: boolean) {
  if (!supported && !specs.length) return null;
  return {
    statusType: "runtime", op: "apply", forwardType: "ip-access-limit-sync",
    sourcePort: 0, targetIp: "", targetPort: 0, protocol: "both", reportStatus: true,
    ipAccessLimits: specs, knownRunning: supported,
    commands: supported ? [] : ["echo 'IP限制未生效：请升级 ForwardX Agent，以支持同时在线 IP 数限制；不会套用旧的单 IP 连接数限制。' >&2; exit 1"],
  };
}
