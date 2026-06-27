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
  groupKey?: string | null;
  groupLabel?: string | null;
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
  groupKey?: string | null;
  groupLabel?: string | null;
  latencyLabel?: string | null;
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
  groupKey?: string | null;
  groupLabel?: string | null;
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
          groupKey: typeof item?.groupKey === "string" ? item.groupKey : null,
          groupLabel: typeof item?.groupLabel === "string" ? item.groupLabel : null,
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

function normalizeEndpointLabel(value: string) {
  return cleanNodeLabel(value).replace(/\s+/g, " ").trim().toLowerCase();
}

function endpointMatchKeys(label: string, meta?: LinkTestNodeMeta) {
  const values = [
    label,
    cleanNodeLabel(label),
    meta?.label,
    ...(String(meta?.address || "").split(/\s*\/\s*/)),
  ];
  const keys = new Set<string>();
  values.forEach((value) => {
    const text = String(value || "").trim();
    if (!text) return;
    [
      text,
      text.replace(/^目标\s+/i, "").trim(),
      text.replace(/^\[/, "").replace(/\]$/, "").trim(),
    ].forEach((candidate) => {
      const key = normalizeEndpointLabel(candidate);
      if (key) keys.add(key);
    });
  });
  return keys;
}

function endpointLabelsMatch(leftLabel: string, leftMeta: LinkTestNodeMeta | undefined, rightLabel: string, rightMeta: LinkTestNodeMeta | undefined) {
  const leftKeys = endpointMatchKeys(leftLabel, leftMeta);
  const rightKeys = endpointMatchKeys(rightLabel, rightMeta);
  if (leftKeys.size === 0 || rightKeys.size === 0) return false;
  const leftLabelKey = normalizeEndpointLabel(leftMeta?.label || leftLabel);
  const rightLabelKey = normalizeEndpointLabel(rightMeta?.label || rightLabel);
  if (leftLabelKey && rightLabelKey && leftLabelKey === rightLabelKey) return true;
  return Array.from(leftKeys).some((key) => rightKeys.has(key));
}

function isSelfLoopEndpoint(from: string, to: string) {
  const fromKey = normalizeEndpointLabel(from);
  const toKey = normalizeEndpointLabel(to);
  return !!fromKey && fromKey === toKey;
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
  const hopMatch = hopLabel.match(/(?:(?:入口|出口)\s*)?(?:\d+\s*\/\s*\d+\s*)?(.+?)\s*->\s*(.+)$/);
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
  const cleanLower = clean.toLowerCase();
  const targetAlias = clean.replace(/^目标\s+/i, "").trim();
  const targetAliasLower = targetAlias.toLowerCase();
  return meta[label] || meta[clean] || meta[cleanLower] || meta[targetAlias] || meta[targetAliasLower];
}

