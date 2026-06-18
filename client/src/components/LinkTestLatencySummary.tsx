import { LatencyRating } from "@/components/LatencyRating";
import { cn } from "@/lib/utils";

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

type ProbeSegment = {
  from: string;
  to: string;
  success: boolean;
  latencyMs: number | null;
  message?: string | null;
  method?: string | null;
  pending?: boolean;
};

export function parseLinkTestMessage(raw: unknown): ParsedLinkTestMessage {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { message: "", details: [], totalLatencyMs: null };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const source = parsed as any;
      const details = Array.isArray(source.details)
        ? source.details.map((item: any): LinkTestDetail => ({
          success: !!item?.success,
          latencyMs: typeof item?.latencyMs === "number" ? item.latencyMs : null,
          message: typeof item?.message === "string" ? item.message : null,
          hopLabel: typeof item?.hopLabel === "string" ? item.hopLabel : null,
          routeLabel: typeof item?.routeLabel === "string" ? item.routeLabel : null,
          method: typeof item?.method === "string" ? item.method : null,
        }))
        : [];
      return {
        kind: typeof source.kind === "string" ? source.kind : undefined,
        message: typeof source.message === "string" ? source.message : text,
        details,
        totalLatencyMs: typeof source.totalLatencyMs === "number" ? source.totalLatencyMs : null,
      };
    }
  } catch {
    // Older results were stored as plain text.
  }
  return { message: text, details: [], totalLatencyMs: null };
}

export function hasLinkTestDetails(parsed: ParsedLinkTestMessage | null | undefined) {
  return !!parsed?.details?.length;
}

export function formatLinkTestRoute(detail: LinkTestDetail) {
  const route = String(detail.routeLabel || detail.hopLabel || "链路").trim();
  return route.replace(/^第\s*\d+\s*跳\s*/, "");
}

function hasLatencyValue(detail: LinkTestDetail) {
  return typeof detail.latencyMs === "number" && Number.isFinite(detail.latencyMs);
}

function hasUsableLatencyValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value);
}

