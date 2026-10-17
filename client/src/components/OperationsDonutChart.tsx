import type { ReactNode } from "react";
import { t, getFormatLocale } from "@/i18n";
import { positiveChartValue, type FinanceChartItem } from "@/lib/operationsFinanceCharts";

export default function OperationsDonutChart({ title, items, formatValue, action, footer }: {
  title: string;
  items: FinanceChartItem[];
  formatValue: (value: number) => string;
  action?: ReactNode;
  footer?: ReactNode;
}) {
  const values = items.map(item => ({ ...item, value: positiveChartValue(item.value) }));
  const total = values.reduce((sum, item) => sum + item.value, 0);
  const percentFormat = new Intl.NumberFormat(getFormatLocale(), {
    style: "percent", maximumFractionDigits: 1,
  });
  const percent = (value: number) => percentFormat.format(total ? value / total : 0);
  let offset = 0;
  return <section className="pearl-hover-card flex min-w-0 flex-col rounded-xl border border-border/60 bg-muted/10 p-4">
    <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-medium">{title}</h3>{action}
    </div>
    <div className="flex items-center gap-3 py-4 xl:flex-col 2xl:flex-row">
      <div className="relative h-28 w-28 shrink-0 sm:h-36 sm:w-36 xl:h-40 xl:w-40 2xl:h-32 2xl:w-32">
        {/* Static SVG avoids chart observers, animation and refresh-time remounts. */}
        <svg viewBox="0 0 128 128" className="h-full w-full" aria-hidden="true" focusable="false">
          <circle cx="64" cy="64" r="52" fill="none" stroke="var(--muted)" strokeWidth="13" />
          {values.filter(item => item.value > 0).map(item => {
            const share = item.value / total * 100;
            const start = offset;
            offset += share;
            return <circle key={item.id} cx="64" cy="64" r="52" fill="none" stroke={item.color} strokeWidth="13"
              pathLength="100" strokeDasharray={`${share} ${100 - share}`} strokeDashoffset={-start} transform="rotate(-90 64 64)" />;
          })}
        </svg>
        <div className="absolute inset-[22%] flex min-w-0 flex-col items-center justify-center gap-1 text-center">
          <span className="text-[11px] text-muted-foreground">{total > 0 ? t("合计") : t("暂无数据")}</span>
          <span className="w-full break-words text-sm font-semibold tabular-nums [overflow-wrap:anywhere]">{formatValue(total)}</span>
        </div>
      </div>
      <ul className="w-full min-w-0 flex-1 space-y-2.5 text-xs" aria-label={title}>
        {values.map(item => <li key={item.id} className="flex min-w-0 items-start gap-2">
          <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: item.color }} aria-hidden="true" />
          <span className="min-w-0 flex-1 break-words text-muted-foreground">{t(item.label)}</span>
          <span className="min-w-0 text-right tabular-nums">
            <span className="block break-words [overflow-wrap:anywhere]">{formatValue(item.value)}</span>
            <span className="block text-[11px] text-muted-foreground">{percent(item.value)}</span>
          </span>
        </li>)}
      </ul>
    </div>
    {footer && <div className="mt-auto pt-4 text-[11px] leading-relaxed text-muted-foreground">{footer}</div>}
  </section>;
}
