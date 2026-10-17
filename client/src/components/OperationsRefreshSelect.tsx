import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/i18n";
import { OPERATIONS_REFRESH_SECONDS, type OperationsRefreshSeconds } from "@/lib/operationsRefresh";

export default function OperationsRefreshSelect({ seconds, onChange }: { seconds: OperationsRefreshSeconds; onChange: (value: string) => void }) {
  return <div className="flex items-center gap-2" title={t("仅在当前页面可见时自动刷新")}>
    <Label htmlFor="operations-refresh" className="shrink-0 text-sm text-muted-foreground">{t("自动刷新")}</Label>
    <Select value={String(seconds)} onValueChange={onChange}>
      <SelectTrigger id="operations-refresh" className="h-10 w-[110px]"><SelectValue>{seconds ? `${seconds}s` : t("不刷新")}</SelectValue></SelectTrigger>
      <SelectContent>{OPERATIONS_REFRESH_SECONDS.map(value => <SelectItem key={value} value={String(value)}>{value ? `${value}s` : t("不刷新")}</SelectItem>)}</SelectContent>
    </Select>
  </div>;
}
