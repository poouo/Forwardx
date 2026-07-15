function validPort(value: unknown) {
  const port = Number(value || 0);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

export function resolveRuleTrafficPortForHost(input: {
  sourcePort: unknown;
  usesTunnelRuntime: boolean;
  isEntry: boolean;
  exitPorts?: unknown[];
}) {
  const sourcePort = validPort(input.sourcePort);
  if (!input.usesTunnelRuntime || input.isEntry) return sourcePort;
  for (const value of input.exitPorts || []) {
    const port = validPort(value);
    if (port > 0) return port;
  }
  return 0;
}
