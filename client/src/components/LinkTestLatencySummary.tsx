import { LatencyRating } from "@/components/LatencyRating";

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
    const totalLatency = typeof parsed.totalLatencyMs === "number"
      ? parsed.totalLatencyMs
      : successfulLatencyDetails.length === visibleDetails.length
        ? successfulLatencyDetails.reduce((sum, detail) => sum + Number(detail.latencyMs || 0), 0)
        : null;

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
                  {detail.message ? <span className="font-normal">：{detail.message}</span> : null}
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
