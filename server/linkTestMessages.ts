export type TunnelHopLatencyMode = "sum" | "max" | "multi-source";

export function structuredLinkTestMessage(input: {
  kind: string;
  message: string;
  details?: any[];
  totalLatencyMs?: number | null;
  groupId?: number | null;
  tunnelId?: number | null;
}) {
  return JSON.stringify({
    kind: input.kind,
    ...(input.groupId ? { groupId: input.groupId } : {}),
    ...(input.tunnelId ? { tunnelId: input.tunnelId } : {}),
    message: input.message,
    details: input.details || [],
    totalLatencyMs: input.totalLatencyMs ?? null,
  });
}

export function tunnelHopLatencyMode(meta: any): TunnelHopLatencyMode {
  const value = String(meta?.latencyMode || "");
  return value === "max" || value === "multi-source" ? value : "sum";
}

export function tunnelHopModeText(latencyMode: TunnelHopLatencyMode) {
  if (latencyMode === "max") {
    return {
      kind: "tunnel-load-balance-summary",
      label: "多出口负载探测",
      successPrefix: "多出口负载探测成功",
      failurePrefix: "多出口负载探测失败",
      totalLabel: "最大延迟",
      seriesLabel: "最大延迟",
    };
  }
  if (latencyMode === "multi-source") {
    return {
      kind: "tunnel-entry-group-summary",
      label: "多入口隧道探测",
      successPrefix: "多入口隧道探测成功",
      failurePrefix: "多入口隧道探测失败",
      totalLabel: "总延迟",
      seriesLabel: "总延迟",
    };
  }
  return {
    kind: "tunnel-hop-summary",
    label: "多级隧道逐跳测试",
    successPrefix: "多级隧道逐跳测试成功",
    failurePrefix: "多级隧道逐跳测试失败",
    totalLabel: undefined,
    seriesLabel: "总延迟",
  };
}
