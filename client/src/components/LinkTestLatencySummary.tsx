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
  success?: boolean;
  latencyMs?: number | null;
  message?: string | null;
  method?: string | null;
  pending?: boolean | null;
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

function shortNodeLabel(value: string, maxLength = 14) {
  const text = String(value || "").trim() || "-";
  return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 1))}...` : text;
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

  const plannedSegments = (input.plannedSegments || [])
    .map((segment) => ({
      from: cleanNodeLabel(segment.from),
      to: cleanNodeLabel(segment.to),
      fromMeta: segment.fromMeta,
      toMeta: segment.toMeta,
      success: segment.success,
      latencyMs: segment.latencyMs,
      message: segment.message,
      method: segment.method,
      pending: segment.pending,
    }))
    .filter((segment) => segment.from && segment.to);

  const usePlannedSegments = plannedSegments.length > 0
    && (
      visibleDetails.length === 0
      || visibleDetails.length < plannedSegments.length
      || (visibleDetails.length === 1 && plannedSegments.length > 1)
    );

  if (visibleDetails.length > 0 && !usePlannedSegments) {
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

  if (plannedSegments.length > 0) {
    return plannedSegments.map((segment, index): ProbeSegment => {
      const detail = visibleDetails[index] || (index === plannedSegments.length - 1 ? visibleDetails[visibleDetails.length - 1] : null);
      const fromMeta = segment.fromMeta || lookupNodeMeta(input.nodeMeta, segment.from);
      const toMeta = segment.toMeta || lookupNodeMeta(input.nodeMeta, segment.to);
      const detailApplies = !!detail && (visibleDetails.length >= plannedSegments.length || index === plannedSegments.length - 1);
      const detailSuccess = detailApplies && typeof detail?.success === "boolean" ? !!detail.success : undefined;
      const detailLatency = detailApplies && detail?.success && hasLatencyValue(detail) ? detail.latencyMs : null;
      const detailMessage = detailApplies ? detail?.message || null : null;
      const hasExplicitSuccess = typeof segment.success === "boolean" || typeof detailSuccess === "boolean";
      const hasExplicitLatency = hasUsableLatencyValue(segment.latencyMs) || hasUsableLatencyValue(detailLatency);
      const hasExplicitState = hasExplicitSuccess || hasExplicitLatency || !!segment.message || !!detailMessage || segment.pending === true || detail?.pending === true;
      const isLastSegment = index === plannedSegments.length - 1;
      const pending = segment.pending === true || detail?.pending === true
        || input.isTesting
        || (!hasExplicitState && !input.isSuccess && !input.parsed.message && !hasUsableLatencyValue(input.fallbackLatencyMs));
      const success = pending
        ? true
        : typeof detailSuccess === "boolean"
          ? detailSuccess
        : hasExplicitSuccess
          ? !!segment.success
        : hasExplicitLatency
          ? true
          : !input.isSuccess && input.parsed.message && !isLastSegment
            ? true
            : input.isSuccess;
      return {
        from: withNodeLabel(fromMeta, segment.from),
        to: withNodeLabel(toMeta, segment.to),
        fromMeta,
        toMeta,
        success,
        latencyMs: success && hasUsableLatencyValue(detailLatency)
          ? Number(detailLatency)
          : success && hasUsableLatencyValue(segment.latencyMs)
            ? Number(segment.latencyMs)
            : !input.isTesting && input.isSuccess && plannedSegments.length === 1 && hasUsableLatencyValue(input.fallbackLatencyMs)
              ? Number(input.fallbackLatencyMs)
              : null,
        message: !pending && !success ? detailMessage || segment.message || (isLastSegment ? input.parsed.message || null : null) : null,
        method: detail?.method || segment.method || null,
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
  compactFrom = 4,
  roomyNodes = false,
  mobileStacked = true,
  wrapDesktopRows = true,
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
  compactFrom?: number;
  roomyNodes?: boolean;
  mobileStacked?: boolean;
  wrapDesktopRows?: boolean;
  className?: string;
}) {
  const segments = buildProbeSegments({ parsed, fallbackLatencyMs, isSuccess, isTesting, sourceLabel, targetLabel, nodeMeta, plannedSegments });
  const effectiveTesting = isTesting || segments.some((segment) => segment.pending);
  const totalLatency = effectiveTesting ? null : getLinkTestTotalLatency({ parsed, fallbackLatencyMs, isSuccess });
  const hasSegments = segments.length > 0;
  const hasResult = effectiveTesting || segments.some((segment) => segment.success || segment.message || hasUsableLatencyValue(segment.latencyMs));
  const compactPath = segments.length >= compactFrom;
  const densePath = segments.length >= 6;
  const shouldWrapDesktopRows = wrapDesktopRows && segments.length >= 4;
  const shouldStretchDesktopPath = !shouldWrapDesktopRows && segments.length <= Math.max(3, compactFrom);
  const segmentsPerDesktopRow = shouldWrapDesktopRows ? 2 : segments.length;
  const desktopRows = shouldWrapDesktopRows
    ? Array.from({ length: Math.ceil(segments.length / segmentsPerDesktopRow) }, (_, index) => segments.slice(index * segmentsPerDesktopRow, (index + 1) * segmentsPerDesktopRow))
    : [segments];
  const getSegmentState = (segment: ProbeSegment) => {
    const testing = effectiveTesting && (isTesting || segment.pending);
    const ok = testing || segment.success;
    const label = testing
      ? "探测中"
      : segment.pending
        ? "探测中"
        : ok && hasUsableLatencyValue(segment.latencyMs)
          ? formatLatencyMs(segment.latencyMs)
          : ok && segments.length === 1
            ? "成功"
            : ok
              ? ""
              : "失败";
    return { testing, ok, label };
  };
  const renderFlag = (meta?: LinkTestNodeMeta) => {
    const countryCode = String(meta?.countryCode || "").trim().toUpperCase();
    const flagUrl = /^[A-Z]{2}$/.test(countryCode) ? `https://flagcdn.com/24x18/${countryCode.toLowerCase()}.png` : "";
    if (!flagUrl) return <span className="inline-block h-3.5 w-5" aria-hidden="true" />;
    return (
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
    );
  };
  const renderNode = (label: string, segmentMeta?: LinkTestNodeMeta) => {
    const meta = segmentMeta || lookupNodeMeta(nodeMeta, label);
    const region = String(meta?.region || "").trim();
    const address = String(meta?.address || "").trim();
    const nodeWidthClass = shouldStretchDesktopPath
      ? segments.length >= 3
        ? "max-w-[104px]"
        : segments.length >= 2
          ? "max-w-[144px]"
          : roomyNodes
            ? "max-w-[176px]"
            : "max-w-[128px]"
      : roomyNodes
        ? shouldWrapDesktopRows ? "max-w-[128px]" : densePath ? "max-w-[128px]" : compactPath ? "max-w-[160px]" : "max-w-[176px]"
        : densePath ? "max-w-[88px]" : compactPath ? "max-w-[104px]" : "max-w-[128px]";
    const labelMaxLength = shouldStretchDesktopPath
      ? segments.length >= 3 ? 11 : segments.length >= 2 ? 14 : roomyNodes ? 18 : 14
      : shouldWrapDesktopRows ? 15 : roomyNodes ? 18 : 14;
    return (
      <div className="flex shrink-0 flex-col items-center gap-1">
        <div className="flex h-5 items-center justify-center text-[10px] font-semibold leading-5 text-muted-foreground" title={region || undefined}>
          {renderFlag(meta)}
        </div>
        <div className={cn("relative z-10 rounded-md border border-border/70 bg-background px-3 py-2 text-center text-sm font-medium shadow-sm", nodeWidthClass)}>
          <span className="block truncate" title={[label, address, region].filter(Boolean).join(" / ") || label}>
            {shortNodeLabel(label, labelMaxLength)}
          </span>
        </div>
      </div>
    );
  };
  const renderMobileNode = (label: string, segmentMeta?: LinkTestNodeMeta) => {
    const meta = segmentMeta || lookupNodeMeta(nodeMeta, label);
    const region = String(meta?.region || "").trim();
    const address = String(meta?.address || "").trim();
    return (
      <div
        className="mx-auto flex w-full max-w-[18rem] items-center justify-center gap-2 rounded-md border border-border/70 bg-background px-3 py-2 text-sm font-medium shadow-sm"
        title={[label, address, region].filter(Boolean).join(" / ") || label}
      >
        <span className="flex h-4 w-6 shrink-0 items-center justify-center">{renderFlag(meta)}</span>
        <span className="min-w-0 truncate">{shortNodeLabel(label, 22)}</span>
      </div>
    );
  };

  return (
    <div className={cn("space-y-3", className)}>
      {mobileStacked ? (
        <div className="space-y-0 py-2 sm:hidden">
          {segments.map((segment, index) => {
            const firstNode = index === 0;
            const { testing, ok, label } = getSegmentState(segment);
            return (
              <div key={`mobile-${segment.from}-${segment.to}-${index}`}>
                {firstNode ? renderMobileNode(segment.from, segment.fromMeta) : null}
                <div className="relative mx-auto flex h-12 max-w-[18rem] items-center justify-center">
                  <div
                    className={cn(
                      "absolute bottom-1 top-1 w-px",
                      testing ? "bg-primary/70" : ok ? "bg-emerald-500/70" : "bg-destructive/70",
                      testing ? "animate-pulse" : "",
                    )}
                  />
                  <span
                    className={cn(
                      "relative rounded-full border bg-background px-2 py-0.5 text-xs font-semibold tabular-nums shadow-sm",
                      testing ? "border-primary/20 text-primary" : ok ? "border-emerald-500/20 text-emerald-600 dark:text-emerald-400" : "border-destructive/20 text-destructive",
                    )}
                  >
                    {label || "通过"}
                  </span>
                </div>
                {renderMobileNode(segment.to, segment.toMeta)}
              </div>
            );
          })}
        </div>
      ) : null}

      <div className={cn("max-w-full overflow-x-auto pb-1", mobileStacked ? "hidden sm:block" : "")}>
        <div className={cn(shouldWrapDesktopRows ? "space-y-0" : "")}>
          {desktopRows.map((rowSegments, rowIndex) => {
            const nextRow = desktopRows[rowIndex + 1];
            return (
              <div key={`desktop-row-wrap-${rowIndex}`}>
                <div
                  className={cn(
                    "flex items-start px-2",
                    shouldWrapDesktopRows
                      ? "mx-auto w-max justify-center py-5"
                      : shouldStretchDesktopPath
                        ? "min-w-full justify-center py-8"
                      : compactPath
                        ? "w-max justify-start py-8"
                        : "min-w-full justify-center py-8",
                  )}
                >
                  {rowSegments.map((segment, index) => {
                    const firstNode = index === 0;
                    const { testing: segmentTesting, ok: segmentOk, label } = getSegmentState(segment);
                    return (
                      <div key={`${segment.from}-${segment.to}-${rowIndex}-${index}`} className="contents">
                        {firstNode ? (
                          renderNode(segment.from, segment.fromMeta)
                        ) : null}
                        <div className={cn(
                          "relative mt-[45px] h-px bg-border",
                          shouldWrapDesktopRows
                            ? "w-[42px] shrink-0 flex-none"
                            : shouldStretchDesktopPath
                              ? compactPath
                                ? "min-w-[32px] flex-1"
                                : "min-w-[40px] flex-1"
                              : densePath
                                ? "w-[42px] shrink-0 flex-none"
                                : compactPath
                                  ? "w-[56px] shrink-0 flex-none"
                                  : "min-w-[96px] flex-1",
                        )}>
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
                {shouldWrapDesktopRows && nextRow ? (
                  <div className="mx-auto -my-2 flex w-full max-w-[32rem] flex-col items-center px-6" aria-hidden="true">
                    <div className="h-4 w-px bg-border" />
                    <div className="flex w-full items-center">
                      <div className="h-px flex-1 bg-border" />
                      <span className="h-2.5 w-2.5 rounded-full border border-border bg-background shadow-sm" />
                      <div className="h-px flex-1 bg-border" />
                    </div>
                    <div className="h-4 w-px bg-border" />
                  </div>
                ) : null}
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
