import { useState } from "react";
import { t, getFormatLocale } from "@/i18n";
import OperationsDonutChart from "./OperationsDonutChart";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { buildOperationsFinanceCharts, type FinanceChartData } from "@/lib/operationsFinanceCharts";

export default function OperationsFinanceCharts({ data, formatMoney }: {
  data: FinanceChartData;
  formatMoney: (cents: number, currency?: string) => string;
}) {
  const [selectedCurrency, setSelectedCurrency] = useState("CNY");
  const model = buildOperationsFinanceCharts(data);
  const receipt = model.receipts.find(row => row.currency === selectedCurrency) || model.receipts[0];
  const currency = receipt?.currency || "CNY";
  const money = (value: number) => formatMoney(value, currency);
  const balance = (type: string, field: "creditCents" | "debitCents") => data.balances
    .filter(row => row.type === type).reduce((sum, row) => sum + row[field], 0);
  return <div className="grid gap-4 xl:grid-cols-3">
    <OperationsDonutChart title={t("支付构成")} items={receipt?.items || []} formatValue={money}
      action={model.receipts.length > 1 ? <Select value={currency} onValueChange={setSelectedCurrency}>
        <SelectTrigger className="h-7 w-24 text-xs" aria-label={t("支付币种")}><SelectValue /></SelectTrigger>
        <SelectContent>{model.receipts.map(row => <SelectItem key={row.currency} value={row.currency}>{row.currency}</SelectItem>)}</SelectContent>
      </Select> : <span className="rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">{currency}</span>}
      footer={<><p>{t("{0} 笔成功支付", [receipt?.count || 0])}</p><p>{t("仅成功支付，按币种分别统计")}</p></>} />
    <OperationsDonutChart title={t("余额消费构成")} items={model.consumption} formatValue={value => formatMoney(value)}
      footer={<div className="space-y-1.5 border-t border-border/50 pt-3">
        <p>{t("仅统计余额支出，不含充值和管理员调整。")}</p>
        <div className="flex flex-wrap justify-between gap-x-3"><span>{t("在线充值入账")}</span><span className="tabular-nums">{formatMoney(balance("payment", "creditCents"))}</span></div>
        <div className="flex flex-wrap justify-between gap-x-3"><span>{t("管理员修改")}</span><span className="tabular-nums">{formatMoney(balance("admin_adjust", "creditCents") - balance("admin_adjust", "debitCents"))}</span></div>
      </div>} />
    <OperationsDonutChart title={t("新建订单状态")} items={model.orders}
      formatValue={value => new Intl.NumberFormat(getFormatLocale()).format(value)}
      footer={<><p>{t("按所选日期内创建的订单统计当前状态。")}</p><p>{t("新增套餐记录按创建时间统计，不等同于购买或续费笔数。")}</p></>} />
  </div>;
}