function withNodeLabel(meta: LinkTestNodeMeta | undefined, fallback: string) {
  const label = String(meta?.label || "").trim();
  return label || fallback;
}
function uniqueLabels(values: string[]) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function getMultiSourceAdjustedDetailsTotalLatency(details: LinkTestDetail[]) {
  const visibleDetails = (details || []).filter((detail) => detail.pending || detail.success || detail.message || hasLatencyValue(detail));
  if (visibleDetails.length < 2) return null;
  const firstTarget = parseRouteEndpoints(visibleDetails[0], 0).to;
  if (!firstTarget) return null;
  const initialDetails: LinkTestDetail[] = [];
  for (let index = 0; index < visibleDetails.length; index += 1) {
    const detail = visibleDetails[index];
    const endpoints = parseRouteEndpoints(detail, index);
    if (endpoints.to !== firstTarget || detail.groupKey || isSelfLoopEndpoint(endpoints.from, endpoints.to)) break;
    initialDetails.push(detail);
  }
  const uniqueSources = uniqueLabels(initialDetails.map((detail, index) => parseRouteEndpoints(detail, index).from));
  if (initialDetails.length < 2 || uniqueSources.length < 2) return null;
  const latencies = visibleDetails.map((detail) => detail.success && hasLatencyValue(detail) ? Number(detail.latencyMs) : null);
  if (latencies.some((value) => value === null)) return null;
  const numericLatencies = latencies.map((value) => Number(value));
  const initialLatency = Math.max(...numericLatencies.slice(0, initialDetails.length));
  const restLatency = numericLatencies.slice(initialDetails.length).reduce((sum, value) => sum + value, 0);
  return initialLatency + restLatency;
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
      groupKey: segment.groupKey || null,
      groupLabel: segment.groupLabel || null,
    }))
    .filter((segment) => segment.from && segment.to && !isSelfLoopEndpoint(segment.from, segment.to));

  const hasGroupedPlannedSegments = plannedSegments.some((segment) => !!segment.groupKey);
  const usePlannedSegments = plannedSegments.length > 0
    && (
      hasGroupedPlannedSegments
      || visibleDetails.length === 0
      || visibleDetails.length <= plannedSegments.length
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
        groupKey: detail.groupKey || null,
        groupLabel: detail.groupLabel || null,
      };
    });
  }

  if (plannedSegments.length > 0) {
    const detailRecords = visibleDetails.map((detail, index) => {
      const endpoints = parseRouteEndpoints(detail, index);
      return {
        detail,
        index,
        endpoints,
        fromMeta: lookupNodeMeta(input.nodeMeta, endpoints.from),
        toMeta: lookupNodeMeta(input.nodeMeta, endpoints.to),
      };
    });
    const usedDetailIndexes = new Set<number>();
    const isGroupCompatible = (segment: (typeof plannedSegments)[number], record: (typeof detailRecords)[number]) => (
      !segment.groupKey || !record.detail.groupKey || record.detail.groupKey === segment.groupKey
    );
    const findDetailRecordForSegment = (
      segment: (typeof plannedSegments)[number],
      index: number,
      fromMeta: LinkTestNodeMeta | undefined,
      toMeta: LinkTestNodeMeta | undefined,
    ) => {
      const exactRecord = detailRecords.find((record) => (
        !usedDetailIndexes.has(record.index)
        && isGroupCompatible(segment, record)
        && endpointLabelsMatch(segment.from, fromMeta, record.endpoints.from, record.fromMeta)
        && endpointLabelsMatch(segment.to, toMeta, record.endpoints.to, record.toMeta)
      ));
      if (exactRecord) return exactRecord;

      if (visibleDetails.length === plannedSegments.length) {
        const indexedRecord = detailRecords[index];
        if (indexedRecord && !usedDetailIndexes.has(indexedRecord.index) && isGroupCompatible(segment, indexedRecord)) return indexedRecord;
      }

      if (plannedSegments.length === 1) {
        const onlyRecord = detailRecords.find((record) => !usedDetailIndexes.has(record.index) && isGroupCompatible(segment, record));
        if (onlyRecord) return onlyRecord;
      }

      if (index === plannedSegments.length - 1) {
        for (let detailIndex = detailRecords.length - 1; detailIndex >= 0; detailIndex -= 1) {
          const tailRecord = detailRecords[detailIndex];
          if (tailRecord && !usedDetailIndexes.has(tailRecord.index) && isGroupCompatible(segment, tailRecord)) return tailRecord;
        }
      }

      return null;
    };

    return plannedSegments.map((segment, index): ProbeSegment => {
      const fromMeta = segment.fromMeta || lookupNodeMeta(input.nodeMeta, segment.from);
      const toMeta = segment.toMeta || lookupNodeMeta(input.nodeMeta, segment.to);
      const detailRecord = findDetailRecordForSegment(segment, index, fromMeta, toMeta);
      if (detailRecord) usedDetailIndexes.add(detailRecord.index);
      const detail = detailRecord?.detail || null;
      const detailSuccess = detail && typeof detail.success === "boolean" ? !!detail.success : undefined;
      const detailLatency = detail?.success && hasLatencyValue(detail) ? detail.latencyMs : null;
      const detailMessage = detail?.message || null;
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
        groupKey: segment.groupKey || null,
        groupLabel: segment.groupLabel || null,
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
    groupKey: null,
    groupLabel: null,
  }];
}

function getInitialConvergedEntryView(segments: ProbeSegment[]) {
  if (segments.length < 2) return null;
  const firstTarget = segments[0]?.to;
  if (!firstTarget) return null;
  const entrySegments: ProbeSegment[] = [];
  for (const segment of segments) {
    if (segment.groupKey || segment.to !== firstTarget || isSelfLoopEndpoint(segment.from, segment.to)) break;
    entrySegments.push(segment);
  }
  const uniqueSources = uniqueLabels(entrySegments.map((segment) => segment.from));
  if (entrySegments.length < 2 || uniqueSources.length < 2) return null;
  return {
    entrySegments,
    restSegments: segments.slice(entrySegments.length),
    convergenceLabel: firstTarget,
    convergenceMeta: entrySegments[0]?.toMeta,
  };
}

