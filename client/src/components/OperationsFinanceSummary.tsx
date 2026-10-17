import { useEffect, useState } from "react";
import { Link } from "wouter";
import { t, getFormatLocale } from "@/i18n";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { operationsRefreshOptions } from "@/lib/operationsRefresh";
import OperationsFinanceCharts from "./OperationsFinanceCharts";
import { SummaryMetricCard } from "./SummaryMetricCard";
import { CreditCard, Wallet, Gift, PackagePlus } from "lucide-react";

export function operationsMoney(cents: number, currency = "CNY") {
  try { return new Intl.NumberFormat(getFormatLocale(),{style:"currency",currency}).format(cents/100); }
  catch { return `${(cents/100).toFixed(2)} ${currency}`; }
}
const balanceLabels:Record<string,string> = {payment:"在线充值入账",purchase:"余额购买套餐",traffic_addon_purchase:"购买附加流量",traffic_billing:"流量计费",admin_recharge:"管理员充值",admin_adjust:"管理员修改",redeem:"兑换入账",affiliate_transfer:"推广佣金"};
const statusLabels:Record<string,string> = {pending:"待支付",paid:"已支付",completed:"已完成",expired:"已过期",cancelled:"已取消",failed:"失败",processing:"处理中"};
export function operationsLedgerLabel(kind:string,type:string) {
  return kind === "payment" ? t(type === "plan" ? "在线套餐支付" : "在线充值订单") : t(balanceLabels[type] || "其他余额变动");
}
export default function OperationsFinanceSummary({from,to,userId,refreshInterval}: {from:string;to:string;userId:"self"|"all"|number;refreshInterval:number|false}) {
  const [page,setPage] = useState(0);
  useEffect(()=>setPage(0),[from,to,userId]);
  const options = operationsRefreshOptions(refreshInterval);
  const summary = trpc.operations.finance.useQuery({from,to,userId},options);
  const ledger = trpc.operations.financeLedger.useQuery({from,to,userId,page},options);
  const data = summary.data;
  const receiptTotals = new Map<string,{cents:number;count:number;plans:number;topups:number}>();
  for (const row of data?.receipts || []) {
    const item = receiptTotals.get(row.currency) || {cents:0,count:0,plans:0,topups:0};
    item.cents += row.amountCents; item.count += row.count;
    if(row.orderType === "plan") item.plans += row.amountCents; else item.topups += row.amountCents;
    receiptTotals.set(row.currency,item);
  }
  const sum = (types:string[],field:"creditCents"|"debitCents") => (data?.balances || []).filter(row=>types.includes(row.type)).reduce((total,row)=>total+row[field],0);
  const consumption = sum(["purchase","traffic_addon_purchase","traffic_billing"],"debitCents");
  const credits = sum(["admin_recharge","redeem"],"creditCents");
  const newSubscriptions = (data?.subscriptions || []).reduce((total,row)=>total+row.count,0);
  const cards = [
    {title:t("在线实收"),value:summary.isLoading ? "—" : [...receiptTotals].map(([currency,row])=>operationsMoney(row.cents,currency)).join(" · ") || operationsMoney(0),hint:t("仅成功支付，按币种分别统计"),icon:CreditCard,tone:"emerald" as const},
    {title:t("余额消费"),value:summary.isLoading ? "—" : operationsMoney(consumption),hint:t("套餐、附加流量与流量计费"),icon:Wallet,tone:"sky" as const},
    {title:t("管理员 / 兑换入账"),value:summary.isLoading ? "—" : operationsMoney(credits),hint:t("不计入在线实收"),icon:Gift,tone:"amber" as const},
    {title:t("新增套餐记录"),value:summary.isLoading ? "—" : String(newSubscriptions),hint:t("当前生效 {0} 个",[data?.activeSubscriptions || 0]),icon:PackagePlus,tone:"violet" as const},
  ];
  const currentPage = ledger.data?.page ?? page, pages = Math.max(1,Math.ceil((ledger.data?.total || 0)/10));
  return <Card>
    <CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle className="text-base">{t("账务汇总")}</CardTitle><Link href="/billing" className="text-xs text-primary hover:underline">{t("查看完整账单")}</Link></div>
      <p className="text-xs leading-relaxed text-muted-foreground">{t("在线实收与余额消费分别统计，不相加；测试订单不计入。当前生效套餐为实时状态。")}</p>
    </CardHeader>
    <CardContent className="space-y-5">
      {(summary.error || ledger.error) && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 p-3 text-sm text-destructive"><span>{t("账务数据加载失败，请重试。")}</span><Button variant="outline" onClick={()=>{void summary.refetch();void ledger.refetch();}}>{t("重试")}</Button></div>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{cards.map(card=><SummaryMetricCard key={card.title} {...card} compact value={summary.isError ? "—" : card.value} />)}</div>
      {data && <OperationsFinanceCharts data={data} formatMoney={operationsMoney} />}
      <div className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">{t("支付与余额流水")}</h3><p className="text-[11px] text-muted-foreground">{t("原始流水分别列出，请勿直接相加")}</p></div>
        <div className="max-h-96 overflow-auto rounded-lg border"><table className="w-full min-w-[620px] text-xs"><thead className="sticky top-0 bg-card"><tr>{[t("时间"),t("用户"),t("类型"),t("状态"),t("金额")].map(label=><th key={label} className="px-3 py-2.5 text-left font-medium last:text-right">{label}</th>)}</tr></thead><tbody>
          {ledger.isLoading ? <tr><td colSpan={5} className="p-5 text-center text-muted-foreground">{t("加载中")}</td></tr> : ledger.data?.rows.length ? ledger.data.rows.map(row=><tr key={`${row.kind}:${row.id}`} className="border-t"><td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{new Date(row.eventAt*1000).toLocaleString(getFormatLocale(),{timeZone:"Asia/Shanghai"})}</td><td className="max-w-40 truncate px-3 py-2.5" title={row.username || `#${row.userId}`}>{row.username || `#${row.userId}`}</td><td className="px-3 py-2.5" title={row.title || undefined}>{operationsLedgerLabel(row.kind,row.type)}</td><td className="whitespace-nowrap px-3 py-2.5">{t(statusLabels[row.status] || "未知")}</td><td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{row.kind === "balance" && row.amountCents>0 ? "+" : ""}{operationsMoney(row.amountCents,row.currency)}</td></tr>) : <tr><td colSpan={5} className="p-5 text-center text-muted-foreground">{ledger.isError ? "—" : t("暂无数据")}</td></tr>}
        </tbody></table></div>
        <div className="flex items-center justify-between gap-3 text-xs"><span className="text-muted-foreground">{t("第 {0} 页，共 {1} 页",[currentPage+1,pages])}</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={ledger.isFetching || currentPage===0} onClick={()=>setPage(currentPage-1)}>{t("上一页")}</Button><Button size="sm" variant="outline" disabled={ledger.isFetching || currentPage+1>=pages} onClick={()=>setPage(currentPage+1)}>{t("下一页")}</Button></div></div>
      </div>
    </CardContent>
  </Card>;
}
