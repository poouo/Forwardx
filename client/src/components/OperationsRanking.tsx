import { t } from "@/i18n";
import { operationsBytes as bytes } from "./OperationsChinaMap";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";

type RankingRow = { id: string | number; name?: string | null; bytesIn: number | string; bytesOut: number | string };

export default function OperationsRanking({ title, rows, ruleLabels = false }: { title: string; rows: RankingRow[]; ruleLabels?: boolean }) {
  const max = Math.max(1, ...rows.map(row => Number(row.bytesIn) + Number(row.bytesOut)));
  return <Card><CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader><CardContent className="space-y-4">
    {!rows.length && <p className="text-sm text-muted-foreground">{t("暂无数据")}</p>}
    {rows.slice(0, 10).map((row, index) => {
      const label = row.name?.trim() || (ruleLabels ? t("规则 #{0}", [row.id]) : `#${row.id}`);
      return <div key={row.id} className="space-y-1.5">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-muted-foreground">{index + 1}</span>
            <span className="truncate" title={ruleLabels ? `${label} · #${row.id}` : label}>{label}</span>
          </span>
          <span className="shrink-0 tabular-nums">{bytes(Number(row.bytesIn) + Number(row.bytesOut))}</span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary/65" style={{ width: `${100 * (Number(row.bytesIn) + Number(row.bytesOut)) / max}%` }} /></div>
      </div>;
    })}
  </CardContent></Card>;
}
