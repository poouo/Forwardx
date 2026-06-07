export type LinkTestDetail = {
  success: boolean;
  latencyMs: number | null;
  message?: string | null;
  hopLabel?: string | null;
  routeLabel?: string | null;
  method?: string | null;
};

export type ParsedLinkTestMessage = {
  kind?: string;
  message: string;
  details: LinkTestDetail[];
  totalLatencyMs: number | null;
};

export function parseLinkTestMessage(raw: unknown): ParsedLinkTestMessage {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { message: "", details: [], totalLatencyMs: null };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const details = Array.isArray(parsed.details)
        ? parsed.details.map((item: any): LinkTestDetail => ({
          success: !!item?.success,
          latencyMs: typeof item?.latencyMs === "number" ? item.latencyMs : null,
          message: typeof item?.message === "string" ? item.message : null,
          hopLabel: typeof item?.hopLabel === "string" ? item.hopLabel : null,
          routeLabel: typeof item?.routeLabel === "string" ? item.routeLabel : null,
          method: typeof item?.method === "string" ? item.method : null,
        }))
        : [];
      return {
        kind: typeof parsed.kind === "string" ? parsed.kind : undefined,
        message: typeof parsed.message === "string" ? parsed.message : text,
        details,
        totalLatencyMs: typeof parsed.totalLatencyMs === "number" ? parsed.totalLatencyMs : null,
      };
    }
  } catch {
    // Older results were stored as plain text.
  }
  return { message: text, details: [], totalLatencyMs: null };
}

export function formatLinkTestRoute(detail: LinkTestDetail) {
  const route = String(detail.routeLabel || detail.hopLabel || "链路").trim();
  return route.replace(/^第\s*\d+\s*跳\s*/, "");
}

export function LinkTestLatencySummary({
  parsed,
  fallbackLatencyMs,
  isSuccess,
  isTesting,
}: {
  parsed: ParsedLinkTestMessage;
  fallbackLatencyMs?: number | null;
  isSuccess: boolean;
  isTesting: boolean;
}) {
  if (isTesting) return <span className="text-sm font-semibold tabular-nums">正在测试中</span>;
  const details = parsed.details || [];
  const visibleDetails = details.filter((detail) => detail.success && typeof detail.latencyMs === "number");
  if (isSuccess && visibleDetails.length > 0) {
    const totalLatency = typeof parsed.totalLatencyMs === "number"
      ? parsed.totalLatencyMs
      : visibleDetails.reduce((sum, detail) => sum + Number(detail.latencyMs || 0), 0);
    if (visibleDetails.length === 1) {
      return <span className="text-sm font-semibold tabular-nums">{visibleDetails[0].latencyMs} ms</span>;
    }
    return (
      <div className="flex flex-wrap justify-end gap-x-3 gap-y-1 text-right text-sm font-semibold tabular-nums">
        {visibleDetails.map((detail, index) => (
          <span key={`${detail.hopLabel || detail.routeLabel || index}`}>
            {formatLinkTestRoute(detail)} {detail.latencyMs}ms
          </span>
        ))}
        <span className="text-primary">总延迟 {totalLatency}ms</span>
      </div>
    );
  }
  if (isSuccess && fallbackLatencyMs !== null && fallbackLatencyMs !== undefined) {
    return <span className="text-sm font-semibold tabular-nums">{fallbackLatencyMs} ms</span>;
  }
  return <span className="text-sm font-semibold tabular-nums">--</span>;
}
