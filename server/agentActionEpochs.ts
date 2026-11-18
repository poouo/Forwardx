export type AgentActionEpoch = { signature: string; issuedAt: number };

/** Actions sharing a listener must advance together during an engine handoff. */
export function agentActionEpochKey(action: any): string {
  const port = Number(action?.sourcePort || 0);
  if (port > 0) return `port:${port}`;
  if (action?.statusType === "runtime") return `runtime:${action.forwardType || ""}:${action?.tunnelId || 0}`;
  return `${action?.statusType || "action"}:${action?.ruleId || 0}:${action?.tunnelId || 0}:${action?.pluginId || ""}:${action?.forwardType || ""}`;
}

/** A different action finishing must not invalidate unchanged work still running. */
export function reconcileAgentActionEpochs(
  previous: Map<string, AgentActionEpoch>,
  signatures: Map<string, string>,
  issuedAt: number,
): Map<string, AgentActionEpoch> {
  return new Map([...signatures].map(([key, signature]) => {
    const old = previous.get(key);
    return [key, old?.signature === signature
      ? old : { signature, issuedAt: Math.max(issuedAt, (old?.issuedAt || 0) + 1) }];
  }));
}
