import { LatencyRating } from "@/components/LatencyRating";
import type { LinkTestNodeMeta } from "@/lib/linkTestNodeMeta";
import { cn } from "@/lib/utils";

export type LinkTestDetail = {
  success: boolean;
  latencyMs: number | null;
  message?: string | null;
  hopLabel?: string | null;
  routeLabel?: string | null;
  method?: string | null;
  pending?: boolean | null;
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
  fromMeta?: LinkTestNodeMeta;
  toMeta?: LinkTestNodeMeta;
  success: boolean;
  latencyMs: number | null;
  message?: string | null;
  method?: string | null;
  pending?: boolean;
};

export type LinkTestPlannedSegment = {
  from: string;
  to: string;
  fromMeta?: LinkTestNodeMeta;
  toMeta?: LinkTestNodeMeta;
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
          pending: item?.pending === true,
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

export function hasPendingLinkTestDetails(parsed: ParsedLinkTestMessage | null | undefined) {
  return (parsed?.details || []).some((detail) => detail.pending === true);
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

function cleanNodeLabel(value: string) {
  return String(value || "")
    .replace(/^第\s*\d+\s*跳\s*/i, "")
    .replace(/^\d+\s*\/\s*\d+\s*/, "")
    .trim();
}

function parseRouteEndpoints(detail: LinkTestDetail, index: number) {
  const route = formatLinkTestRoute(detail).replace(/\s+/g, " ").trim();
  const arrowParts = route.split(/\s*(?:->|→|=>|至|到)\s*/).map((item) => item.trim()).filter(Boolean);
  if (arrowParts.length >= 2) {
    return {
      from: cleanNodeLabel(arrowParts[0]),
      to: arrowParts.slice(1).map(cleanNodeLabel).join(" -> "),
    };
  }

  const hopLabel = String(detail.hopLabel || "").replace(/\s+/g, " ").trim();
  const hopMatch = hopLabel.match(/(?:\d+\s*\/\s*\d+\s*)?(.+?)\s*->\s*(.+)$/);
  if (hopMatch) {
    return {
      from: cleanNodeLabel(hopMatch[1]),
      to: cleanNodeLabel(hopMatch[2]),
    };
  }

  return {
    from: index === 0 ? "入口" : `节点 ${index + 1}`,
    to: route && route !== "链路" ? route : `节点 ${index + 2}`,
  };
}

function lookupNodeMeta(meta: Record<string, LinkTestNodeMeta | undefined> | undefined, label: string) {
  if (!meta) return undefined;
  const clean = cleanNodeLabel(label);
  return meta[label] || meta[clean] || meta[clean.toLowerCase()];
}

function withNodeLabel(meta: LinkTestNodeMeta | undefined, fallback: string) {
  const label = String(meta?.label || "").trim();
  return label || fallback;
}

function buildProbeSegments(input: {
  parsed: ParsedLinkTestMessage;
  fallbackLatencyMs?: number | null;
  isSuccess: boolean;
  isTesting: boolean;
  sourceLabel?: string;
  targetLabel?: string;
  nodeMeta?: Record<string, LinkTestNodeMeta | undefined>;
  plannedSegments?: LinkTestPlannedSegment[];
}) {
  const visibleDetails = (input.parsed.details || []).filter((detail) => detail.pending || detail.success || detail.message || hasLatencyValue(detail));

  if (visibleDetails.length > 0) {
    return visibleDetails.map((detail, index): ProbeSegment => {
      const endpoints = parseRouteEndpoints(detail, index);
      const fromMeta = lookupNodeMeta(input.nodeMeta, endpoints.from);
      const toMeta = lookupNodeMeta(input.nodeMeta, endpoints.to);
      return {
        from: withNodeLabel(fromMeta, endpoints.from),
        to: withNodeLabel(toMeta, endpoints.to),
        fromMeta,
        toMeta,
        success: !!detail.success,
        latencyMs: detail.success && hasLatencyValue(detail) ? detail.latencyMs : null,
        message: detail.message || null,
        method: detail.method || null,
        pending: detail.pending === true,
      };
    });
  }

  const plannedSegments = (input.plannedSegments || [])
    .map((segment) => ({
      from: cleanNodeLabel(segment.from),
      to: cleanNodeLabel(segment.to),
      fromMeta: segment.fromMeta,
      toMeta: segment.toMeta,
    }))
    .filter((segment) => segment.from && segment.to);
  if (plannedSegments.length > 0) {
    return plannedSegments.map((segment, index): ProbeSegment => {
      const fromMeta = segment.fromMeta || lookupNodeMeta(input.nodeMeta, segment.from);
      const toMeta = segment.toMeta || lookupNodeMeta(input.nodeMeta, segment.to);
      const pending = input.isTesting || (!input.isSuccess && !input.parsed.message && !hasUsableLatencyValue(input.fallbackLatencyMs));
      return {
        from: withNodeLabel(fromMeta, segment.from),
        to: withNodeLabel(toMeta, segment.to),
        fromMeta,
        toMeta,
        success: input.isTesting ? true : input.isSuccess,
        latencyMs: !input.isTesting && input.isSuccess && plannedSegments.length === 1 && hasUsableLatencyValue(input.fallbackLatencyMs)
          ? Number(input.fallbackLatencyMs)
          : null,
        message: !input.isTesting && !input.isSuccess && index === 0 ? input.parsed.message || null : null,
        method: null,
        pending,
      };
    });
  }

  const sourceFallback = input.sourceLabel || "源节点";
  const targetFallback = input.targetLabel || "目的节点";
  const sourceMeta = lookupNodeMeta(input.nodeMeta, sourceFallback);
  const targetMeta = lookupNodeMeta(input.nodeMeta, targetFallback);
  return [{
    from: withNodeLabel(sourceMeta, sourceFallback),
    to: withNodeLabel(targetMeta, targetFallback),
    fromMeta: sourceMeta,
    toMeta: targetMeta,
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
  const visibleDetails = (input.parsed.details || []).filter((detail) => detail.pending || detail.success || detail.message || hasLatencyValue(detail));
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
  nodeMeta,
  plannedSegments,
  className,
}: {
  parsed: ParsedLinkTestMessage;
  fallbackLatencyMs?: number | null;
  isSuccess: boolean;
  isTesting: boolean;
  sourceLabel?: string;
  targetLabel?: string;
  nodeMeta?: Record<string, LinkTestNodeMeta | undefined>;
  plannedSegments?: LinkTestPlannedSegment[];
  className?: string;
}) {
  const segments = buildProbeSegments({ parsed, fallbackLatencyMs, isSuccess, isTesting, sourceLabel, targetLabel, nodeMeta, plannedSegments });
  const effectiveTesting = isTesting || segments.some((segment) => segment.pending);
  const totalLatency = effectiveTesting ? null : getLinkTestTotalLatency({ parsed, fallbackLatencyMs, isSuccess });
  const failedSegments = segments.filter((segment) => !effectiveTesting && !segment.pending && !segment.success);
  const hasSegments = segments.length > 0;
  const hasResult = effectiveTesting || segments.some((segment) => segment.success || segment.message || hasUsableLatencyValue(segment.latencyMs));
  const renderNode = (label: string, segmentMeta?: LinkTestNodeMeta) => {
    const meta = segmentMeta || lookupNodeMeta(nodeMeta, label);
    const countryCode = String(meta?.countryCode || "").trim().toUpperCase();
    const flagUrl = /^[A-Z]{2}$/.test(countryCode) ? `https://flagcdn.com/24x18/${countryCode.toLowerCase()}.png` : "";
    const region = String(meta?.region || "").trim();
    const address = String(meta?.address || "").trim();
    return (
      <div className="flex shrink-0 flex-col items-center gap-1">
        <div className="flex h-5 items-center justify-center text-[10px] font-semibold leading-5 text-muted-foreground" title={region || undefined}>
          {flagUrl ? (
            <>
              <img
                src={flagUrl}
                alt={countryCode}
                loading="lazy"
                referrerPolicy="no-referrer"
                className="h-3.5 w-5 rounded-[2px] object-cover shadow-sm"
                onError={(event) => {
                  event.currentTarget.style.display = "none";
                  const fallback = event.currentTarget.nextElementSibling as HTMLElement | null;
                  if (fallback) fallback.style.display = "inline";
                }}
              />
              <span className="hidden font-mono leading-none">{countryCode}</span>
            </>
          ) : (
            "\u00a0"
          )}
        </div>
        <div className="relative z-10 max-w-[128px] rounded-md border border-border/70 bg-background px-3 py-2 text-center text-sm font-medium shadow-sm">
          <span className="block truncate" title={[label, address, region].filter(Boolean).join(" / ") || label}>
            {shortNodeLabel(label)}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className={cn("space-y-3", className)}>
      <div className="overflow-x-auto pb-1">
        <div className="flex min-w-[360px] items-start justify-center px-2 py-8">
          {segments.map((segment, index) => {
            const firstNode = index === 0;
            const segmentTesting = effectiveTesting && (isTesting || segment.pending);
            const segmentOk = segmentTesting || segment.success;
            const label = segmentTesting
                ? "探测中"
                : segment.pending
                  ? "探测中"
                : segmentOk && hasUsableLatencyValue(segment.latencyMs)
                  ? formatLatencyMs(segment.latencyMs)
                  : segmentOk && segments.length === 1
                    ? "成功"
                  : segmentOk
                    ? ""
                  : "失败";
            return (
              <div key={`${segment.from}-${segment.to}-${index}`} className="contents">
                {firstNode ? (
                  renderNode(segment.from, segment.fromMeta)
                ) : null}
                <div className="relative mt-[45px] h-px min-w-[96px] flex-1 bg-border">
                  <div
                    className={cn(
                      "absolute inset-x-0 top-0 h-px",
                      segmentTesting ? "bg-primary/70" : segmentOk ? "bg-emerald-500/70" : "bg-destructive/70",
                      segmentTesting ? "animate-pulse" : "",
                    )}
                  />
                  <span
                    className={cn(
                      "absolute left-1/2 top-[-1.65rem] -translate-x-1/2 whitespace-nowrap text-xs font-semibold tabular-nums",
                      segmentTesting ? "text-primary" : segmentOk ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
                    )}
                  >
                    {label || "\u00a0"}
                  </span>
                </div>
                {renderNode(segment.to, segment.toMeta)}
              </div>
            );
          })}
        </div>
      </div>

      {!hasSegments && !hasResult ? (
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
      ) : !effectiveTesting && !isSuccess && parsed.message ? (
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
          {effectiveTesting ? "探测中" : formatLatencyMs(totalLatency)}
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
  if (isTesting || hasPendingLinkTestDetails(parsed)) return <span className="text-sm font-semibold tabular-nums">正在测试中</span>;

  const details = parsed.details || [];
  const visibleDetails = details.filter((detail) => detail.pending || detail.success || detail.message || hasLatencyValue(detail));
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
              {detail.pending ? (
                <span className="font-normal text-primary">探测中</span>
              ) : detail.success && hasLatencyValue(detail) ? (
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
