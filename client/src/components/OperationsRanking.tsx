import { t } from "@/i18n";
import { operationsBytes as bytes } from "./OperationsChinaMap";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { ArrowUpRight } from "lucide-react";

type RankingRow = { id: string | number; name?: string | null; bytesIn: number | string; bytesOut: number | string };

const PREVIEW_COUNT = 5;
const RANKING_COUNT = 10;

function RankingEntries({ rows, max, ruleLabels }: { rows: RankingRow[]; max: number; ruleLabels: boolean }) {
  return <ol className="space-y-3">
    {rows.map((row, index) => {
      const label = row.name?.trim() || (ruleLabels ? t("规则 #{0}", [row.id]) : `#${row.id}`);
      return <li key={row.id} className="min-w-0 space-y-1.5">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-muted-foreground">{index + 1}</span>
            <span className="truncate" title={ruleLabels ? `${label} · #${row.id}` : label}>{label}</span>
          </span>
          <span className="shrink-0 tabular-nums">{bytes(Number(row.bytesIn) + Number(row.bytesOut))}</span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary/65" style={{ width: `${100 * (Number(row.bytesIn) + Number(row.bytesOut)) / max}%` }} /></div>
      </li>;
    })}
  </ol>;
}

export default function OperationsRanking({ title, rows, ruleLabels = false }: { title: string; rows: RankingRow[]; ruleLabels?: boolean }) {
  const rankedRows = rows.slice(0, RANKING_COUNT);
  const max = Math.max(1, ...rankedRows.map(row => Number(row.bytesIn) + Number(row.bytesOut)));
  return <Dialog>
    <Card className="min-w-0 self-start">
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 pb-4">
        <CardTitle className="min-w-0 text-base">{title}</CardTitle>
        {rankedRows.length > PREVIEW_COUNT && <DialogTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground" aria-label={`${title} · ${t("更多")}`}>
            {t("更多")}<ArrowUpRight className="size-3.5" />
          </Button>
        </DialogTrigger>}
      </CardHeader>
      <CardContent>
        {!rankedRows.length ? <p className="text-sm text-muted-foreground">{t("暂无数据")}</p>
          : <RankingEntries rows={rankedRows.slice(0, PREVIEW_COUNT)} max={max} ruleLabels={ruleLabels} />}
      </CardContent>
    </Card>
    <DialogContent className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{t("按所选时间范围内的流量排序，展示前 {0} 项。", [rankedRows.length])}</DialogDescription>
      </DialogHeader>
      <RankingEntries rows={rankedRows} max={max} ruleLabels={ruleLabels} />
    </DialogContent>
  </Dialog>;
}
