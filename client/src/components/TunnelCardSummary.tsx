import type { ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ChevronRight } from "lucide-react";
import { t } from "@/i18n";
import { LatencyRating } from "./LatencyRating";
import { useOverlayContainer } from "./ui/overlay-root";
import { Badge } from "./ui/badge";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";

export type TunnelLatencyItem = {
  key: string;
  label: string;
  latencyMs: number | null;
  isTimeout: boolean;
};

function SummaryDetails({ label, trigger, children }: { label: string; trigger: ReactNode; children: ReactNode }) {
  const container = useOverlayContainer();
  return <Popover.Root>
    <Popover.Trigger asChild>{trigger}</Popover.Trigger>
    <Popover.Portal container={container}>
      <Popover.Content align="end" sideOffset={6} collisionPadding={12} aria-label={label}
        className="action-menu-content z-50 w-80 max-w-[calc(100vw-1.5rem)] max-h-[min(24rem,var(--radix-popover-content-available-height))] overflow-y-auto rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg">
        <p className="mb-2 text-xs font-medium">{label}</p>
        {children}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

/** Keep route and latency detail counts from changing the height of a card row. */
export function TunnelCardRoute({ summary, name, mode, children }: { summary: string; name: string; mode: string; children: ReactNode }) {
  return <Dialog>
    <DialogTrigger asChild>
    <button type="button" aria-label={t("链路详情")} className="flex h-10 w-full min-w-0 items-center gap-2 rounded-md bg-muted/25 px-2.5 text-left text-xs hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span className="min-w-0 flex-1 truncate">{summary}</span>
      <Badge variant="outline" className="shrink-0 text-[10px]">{mode}</Badge>
      <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
    </DialogTrigger>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t("链路详情")}</DialogTitle>
        <DialogDescription>{name} · {mode}</DialogDescription>
      </DialogHeader>
      {children}
    </DialogContent>
  </Dialog>;
}

export function TunnelCardLatency({ items }: { items: TunnelLatencyItem[] }) {
  const total = items.find(item => item.key === "total");
  const details = items.filter(item => item.key !== "total");
  const timeouts = details.filter(item => item.isTimeout).length;
  const summary = total ?? (details.length === 1 ? details[0] : undefined);
  const values = details.filter(item => !item.isTimeout && typeof item.latencyMs === "number" && Number.isFinite(item.latencyMs) && item.latencyMs >= 0).map(item => item.latencyMs as number);
  return <div data-tunnel-card-latency="" className="flex h-8 min-w-0 items-center justify-between gap-2 text-xs">
    <span className="shrink-0 text-muted-foreground">{t("延迟")}</span>
    <div className="flex min-w-0 items-center gap-2">
      {!summary && values.length > 0
        ? <span className="shrink-0 tabular-nums">{Math.min(...values)}{Math.min(...values) !== Math.max(...values) ? `–${Math.max(...values)}` : ""}ms</span>
        : <LatencyRating latencyMs={summary?.latencyMs} isTimeout={summary?.isTimeout || (!summary && details.length > 0 && timeouts === details.length)} emptyText={t("未测试")} timeoutText={t("超时")} icon="none" className="shrink-0" />}
      {details.length > 0 && <SummaryDetails label={t("延迟明细")} trigger={
        <button type="button" aria-label={t("延迟明细")} className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/50 px-1.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {timeouts > 0 && <span role="img" aria-label={t("{0} 项超时", [timeouts])} className="h-1.5 w-1.5 rounded-full bg-destructive" />}
          {t("{0} 条明细", [details.length])}
          <ChevronRight className="h-3 w-3" aria-hidden="true" />
        </button>
      }>
        <TunnelLatencyDetails items={items} />
      </SummaryDetails>}
    </div>
  </div>;
}

export function TunnelLatencyDetails({ items }: { items: TunnelLatencyItem[] }) {
  return <div className="space-y-2">{items.map(item => <div key={item.key} className="flex items-start justify-between gap-3 text-xs">
    <span className="min-w-0 break-words text-muted-foreground">{item.label}</span>
    <LatencyRating latencyMs={item.latencyMs} isTimeout={item.isTimeout} icon="none" timeoutText={t("超时")} className="shrink-0" />
  </div>)}</div>;
}
