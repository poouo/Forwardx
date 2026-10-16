import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import DatePickerInput from "@/components/DatePickerInput";
import { Label } from "@/components/ui/label";
import type { ReactNode } from "react";

export default function OperationsDateFilter({ from, to, minimum, today, onFromChange, onToChange, onApply, onToday, onMonth, children }: {
  from: string; to: string; minimum: string; today: string;
  onFromChange: (value: string) => void; onToChange: (value: string) => void;
  onApply: () => void; onToday: () => void; onMonth: () => void;
  children?: ReactNode;
}) {
  return <div className="grid grid-cols-1 items-end gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:flex lg:flex-wrap">
    <div className="min-w-0 space-y-2 lg:w-48">
      <Label htmlFor="operations-from" className="block leading-5">{t("开始日期")}</Label>
      <DatePickerInput id="operations-from" min={minimum} max={to} value={from} onChange={onFromChange} allowClear={false} />
    </div>
    <div className="min-w-0 space-y-2 lg:w-48">
      <Label htmlFor="operations-to" className="block leading-5">{t("结束日期")}</Label>
      <DatePickerInput id="operations-to" min={from} max={today} value={to} onChange={onToChange} allowClear={false} />
    </div>
    {children}
    <div className="flex min-w-0 flex-wrap items-center gap-2 sm:col-span-2">
      <Button onClick={onApply}>{t("查询")}</Button>
      <Button variant="outline" onClick={onToday}>{t("当天")}</Button>
      <Button variant="ghost" onClick={onMonth}>{t("最近 30 天")}</Button>
    </div>
  </div>;
}