function formatLatencyMs(value: number | null | undefined) {
  if (!hasUsableLatencyValue(value)) return "--";
  const rounded = Math.round(Number(value) * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} ms`;
}

function shortNodeLabel(value: string) {
  const text = String(value || "").trim() || "-";
  return text.length > 14 ? `${text.slice(0, 13)}...` : text;
}

function parseRouteEndpoints(detail: LinkTestDetail, index: number) {
  const route = formatLinkTestRoute(detail).replace(/\s+/g, " ").trim();
  const arrowParts = route.split(/\s*(?:->|→|=>|至|到)\s*/).map((item) => item.trim()).filter(Boolean);
  if (arrowParts.length >= 2) {
    return {
      from: arrowParts[0],
      to: arrowParts.slice(1).join(" -> "),
    };
  }

  const hopLabel = String(detail.hopLabel || "").replace(/\s+/g, " ").trim();
  const hopMatch = hopLabel.match(/(?:\d+\s*\/\s*\d+\s*)?(.+?)\s*->\s*(.+)$/);
  if (hopMatch) {
    return {
      from: hopMatch[1].trim(),
      to: hopMatch[2].trim(),
    };
  }

  return {
    from: index === 0 ? "入口" : `节点 ${index + 1}`,
    to: route && route !== "链路" ? route : `节点 ${index + 2}`,
  };
}

function buildProbeSegments(input: {
  parsed: ParsedLinkTestMessage;
  fallbackLatencyMs?: number | null;
  isSuccess: boolean;
  isTesting: boolean;
  sourceLabel?: string;
  targetLabel?: string;
}) {
  const visibleDetails = (input.parsed.details || []).filter((detail) => detail.success || detail.message || hasLatencyValue(detail));

  if (visibleDetails.length > 0) {
    return visibleDetails.map((detail, index): ProbeSegment => {
      const endpoints = parseRouteEndpoints(detail, index);
      return {
        ...endpoints,
        success: !!detail.success,
        latencyMs: detail.success && hasLatencyValue(detail) ? detail.latencyMs : null,
        message: detail.message || null,
        method: detail.method || null,
      };
    });
  }

  return [{
    from: input.sourceLabel || "入口",
    to: input.targetLabel || "目标",
    success: input.isTesting ? true : input.isSuccess,
    latencyMs: !input.isTesting && input.isSuccess && hasUsableLatencyValue(input.fallbackLatencyMs) ? Number(input.fallbackLatencyMs) : null,
    message: !input.isTesting && !input.isSuccess ? input.parsed.message || null : null,
    method: null,
    pending: !input.isTesting && !input.isSuccess && !input.parsed.message && !hasUsableLatencyValue(input.fallbackLatencyMs),
  }];
}

export function getLinkTestTotalLatency(input: {
  parsed: ParsedLinkTestMessage;
  fallbackLatencyMs?: number | null;
  isSuccess: boolean;
}) {
  if (hasUsableLatencyValue(input.parsed.totalLatencyMs)) return Number(input.parsed.totalLatencyMs);
  const visibleDetails = (input.parsed.details || []).filter((detail) => detail.success || detail.message || hasLatencyValue(detail));
  if (visibleDetails.length > 0) {
    const successfulLatencyDetails = visibleDetails.filter((detail) => detail.success && hasLatencyValue(detail));
    if (successfulLatencyDetails.length === visibleDetails.length) {
      return successfulLatencyDetails.reduce((sum, detail) => sum + Number(detail.latencyMs || 0), 0);
    }
    return null;
  }
  if (input.isSuccess && hasUsableLatencyValue(input.fallbackLatencyMs)) return Number(input.fallbackLatencyMs);
  return null;
}

export function LinkTestProbeView({
  parsed,
  fallbackLatencyMs,
  isSuccess,
  isTesting,
  sourceLabel = "入口",
  targetLabel = "目标",
  className,
}: {
  parsed: ParsedLinkTestMessage;
  fallbackLatencyMs?: number | null;
  isSuccess: boolean;
  isTesting: boolean;
  sourceLabel?: string;
  targetLabel?: string;
  className?: string;
}) {
  const segments = buildProbeSegments({ parsed, fallbackLatencyMs, isSuccess, isTesting, sourceLabel, targetLabel });
  const totalLatency = isTesting ? null : getLinkTestTotalLatency({ parsed, fallbackLatencyMs, isSuccess });
  const failedSegments = segments.filter((segment) => !segment.pending && !segment.success);
  const hasResult = isTesting || segments.some((segment) => segment.success || segment.message || hasUsableLatencyValue(segment.latencyMs));

  return (
    <div className={cn("space-y-3", className)}>
      <div className="overflow-x-auto pb-1">
        <div className="flex min-w-[360px] items-center justify-center px-2 py-8">
          {segments.map((segment, index) => {
            const firstNode = index === 0;
            const segmentOk = isTesting || segment.success;
            const label = segment.pending
              ? "待探测"
              : isTesting
                ? "探测中"
                : segmentOk && hasUsableLatencyValue(segment.latencyMs)
                  ? formatLatencyMs(segment.latencyMs)
                  : "失败";
            return (
              <div key={`${segment.from}-${segment.to}-${index}`} className="contents">
                {firstNode ? (
                  <div className="relative z-10 max-w-[116px] shrink-0 rounded-md border border-border/70 bg-background px-3 py-2 text-center text-sm font-medium shadow-sm">
                    <span className="block truncate" title={segment.from}>{shortNodeLabel(segment.from)}</span>
                  </div>
                ) : null}
                <div className="relative h-px min-w-[96px] flex-1 bg-border">
                  <div
                    className={cn(
                      "absolute inset-x-0 top-0 h-px",
                      segment.pending ? "bg-border" : segmentOk ? "bg-emerald-500/70" : "bg-destructive/70",
                      isTesting ? "animate-pulse" : "",
                    )}
                  />
                  <span
                    className={cn(
                      "absolute left-1/2 top-[-1.65rem] -translate-x-1/2 whitespace-nowrap text-xs font-semibold tabular-nums",
                      segment.pending ? "text-muted-foreground" : segmentOk ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
                    )}
                  >
                    {label}
                  </span>
                </div>
                <div className="relative z-10 max-w-[116px] shrink-0 rounded-md border border-border/70 bg-background px-3 py-2 text-center text-sm font-medium shadow-sm">
                  <span className="block truncate" title={segment.to}>{shortNodeLabel(segment.to)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {!hasResult ? (
        <div className="rounded-md border border-dashed border-border/70 px-3 py-4 text-center text-sm text-muted-foreground">
          尚未运行探测
        </div>
      ) : null}

      {failedSegments.length > 0 ? (
        <div className="space-y-1 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {failedSegments.map((segment, index) => (
            <p key={`${segment.from}-${segment.to}-error-${index}`} className="break-words">
              {segment.from} {"->"} {segment.to}: {segment.message || parsed.message || "探测失败"}
            </p>
          ))}
        </div>
      ) : !isTesting && !isSuccess && parsed.message ? (
        <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {parsed.message}
        </div>
      ) : null}

      <div className="flex items-center justify-between border-t border-border/70 pt-3 text-sm">
        <span className="text-muted-foreground">合计</span>
        <span className={cn(
          "font-semibold tabular-nums",
          totalLatency !== null ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
        )}>
          {isTesting ? "探测中" : formatLatencyMs(totalLatency)}
        </span>
      </div>
    </div>
  );
}

function renderLatencyValue(latencyMs: number | null | undefined) {
  return <LatencyRating latencyMs={latencyMs} emptyText="--" icon="none" className="text-sm" />;
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
  const visibleDetails = details.filter((detail) => detail.success || detail.message || hasLatencyValue(detail));
  const successfulLatencyDetails = visibleDetails.filter((detail) => detail.success && hasLatencyValue(detail));

  if (visibleDetails.length > 0) {
    const totalLatency = getLinkTestTotalLatency({ parsed, fallbackLatencyMs, isSuccess });

    if (visibleDetails.length === 1 && successfulLatencyDetails.length === 1) {
      return <span className="text-sm font-semibold">{renderLatencyValue(visibleDetails[0].latencyMs)}</span>;
    }

    return (
      <div className="flex min-w-0 flex-1 flex-col items-end gap-1 text-right text-sm font-semibold">
        <div className="flex max-w-full flex-col items-end gap-1">
          {visibleDetails.map((detail, index) => (
            <div
              key={`${detail.hopLabel || detail.routeLabel || index}`}
              className={detail.success
                ? "flex max-w-full flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5 break-words"
                : "flex max-w-full flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5 break-words text-destructive"}
            >
              <span className="min-w-0 break-words">{formatLinkTestRoute(detail)}</span>
              {detail.success && hasLatencyValue(detail) ? (
                renderLatencyValue(detail.latencyMs)
              ) : (
                <>
                  <span>失败</span>
                  {detail.message ? <span className="font-normal">: {detail.message}</span> : null}
                </>
              )}
            </div>
          ))}
        </div>
        {totalLatency !== null ? (
          <span className="inline-flex max-w-full flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5">
            <span>总延迟</span>
            {renderLatencyValue(totalLatency)}
          </span>
        ) : null}
      </div>
    );
  }

  if (isSuccess && fallbackLatencyMs !== null && fallbackLatencyMs !== undefined) {
    return <span className="text-sm font-semibold">{renderLatencyValue(fallbackLatencyMs)}</span>;
  }

  if (!isSuccess && parsed.message) {
    return <span className="min-w-0 flex-1 break-words text-right text-sm font-medium text-destructive">{parsed.message}</span>;
  }

  if (fallbackLatencyMs !== null && fallbackLatencyMs !== undefined) {
    return <span className="text-sm font-semibold">{renderLatencyValue(fallbackLatencyMs)}</span>;
  }

  return <span className="text-sm font-semibold tabular-nums">--</span>;
}
