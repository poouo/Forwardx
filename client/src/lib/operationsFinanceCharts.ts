export type FinanceChartItem = { id: string; label: string; value: number; color: string };
export type FinanceChartData = {
  receipts: { currency: string; orderType: string; amountCents: number; count: number }[];
  balances: { type: string; creditCents: number; debitCents: number }[];
  orders: { status: string; count: number }[];
};

export function positiveChartValue(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

const orderStyles: Record<string, { label: string; color: string }> = {
  completed: { label: "已完成", color: "#10b981" },
  paid: { label: "已支付", color: "#14b8a6" },
  processing: { label: "处理中", color: "#3b82f6" },
  pending: { label: "待支付", color: "#f59e0b" },
  failed: { label: "失败", color: "#ef4444" },
  expired: { label: "已过期", color: "#94a3b8" },
  cancelled: { label: "已取消", color: "#a78bfa" },
};

export function buildOperationsFinanceCharts(data: FinanceChartData) {
  const currencies = new Map<string, { currency: string; count: number; items: FinanceChartItem[] }>();
  for (const row of data.receipts) {
    if (row.orderType !== "plan" && row.orderType !== "balance") continue;
    const currency = row.currency.trim().toUpperCase() || "CNY";
    const group = currencies.get(currency) || {
      currency, count: 0, items: [
        { id: "plan", label: "在线套餐支付", value: 0, color: "#3b82f6" },
        { id: "balance", label: "余额充值", value: 0, color: "#14b8a6" },
      ],
    };
    group.count += positiveChartValue(row.count);
    group.items[row.orderType === "plan" ? 0 : 1].value += positiveChartValue(row.amountCents);
    currencies.set(currency, group);
  }
  const consumption: FinanceChartItem[] = [
    { id: "purchase", label: "余额购买套餐", value: 0, color: "#3b82f6" },
    { id: "traffic_addon_purchase", label: "购买附加流量", value: 0, color: "#8b5cf6" },
    { id: "traffic_billing", label: "流量计费", value: 0, color: "#14b8a6" },
  ];
  for (const row of data.balances) {
    const item = consumption.find(item => item.id === row.type);
    if (item) item.value += positiveChartValue(row.debitCents);
  }
  const counts = new Map<string, number>();
  for (const row of data.orders) counts.set(row.status, (counts.get(row.status) || 0) + positiveChartValue(row.count));
  const knownStatuses = Object.keys(orderStyles);
  const statuses = [...knownStatuses, ...[...counts.keys()].filter(status => !knownStatuses.includes(status)).sort()];
  const orders = statuses.filter(status => counts.has(status)).map(id => ({
    id, value: counts.get(id) || 0, ...(Object.hasOwn(orderStyles, id) ? orderStyles[id] : { label: "未知", color: "#64748b" }),
  }));
  return { receipts: [...currencies.values()].sort((a, b) => a.currency.localeCompare(b.currency)), consumption, orders };
}