export function getLinkTestTotalLatency(input: {
  parsed: ParsedLinkTestMessage;
  fallbackLatencyMs?: number | null;
  isSuccess: boolean;
}) {
  const adjustedMultiSourceTotal = getMultiSourceAdjustedDetailsTotalLatency(input.parsed.details || []);
  if (hasUsableLatencyValue(adjustedMultiSourceTotal)) return Number(adjustedMultiSourceTotal);
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
  const branchKey = segments.length > 1 ? segments[0]?.groupKey || null : null;
  const branchSegments = branchKey && segments.every((segment) => segment.groupKey === branchKey) ? segments : [];
  const branchLabel = branchSegments[0]?.groupLabel || "同级出口";
  const isBranchView = branchSegments.length > 1;
  const convergedEntryView = !isBranchView ? getInitialConvergedEntryView(segments) : null;
  const isConvergedEntryView = !!convergedEntryView;
  const branchLatencyValues = branchSegments
    .filter((segment) => segment.success && hasUsableLatencyValue(segment.latencyMs))
    .map((segment) => Number(segment.latencyMs));
  const branchTotalLatency = isBranchView && !effectiveTesting && branchLatencyValues.length === branchSegments.length
    ? Math.max(...branchLatencyValues)
    : null;
  const totalLatency = effectiveTesting ? null : branchTotalLatency ?? getLinkTestTotalLatency({ parsed, fallbackLatencyMs, isSuccess });
  const hasSegments = segments.length > 0;
  const hasResult = effectiveTesting || segments.some((segment) => segment.success || segment.message || hasUsableLatencyValue(segment.latencyMs));
  const compactPath = segments.length >= compactFrom;
  const densePath = segments.length >= 6;
  const shouldWrapDesktopRows = wrapDesktopRows && segments.length >= 4 && !isBranchView;
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
        : segment.latencyLabel
          ? segment.latencyLabel
          : ok && hasUsableLatencyValue(segment.latencyMs)
            ? formatLatencyMs(segment.latencyMs)
            : ok
              ? "--"
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
  const renderNode = (label: string, segmentMeta?: LinkTestNodeMeta, options?: { wide?: boolean }) => {
    const meta = segmentMeta || lookupNodeMeta(nodeMeta, label);
    const region = String(meta?.region || "").trim();
    const address = String(meta?.address || "").trim();
    const preferWideNode = options?.wide === true;
    const nodeWidthClass = preferWideNode
      ? roomyNodes ? "max-w-[228px]" : "max-w-[208px]"
      : shouldStretchDesktopPath
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
    const labelMaxLength = preferWideNode
      ? roomyNodes ? 28 : 24
      : shouldStretchDesktopPath
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
  const renderBranchLine = (segment: ProbeSegment, index: number, mobile = false) => {
    const { testing, ok, label } = getSegmentState(segment);
    return (
      <div key={`${mobile ? "mobile" : "desktop"}-branch-${segment.from}-${segment.to}-${index}`} className={cn(mobile ? "space-y-2" : "flex min-w-[22rem] items-start justify-center px-2 py-3")}>
        {mobile ? renderMobileNode(segment.from, segment.fromMeta) : renderNode(segment.from, segment.fromMeta)}
        <div className={cn(
          mobile ? "relative mx-auto flex h-10 max-w-[18rem] items-center justify-center" : "relative mt-[45px] h-px min-w-[80px] flex-1 bg-border",
        )}>
          <div
            className={cn(
              mobile ? "absolute bottom-1 top-1 w-px" : "absolute inset-x-0 top-0 h-px",
              testing ? "bg-primary/70" : ok ? "bg-emerald-500/70" : "bg-destructive/70",
              testing ? "animate-pulse" : "",
            )}
          />
          <span
            className={cn(
              mobile
                ? "relative max-w-[16rem] whitespace-normal rounded-full border bg-background px-2 py-0.5 text-center text-xs font-semibold leading-tight tabular-nums shadow-sm"
                : "absolute left-1/2 top-[-2.05rem] max-w-[18rem] -translate-x-1/2 whitespace-normal text-center text-xs font-semibold leading-tight tabular-nums",
              testing ? "text-primary" : ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
              mobile && (testing ? "border-primary/20" : ok ? "border-emerald-500/20" : "border-destructive/20"),
            )}
          >
            {label || (ok ? "--" : "失败")}
          </span>
        </div>
        {mobile ? renderMobileNode(segment.to, segment.toMeta) : renderNode(segment.to, segment.toMeta)}
      </div>
    );
  };

  const renderDesktopConnector = (segment: ProbeSegment, key: string, widthClass = "min-w-[88px] flex-1", showLabel = true) => {
    const { testing, ok, label } = getSegmentState(segment);
    return (
      <div key={key} className={cn("relative mt-[45px] h-px bg-border", widthClass)}>
        <div
          className={cn(
            "absolute inset-x-0 top-0 h-px",
            testing ? "bg-primary/70" : ok ? "bg-emerald-500/70" : "bg-destructive/70",
            testing ? "animate-pulse" : "",
          )}
        />
        {showLabel ? (
          <span
            className={cn(
              "absolute left-1/2 top-[-2rem] max-w-[8rem] -translate-x-1/2 truncate rounded-full border bg-background px-2 py-0.5 text-center text-xs font-semibold leading-tight tabular-nums shadow-sm",
              testing ? "border-primary/20 text-primary" : ok ? "border-emerald-500/20 text-emerald-600 dark:text-emerald-400" : "border-destructive/20 text-destructive",
            )}
            title={label || undefined}
          >
            {label || "\u00a0"}
          </span>
        ) : null}
      </div>
    );
  };

  const renderMobileConnector = (segment: ProbeSegment, key: string, showLabel = true) => {
    const { testing, ok, label } = getSegmentState(segment);
    return (
      <div key={key} className="relative mx-auto flex h-12 max-w-[18rem] items-center justify-center">
        <div
          className={cn(
            "absolute bottom-1 top-1 w-px",
            testing ? "bg-primary/70" : ok ? "bg-emerald-500/70" : "bg-destructive/70",
            testing ? "animate-pulse" : "",
          )}
        />
        {showLabel ? (
          <span
            className={cn(
              "relative max-w-[16rem] whitespace-normal rounded-full border bg-background px-2 py-0.5 text-center text-xs font-semibold leading-tight tabular-nums shadow-sm",
              testing ? "border-primary/20 text-primary" : ok ? "border-emerald-500/20 text-emerald-600 dark:text-emerald-400" : "border-destructive/20 text-destructive",
            )}
          >
            {label || (ok ? "--" : "失败")}
          </span>
        ) : null}
      </div>
    );
  };

  const renderMobileLinearSegments = (linearSegments: ProbeSegment[], keyPrefix: string, showFirstNode = true) => (
    <div className="space-y-0">
      {linearSegments.map((segment, index) => {
        const firstNode = showFirstNode && index === 0;
        return (
          <div key={`${keyPrefix}-${segment.from}-${segment.to}-${index}`}>
            {firstNode ? renderMobileNode(segment.from, segment.fromMeta) : null}
            {renderMobileConnector(segment, `${keyPrefix}-line-${index}`)}
            {renderMobileNode(segment.to, segment.toMeta)}
          </div>
        );
      })}
    </div>
  );

  const renderEntryGroupNode = (entrySegments: ProbeSegment[], mobile = false) => (
    <div
      className={cn(
        "relative z-10 rounded-md border border-border/70 bg-background text-sm font-medium shadow-sm",
        mobile ? "mx-auto w-full max-w-[18rem] px-3 py-2" : "mt-[9px] h-[72px] min-w-[188px] max-w-[248px] px-3 py-2",
      )}
      title={entrySegments.map((segment) => segment.from).join(" / ")}
    >
      <div className="max-h-[9.5rem] space-y-1 overflow-y-auto pr-1">
        {entrySegments.map((segment, index) => {
          const { testing, ok, label } = getSegmentState(segment);
          const entryLabel = shortNodeLabel(segment.from, mobile ? 18 : 18);
          return (
            <div
              key={`entry-group-${segment.from}-${segment.to}-${index}`}
              className={cn(
                "flex min-w-0 items-center justify-between gap-2 rounded-sm px-1 py-0.5 leading-tight",
                testing ? "text-primary" : ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
              )}
              title={segment.message || segment.from}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="flex h-3.5 w-5 shrink-0 items-center justify-center">{renderFlag(segment.fromMeta)}</span>
                <span className="min-w-0 truncate">{entryLabel}</span>
              </span>
              <span className="shrink-0 text-xs font-semibold tabular-nums">{label || (ok ? "--" : "失败")}</span>
            </div>
          );
        })}
      </div>
    </div>
  );

  const renderConvergedEntryView = (mobile = false) => {
    if (!convergedEntryView) return null;
    const { entrySegments, restSegments, convergenceLabel, convergenceMeta } = convergedEntryView;
    const entryStates = entrySegments.map((segment) => getSegmentState(segment));
    const anyEntryTesting = entryStates.some((state) => state.testing);
    const anyEntryOk = entryStates.some((state) => state.ok);
    const entryConnectorSegment: ProbeSegment = {
      ...entrySegments[0],
      from: "入口组",
      to: convergenceLabel,
      toMeta: convergenceMeta,
      success: anyEntryOk,
      latencyMs: null,
      message: null,
      method: null,
      pending: anyEntryTesting,
      groupKey: null,
      groupLabel: null,
      latencyLabel: null,
    };

    if (mobile) {
      return (
        <div className="space-y-0 py-2 sm:hidden">
          {renderEntryGroupNode(entrySegments, true)}
          {renderMobileConnector(entryConnectorSegment, "mobile-entry-group-line", false)}
          {renderMobileNode(convergenceLabel, convergenceMeta)}
          {restSegments.length > 0 ? renderMobileLinearSegments(restSegments, "mobile-converged-rest", false) : null}
        </div>
      );
    }
    return (
      <div className={cn("min-w-0 max-w-full overflow-x-auto overscroll-x-contain pb-1", mobileStacked ? "hidden sm:block" : "")}>
        <div className="mx-auto flex min-w-full w-max items-start justify-center px-2 py-7">
          {renderEntryGroupNode(entrySegments)}
          {renderDesktopConnector(entryConnectorSegment, "entry-group-line", "w-[96px] shrink-0 flex-none", false)}
          {renderNode(convergenceLabel, convergenceMeta, { wide: true })}
          {restSegments.length > 0 ? (
            <div className="flex items-start">
              {restSegments.map((segment, index) => (
                <div key={`rest-${segment.from}-${segment.to}-${index}`} className="contents">
                  {renderDesktopConnector(segment, `rest-line-${index}`, index === 0 ? "w-[96px] shrink-0 flex-none" : "min-w-[88px] flex-1")}
                  {renderNode(segment.to, segment.toMeta, { wide: true })}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    );
  };
  return (
    <div className={cn("min-w-0 space-y-3", className)}>
      {mobileStacked ? (
        isConvergedEntryView ? (
          renderConvergedEntryView(true)
        ) : isBranchView ? (
          <div className="space-y-3 py-2 sm:hidden">
            <div className="text-center text-xs font-medium text-muted-foreground">{branchLabel}</div>
            {branchSegments.map((segment, index) => renderBranchLine(segment, index, true))}
          </div>
        ) : (
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
                        "relative max-w-[16rem] whitespace-normal rounded-full border bg-background px-2 py-0.5 text-center text-xs font-semibold leading-tight tabular-nums shadow-sm",
                        testing ? "border-primary/20 text-primary" : ok ? "border-emerald-500/20 text-emerald-600 dark:text-emerald-400" : "border-destructive/20 text-destructive",
                      )}
                    >
                      {label || (ok ? "--" : "失败")}
                    </span>
                  </div>
                  {renderMobileNode(segment.to, segment.toMeta)}
                </div>
              );
            })}
          </div>
        )
      ) : null}

      {isConvergedEntryView ? (
        renderConvergedEntryView(false)
      ) : isBranchView ? (
        <div className={cn("min-w-0 max-w-full overflow-x-auto overscroll-x-contain pb-1", mobileStacked ? "hidden sm:block" : "")}>
          <div className="mx-auto w-full max-w-[36rem] py-3">
            <div className="mb-1 text-center text-xs font-medium text-muted-foreground">{branchLabel}</div>
            <div className="space-y-0">
              {branchSegments.map((segment, index) => renderBranchLine(segment, index))}
            </div>
          </div>
        </div>
      ) : (
        <div className={cn("min-w-0 max-w-full overflow-x-auto overscroll-x-contain pb-1", mobileStacked ? "hidden sm:block" : "")}>
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
                                "absolute left-1/2 top-[-2.05rem] max-w-[18rem] -translate-x-1/2 whitespace-normal text-center text-xs font-semibold leading-tight tabular-nums",
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
      )}

      {!hasSegments && !hasResult ? (
        <div className="rounded-md border border-dashed border-border/70 px-3 py-4 text-center text-sm text-muted-foreground">
          尚未运行探测
        </div>
      ) : null}

      <div className="flex items-center justify-between border-t border-border/70 pt-3 text-sm">
        <span className="text-muted-foreground">{isBranchView ? "最大延迟" : "合计"}</span>
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
    const totalLabel = parsed.kind === "tunnel-load-balance-summary" ? "最大延迟" : "总延迟";

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
            <span>{totalLabel}</span>
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
