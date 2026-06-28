import DashboardLayout from "@/components/DashboardLayout";
import AnimatedStatValue from "@/components/AnimatedStatValue";
import DataSectionLoading from "@/components/DataSectionLoading";
import DatePickerInput, { parseDateInputValue } from "@/components/DatePickerInput";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useUrlTab } from "@/hooks/useUrlTab";
import { trpc } from "@/lib/trpc";
import { CreditCard, Download, Gift, Package, ReceiptText, Shuffle, TicketPercent, Trash2, WalletCards } from "lucide-react";
import { useEffect, useMemo, useState, type ElementType, type ReactNode } from "react";
import { toast } from "sonner";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const BILLING_CODE_BODY_LENGTH = 24;
type BillingTab = "ledger" | "subscriptions" | "balance" | "redeem" | "discount";
const BILLING_TABS = ["ledger", "subscriptions", "balance", "redeem", "discount"] as const;
const BILLING_TAB_STORAGE_KEY = "forwardx.billing.tab";

function money(cents?: number, currency = "CNY") {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency }).format((Number(cents) || 0) / 100);
}

function dateText(value?: string | Date | null) {
  return value ? new Date(value).toLocaleString() : "不限";
}

function randomBillingCode(prefix = "") {
  const randomValues = new Uint8Array(BILLING_CODE_BODY_LENGTH);
  const cryptoSource = globalThis.crypto;
  if (cryptoSource?.getRandomValues) {
    cryptoSource.getRandomValues(randomValues);
  } else {
    for (let i = 0; i < BILLING_CODE_BODY_LENGTH; i++) {
      randomValues[i] = Math.floor(Math.random() * 256);
    }
  }
  const body = Array.from(randomValues, (value) => CODE_CHARS[value % CODE_CHARS.length]).join("");
  return `${prefix}${body}`.slice(0, 64).toUpperCase();
}

function parseLocalTime(value: string) {
  const date = parseDateInputValue(value);
  return date ? date.getTime() : 0;
}

function discountStatus(code: any) {
  const now = Date.now();
  if (!code.isActive) return "停用";
  if (code.startsAt && new Date(code.startsAt).getTime() > now) return "等待生效";
  if (code.expiresAt && new Date(code.expiresAt).getTime() <= now) return "已过期";
  if (Number(code.maxUses || 0) > 0 && Number(code.usedCount || 0) >= Number(code.maxUses)) return "已用完";
  return "生效中";
}

function BillingStatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  tone,
  loading = false,
  cacheKey,
  fallbackValue,
}: {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: ElementType;
  tone: string;
  loading?: boolean;
  cacheKey: string;
  fallbackValue?: string | number;
}) {
  return (
    <Card className="group relative overflow-hidden border-border/40 bg-card/60 backdrop-blur-md transition-all duration-300 hover:border-border/70">
      <div className={`absolute inset-0 opacity-[0.04] transition-opacity group-hover:opacity-[0.08] ${tone}`} />
      <CardContent className="relative p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</p>
            <AnimatedStatValue
              as="p"
              value={value}
              loading={loading}
              cacheKey={cacheKey}
              fallbackValue={fallbackValue}
              className="break-words text-2xl font-bold tracking-tight tabular-nums"
            />
            {subtitle && (
              <AnimatedStatValue
                as="p"
                value={subtitle}
                loading={loading}
                cacheKey={`${cacheKey}.subtitle`}
                fallbackValue=""
                className="break-words text-xs text-muted-foreground/80"
              />
            )}
          </div>
          <div className={`hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl shadow-sm sm:flex ${tone}`}>
            <Icon className="h-5 w-5 text-white" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function BillingToggleCard({
  title,
  enabled,
  onCheckedChange,
  icon: Icon,
  tone,
  loading = false,
}: {
  title: string;
  enabled: boolean;
  onCheckedChange: (checked: boolean) => void;
  icon: ElementType;
  tone: string;
  loading?: boolean;
}) {
  return (
    <Card className="group relative overflow-hidden border-border/40 bg-card/60 backdrop-blur-md transition-all duration-300 hover:border-border/70">
      <div className={`absolute inset-0 opacity-[0.04] transition-opacity group-hover:opacity-[0.08] ${tone}`} />
      <CardContent className="relative p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</p>
            <AnimatedStatValue
              as="p"
              value={enabled ? "已开启" : "已关闭"}
              loading={loading}
              cacheKey={`billing.toggle.${title}`}
              fallbackValue="已关闭"
              className="break-words text-2xl font-bold tracking-tight"
            />
            <p className="break-words text-xs text-muted-foreground/80">入口状态</p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <Switch checked={enabled} onCheckedChange={onCheckedChange} disabled={loading} />
            <div className={`hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl shadow-sm sm:flex ${tone}`}>
              <Icon className="h-5 w-5 text-white" />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function normalizeCodeInput(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 64);
}

function balanceTypeText(type?: string | null) {
  if (type === "admin_recharge") return "管理员充值";
  if (type === "admin_adjust") return "管理员修改";
  if (type === "payment") return "在线充值入账";
  if (type === "purchase") return "余额消费";
  if (type === "redeem") return "兑换入账";
  if (type === "traffic_billing") return "流量计费";
  if (type === "traffic_addon_purchase") return "购买附加流量";
  return type || "余额变动";
}

function downloadCodeTextFile(codes: string[], filename = `redemption-codes-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`) {
  if (!codes.length || typeof window === "undefined") return;
  const blob = new Blob([codes.join("\r\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function ledgerTone(item: any) {
  if (item.kind === "balance" && Number(item.amountCents) < 0) return "text-destructive";
  if (item.kind === "balance" && Number(item.amountCents) > 0) return "text-emerald-600";
  if (item.kind === "payment" && (item.status === "paid" || item.status === "completed")) return "text-emerald-600";
  return "";
}

function ledgerIcon(item: any) {
  if (item.kind === "payment") return CreditCard;
  if (item.kind === "subscription") return Package;
  return WalletCards;
}

function MobileInfoRow({
  label,
  children,
  valueClassName = "",
}: {
  label: string;
  children: ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="grid grid-cols-[4.75rem_1fr] gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className={`min-w-0 text-right break-words ${valueClassName}`}>{children}</div>
    </div>
  );
}

export default function Billing() {
  const utils = trpc.useUtils();
  const { data: users = [], isLoading: usersLoading } = trpc.users.list.useQuery();
  const { data: plans = [] } = trpc.plans.list.useQuery();
  const { data: subscriptions = [], isLoading: subscriptionsLoading } = trpc.plans.subscriptions.useQuery({});
  const { data: transactions = [], isLoading: transactionsLoading } = trpc.billing.listTransactions.useQuery({ limit: 100 });
  const [ledgerUserId, setLedgerUserId] = useState("all");
  const { data: ledger = [], isLoading: ledgerLoading } = trpc.billing.ledger.useQuery({
    limit: 200,
    userId: ledgerUserId === "all" ? undefined : Number(ledgerUserId),
  });
  const { data: redemptionCodes = [], isLoading: redemptionCodesLoading } = trpc.billing.listRedemptionCodes.useQuery();
  const { data: discountCodes = [], isLoading: discountCodesLoading } = trpc.billing.listDiscountCodes.useQuery();
  const { data: featureStatus, isLoading: featureStatusLoading } = trpc.billing.featureStatus.useQuery();
  const [activeTab, setActiveTab] = useUrlTab<BillingTab>({
    values: BILLING_TABS,
    defaultValue: "balance",
    storageKey: BILLING_TAB_STORAGE_KEY,
  });

  const [redeemType, setRedeemType] = useState<"plan" | "balance">("plan");
  const [redeemCode, setRedeemCode] = useState("");
  const [redeemPlanId, setRedeemPlanId] = useState("");
  const [redeemDuration, setRedeemDuration] = useState("30");
  const [redeemAmount, setRedeemAmount] = useState("");
  const [redeemCount, setRedeemCount] = useState("1");
  const [redeemStartsAt, setRedeemStartsAt] = useState("");
  const [redeemExpiresAt, setRedeemExpiresAt] = useState("");
  const [redemptionUsageFilter, setRedemptionUsageFilter] = useState<"all" | "unused" | "used">("all");
  const [selectedRedemptionIds, setSelectedRedemptionIds] = useState<number[]>([]);

  const [discountCode, setDiscountCode] = useState("");
  const [discountType, setDiscountType] = useState<"percent" | "amount">("percent");
  const [discountValue, setDiscountValue] = useState("");
  const [discountMaxUses, setDiscountMaxUses] = useState("0");
  const [discountPlanIds, setDiscountPlanIds] = useState<number[]>([]);
  const [discountStartsAt, setDiscountStartsAt] = useState("");
  const [discountExpiresAt, setDiscountExpiresAt] = useState("");

  const setFeatureStatus = trpc.billing.setFeatureStatus.useMutation({
    onSuccess: () => {
      toast.success("功能开关已更新");
      utils.billing.featureStatus.invalidate();
    },
    onError: (error) => toast.error(error.message || "更新失败"),
  });

  const createRedemptionCodes = trpc.billing.createRedemptionCodes.useMutation({
    onSuccess: (res) => {
      toast.success(`已生成 ${res.codes.length} 个兑换码`);
      downloadCodeTextFile(res.codes);
      setRedeemCode("");
      setSelectedRedemptionIds([]);
      utils.billing.listRedemptionCodes.invalidate();
    },
    onError: (error) => toast.error(error.message || "生成失败"),
  });

  const deleteRedemptionCode = trpc.billing.deleteRedemptionCode.useMutation({
    onSuccess: (_data, variables) => {
      toast.success("兑换码已删除");
      setSelectedRedemptionIds((ids) => ids.filter((id) => id !== variables.id));
      utils.billing.listRedemptionCodes.invalidate();
    },
    onError: (error) => toast.error(error.message || "删除失败"),
  });

  const deleteRedemptionCodes = trpc.billing.deleteRedemptionCodes.useMutation({
    onSuccess: (data) => {
      toast.success(`已删除 ${data.deleted} 个兑换码`);
      setSelectedRedemptionIds([]);
      utils.billing.listRedemptionCodes.invalidate();
    },
    onError: (error) => toast.error(error.message || "删除失败"),
  });

  const createDiscountCode = trpc.billing.createDiscountCode.useMutation({
    onSuccess: () => {
      toast.success("折扣码已创建");
      setDiscountCode("");
      setDiscountValue("");
      setDiscountMaxUses("0");
      setDiscountPlanIds([]);
      utils.billing.listDiscountCodes.invalidate();
    },
    onError: (error) => toast.error(error.message || "创建失败"),
  });

  const deleteDiscountCode = trpc.billing.deleteDiscountCode.useMutation({
    onSuccess: () => {
      toast.success("折扣码已删除");
      utils.billing.listDiscountCodes.invalidate();
    },
    onError: (error) => toast.error(error.message || "删除失败"),
  });

  const validateWindow = (startsAt: string, expiresAt: string) => {
    if (startsAt && expiresAt && parseLocalTime(expiresAt) <= parseLocalTime(startsAt)) {
      toast.error("失效时间必须晚于生效时间");
      return false;
    }
    return true;
  };

  const submitRedemption = () => {
    const count = Math.floor(Number(redeemCount || 1));
    if (!Number.isFinite(count) || count < 1 || count > 500) {
      toast.error("生成数量需要在 1 到 500 之间");
      return;
    }
    if (redeemType === "plan" && !redeemPlanId) {
      toast.error("请选择要兑换的套餐");
      return;
    }
    if (redeemType === "balance") {
      const amount = Number(redeemAmount || 0);
      if (!Number.isFinite(amount) || amount <= 0) {
        toast.error("请输入大于 0 的余额金额");
        return;
      }
    }
    if (!validateWindow(redeemStartsAt, redeemExpiresAt)) return;
    createRedemptionCodes.mutate({
      type: redeemType,
      code: redeemCode.trim() || undefined,
      count,
      planId: redeemType === "plan" ? Number(redeemPlanId) : null,
      durationDays: redeemType === "plan" ? (Number(redeemDuration) as 30 | 90 | 180 | 365) : null,
      amountCents: redeemType === "balance" ? Math.round(Number(redeemAmount || 0) * 100) : 0,
      startsAt: redeemStartsAt || null,
      expiresAt: redeemExpiresAt || null,
    });
  };

  const filteredRedemptionCodes = useMemo(() => {
    if (redemptionUsageFilter === "unused") return redemptionCodes.filter((code: any) => !code.usedAt && !code.usedByUserId);
    if (redemptionUsageFilter === "used") return redemptionCodes.filter((code: any) => !!code.usedAt || !!code.usedByUserId);
    return redemptionCodes;
  }, [redemptionCodes, redemptionUsageFilter]);

  const filteredRedemptionIds = useMemo(
    () => filteredRedemptionCodes.map((code: any) => Number(code.id)).filter(Boolean),
    [filteredRedemptionCodes]
  );
  const selectedRedemptionSet = useMemo(() => new Set(selectedRedemptionIds), [selectedRedemptionIds]);
  const selectedRedemptionCodes = useMemo(
    () => redemptionCodes.filter((code: any) => selectedRedemptionSet.has(Number(code.id))),
    [redemptionCodes, selectedRedemptionSet]
  );
  const allFilteredRedemptionSelected = filteredRedemptionIds.length > 0 && filteredRedemptionIds.every((id: number) => selectedRedemptionSet.has(id));

  useEffect(() => {
    const existingIds = new Set(redemptionCodes.map((code: any) => Number(code.id)));
    setSelectedRedemptionIds((ids) => {
      if (ids.length === 0) return ids;
      const next = ids.filter((id) => existingIds.has(id));
      return next.length === ids.length ? ids : next;
    });
  }, [redemptionCodes]);

  const toggleAllFilteredRedemptionCodes = (checked: boolean) => {
    setSelectedRedemptionIds((ids) => {
      const next = new Set(ids);
      filteredRedemptionIds.forEach((id: number) => {
        if (checked) next.add(id);
        else next.delete(id);
      });
      return Array.from(next);
    });
  };

  const toggleRedemptionCode = (id: number, checked: boolean) => {
    setSelectedRedemptionIds((ids) => {
      if (checked) return ids.includes(id) ? ids : [...ids, id];
      return ids.filter((item) => item !== id);
    });
  };

  const exportRedemptionCodes = (items: any[]) => {
    const codes = items.map((item) => String(item.code || "").trim()).filter(Boolean);
    if (codes.length === 0) {
      toast.error("没有可导出的兑换码");
      return;
    }
    downloadCodeTextFile(codes);
    toast.success(`已导出 ${codes.length} 个兑换码`);
  };

  const deleteSelectedRedemptionCodes = () => {
    if (selectedRedemptionIds.length === 0) {
      toast.error("请先选择兑换码");
      return;
    }
    if (!window.confirm(`确认删除选中的 ${selectedRedemptionIds.length} 个兑换码？`)) return;
    deleteRedemptionCodes.mutate({ ids: selectedRedemptionIds });
  };

  const submitDiscount = () => {
    const code = discountCode.trim();
    const rawValue = Number(discountValue || 0);
    if (!code) {
      toast.error("请填写折扣码，或点击随机生成");
      return;
    }
    if (!Number.isFinite(rawValue) || rawValue <= 0) {
      toast.error("请输入有效的折扣数值");
      return;
    }
    if (discountType === "percent" && rawValue > 100) {
      toast.error("百分比折扣不能超过 100");
      return;
    }
    if (!validateWindow(discountStartsAt, discountExpiresAt)) return;
    createDiscountCode.mutate({
      code,
      discountType,
      discountValue: discountType === "percent" ? Math.floor(rawValue) : Math.round(rawValue * 100),
      maxUses: Math.max(0, Math.floor(Number(discountMaxUses || 0))),
      planIds: discountPlanIds,
      startsAt: discountStartsAt || null,
      expiresAt: discountExpiresAt || null,
    });
  };

  const totalBalance = users.reduce((sum: number, user: any) => sum + Number(user.balanceCents || 0), 0);
  const activeRedemptionCodes = redemptionCodes.filter((code: any) => code.isActive && !code.usedAt).length;
  const activeDiscountCodes = discountCodes.filter((code: any) => discountStatus(code) === "生效中").length;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">余额与营销</h1>
          <p className="text-sm text-muted-foreground">管理余额、兑换码和折扣码。</p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <BillingStatCard
            title="用户余额总额"
            value={money(totalBalance)}
            subtitle={`${users.length} 个用户`}
            icon={WalletCards}
            tone="bg-gradient-to-br from-blue-500 to-blue-600"
            loading={usersLoading}
            cacheKey="billing.totalBalance"
            fallbackValue={money(0)}
          />
          <BillingStatCard
            title="可用兑换码"
            value={activeRedemptionCodes}
            subtitle="未使用且已启用"
            icon={Gift}
            tone="bg-gradient-to-br from-emerald-500 to-emerald-600"
            loading={redemptionCodesLoading}
            cacheKey="billing.activeRedemptionCodes"
            fallbackValue={0}
          />
          <BillingStatCard
            title="生效折扣码"
            value={activeDiscountCodes}
            subtitle="当前可抵扣"
            icon={TicketPercent}
            tone="bg-gradient-to-br from-violet-500 to-violet-600"
            loading={discountCodesLoading}
            cacheKey="billing.activeDiscountCodes"
            fallbackValue={0}
          />
          <BillingToggleCard
            title="用户兑换入口"
            enabled={featureStatus?.redemptionEnabled ?? true}
            onCheckedChange={(redemptionEnabled) => setFeatureStatus.mutate({ redemptionEnabled })}
            icon={Gift}
            tone="bg-gradient-to-br from-amber-500 to-amber-600"
            loading={featureStatusLoading}
          />
          <BillingToggleCard
            title="购买折扣入口"
            enabled={featureStatus?.discountEnabled ?? true}
            onCheckedChange={(discountEnabled) => setFeatureStatus.mutate({ discountEnabled })}
            icon={TicketPercent}
            tone="bg-gradient-to-br from-rose-500 to-rose-600"
            loading={featureStatusLoading}
          />
        </div>

        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as BillingTab)}>
          <TabsList className="flex h-auto flex-wrap">
            <TabsTrigger value="ledger">账单流水</TabsTrigger>
            <TabsTrigger value="subscriptions">订阅记录</TabsTrigger>
            <TabsTrigger value="balance">余额流水</TabsTrigger>
            <TabsTrigger value="redeem">兑换码</TabsTrigger>
            <TabsTrigger value="discount">折扣码</TabsTrigger>
          </TabsList>

          <TabsContent value="ledger" className="mt-4">
            <Card>
              <CardHeader className="gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2"><ReceiptText className="h-5 w-5" /> 账单流水</CardTitle>
                  <CardDescription>余额、支付和订阅记录。</CardDescription>
                </div>
                <Select value={ledgerUserId} onValueChange={setLedgerUserId}>
                  <SelectTrigger className="w-full lg:w-56">
                    <SelectValue placeholder="筛选用户" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部用户</SelectItem>
                    {users.map((user: any) => (
                      <SelectItem key={user.id} value={String(user.id)}>
                        {user.name || user.username}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </CardHeader>
              <CardContent>
                {ledgerLoading ? (
                  <DataSectionLoading label="正在加载账单流水" />
                ) : (
                  <>
                <div className="grid gap-3 md:hidden">
                  {ledger.map((item: any) => {
                    const Icon = ledgerIcon(item);
                    const relatedInfo = item.paymentOrderNo || item.tradeNo || (item.planId ? `plan#${item.planId}` : "-");
                    return (
                      <div key={item.id} className="rounded-lg border border-border/50 bg-background/40 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-start gap-3">
                            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-muted/30">
                              <Icon className="h-4 w-4 text-muted-foreground" />
                            </div>
                            <div className="min-w-0">
                              <p className="break-words text-sm font-medium">{item.title}</p>
                              <p className="mt-0.5 break-words text-xs text-muted-foreground">{item.description || "-"}</p>
                            </div>
                          </div>
                          <div className={`shrink-0 text-right text-sm font-medium ${ledgerTone(item)}`}>
                            {item.kind === "subscription" && Number(item.amountCents || 0) === 0 ? "-" : money(item.amountCents, item.currency || "CNY")}
                          </div>
                        </div>
                        <div className="mt-3 space-y-2 border-t border-border/40 pt-3">
                          <MobileInfoRow label="用户">{item.name || item.username || `#${item.userId}`}</MobileInfoRow>
                          <MobileInfoRow label="类型"><Badge variant="outline">{item.category}</Badge></MobileInfoRow>
                          <MobileInfoRow label="状态">
                            <Badge variant={item.status === "completed" || item.status === "paid" || item.status === "active" ? "default" : "secondary"}>{item.statusLabel || item.status}</Badge>
                          </MobileInfoRow>
                          <MobileInfoRow label="关联" valueClassName="font-mono text-xs text-muted-foreground">{relatedInfo}</MobileInfoRow>
                          <MobileInfoRow label="时间">{dateText(item.createdAt)}</MobileInfoRow>
                        </div>
                      </div>
                    );
                  })}
                  {ledger.length === 0 && (
                    <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">暂无账单流水</div>
                  )}
                </div>
                <div className="hidden overflow-x-auto md:block">
                  <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>用户</TableHead>
                      <TableHead>项目</TableHead>
                      <TableHead>类型</TableHead>
                      <TableHead>金额</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>关联信息</TableHead>
                      <TableHead>时间</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ledger.map((item: any) => {
                      const Icon = ledgerIcon(item);
                      return (
                        <TableRow key={item.id}>
                          <TableCell>{item.name || item.username || `#${item.userId}`}</TableCell>
                          <TableCell>
                            <div className="flex min-w-60 items-start gap-3">
                              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-muted/30">
                                <Icon className="h-4 w-4 text-muted-foreground" />
                              </div>
                              <div className="min-w-0">
                                <p className="truncate text-sm font-medium">{item.title}</p>
                                <p className="truncate text-xs text-muted-foreground">{item.description || "-"}</p>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell><Badge variant="outline">{item.category}</Badge></TableCell>
                          <TableCell className={ledgerTone(item)}>
                            {item.kind === "subscription" && Number(item.amountCents || 0) === 0 ? "-" : money(item.amountCents, item.currency || "CNY")}
                          </TableCell>
                          <TableCell><Badge variant={item.status === "completed" || item.status === "paid" || item.status === "active" ? "default" : "secondary"}>{item.statusLabel || item.status}</Badge></TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">{item.paymentOrderNo || item.tradeNo || (item.planId ? `plan#${item.planId}` : "-")}</TableCell>
                          <TableCell>{dateText(item.createdAt)}</TableCell>
                        </TableRow>
                      );
                    })}
                    {ledger.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">暂无账单流水</TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
                </div>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="subscriptions" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Package className="h-5 w-5" /> 订阅记录</CardTitle>
                <CardDescription>套餐购买和后台分配记录。</CardDescription>
              </CardHeader>
              <CardContent>
                {subscriptionsLoading ? (
                  <DataSectionLoading label="正在加载订阅记录" />
                ) : (
                  <>
                <div className="grid gap-3 md:hidden">
                  {subscriptions.slice(0, 20).map((sub: any) => (
                    <div key={sub.id} className="rounded-lg border border-border/50 bg-background/40 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="break-words text-sm font-medium">{sub.name || sub.username || `用户 #${sub.userId}`}</p>
                          <p className="mt-1 break-words text-xs text-muted-foreground">{sub.planName || `套餐 #${sub.planId}`}</p>
                        </div>
                        <Badge variant="outline" className="shrink-0">{sub.source === "payment" ? "购买" : "后台分配"}</Badge>
                      </div>
                      <div className="mt-3 space-y-2 border-t border-border/40 pt-3">
                        <MobileInfoRow label="端口段">{sub.portRangeStart}-{sub.portRangeEnd}</MobileInfoRow>
                        <MobileInfoRow label="到期时间">{sub.expiresAt ? new Date(sub.expiresAt).toLocaleString() : "永久"}</MobileInfoRow>
                      </div>
                    </div>
                  ))}
                  {subscriptions.length === 0 && (
                    <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">暂无订阅记录</div>
                  )}
                </div>
                <div className="hidden overflow-x-auto md:block">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>用户</TableHead>
                        <TableHead>套餐</TableHead>
                        <TableHead>端口段</TableHead>
                        <TableHead>来源</TableHead>
                        <TableHead>到期时间</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {subscriptions.slice(0, 20).map((sub: any) => (
                        <TableRow key={sub.id}>
                          <TableCell>{sub.name || sub.username || `用户 #${sub.userId}`}</TableCell>
                          <TableCell>{sub.planName || `套餐 #${sub.planId}`}</TableCell>
                          <TableCell>{sub.portRangeStart}-{sub.portRangeEnd}</TableCell>
                          <TableCell><Badge variant="outline">{sub.source === "payment" ? "购买" : "后台分配"}</Badge></TableCell>
                          <TableCell>{sub.expiresAt ? new Date(sub.expiresAt).toLocaleString() : "永久"}</TableCell>
                        </TableRow>
                      ))}
                      {subscriptions.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">暂无订阅记录</TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="balance" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><WalletCards className="h-5 w-5" /> 余额流水</CardTitle>
                <CardDescription>余额变动记录。</CardDescription>
              </CardHeader>
              <CardContent>
                {transactionsLoading ? (
                  <DataSectionLoading label="正在加载余额流水" />
                ) : (
                  <>
                <div className="grid gap-3 md:hidden">
                  {transactions.map((tx: any) => (
                    <div key={tx.id} className="rounded-lg border border-border/50 bg-background/40 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="break-words text-sm font-medium">{tx.name || tx.username || `#${tx.userId}`}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{dateText(tx.createdAt)}</p>
                        </div>
                        <div className={`shrink-0 text-right text-sm font-medium ${Number(tx.amountCents) >= 0 ? "text-emerald-600" : "text-destructive"}`}>{money(tx.amountCents)}</div>
                      </div>
                      <div className="mt-3 space-y-2 border-t border-border/40 pt-3">
                        <MobileInfoRow label="类型"><Badge variant="outline">{tx.typeLabel || balanceTypeText(tx.type)}</Badge></MobileInfoRow>
                        <MobileInfoRow label="余额">{money(tx.balanceAfterCents)}</MobileInfoRow>
                        <MobileInfoRow label="说明">{tx.description || "-"}</MobileInfoRow>
                      </div>
                    </div>
                  ))}
                  {transactions.length === 0 && (
                    <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">暂无余额流水</div>
                  )}
                </div>
                <div className="hidden overflow-x-auto md:block">
                  <Table>
                  <TableHeader><TableRow><TableHead>用户</TableHead><TableHead>类型</TableHead><TableHead>金额</TableHead><TableHead>余额</TableHead><TableHead>说明</TableHead><TableHead>时间</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {transactions.map((tx: any) => (
                      <TableRow key={tx.id}>
                        <TableCell>{tx.name || tx.username || `#${tx.userId}`}</TableCell>
                        <TableCell><Badge variant="outline">{tx.typeLabel || balanceTypeText(tx.type)}</Badge></TableCell>
                        <TableCell className={Number(tx.amountCents) >= 0 ? "text-emerald-600" : "text-destructive"}>{money(tx.amountCents)}</TableCell>
                        <TableCell>{money(tx.balanceAfterCents)}</TableCell>
                        <TableCell>{tx.description || "-"}</TableCell>
                        <TableCell>{dateText(tx.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                </div>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="redeem" className="mt-4 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Gift className="h-5 w-5" /> 生成兑换码</CardTitle>
                <CardDescription>一次性兑换套餐或余额。</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-4">
                <div className="space-y-2 md:col-span-2">
                  <Label>兑换码</Label>
                  <div className="flex gap-2">
                    <Input value={redeemCode} onChange={(e) => setRedeemCode(normalizeCodeInput(e.target.value))} placeholder="留空自动生成" />
                    <Button type="button" variant="outline" onClick={() => setRedeemCode(randomBillingCode("FXR"))}><Shuffle className="mr-2 h-4 w-4" /> 随机</Button>
                  </div>
                  <p className="text-xs text-muted-foreground">留空自动生成兑换码。</p>
                </div>
                <div className="space-y-2"><Label>类型</Label><Select value={redeemType} onValueChange={(v: "plan" | "balance") => setRedeemType(v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="plan">套餐期限</SelectItem><SelectItem value="balance">余额</SelectItem></SelectContent></Select></div>
                {redeemType === "plan" ? (
                  <>
                    <div className="space-y-2"><Label>套餐</Label><Select value={redeemPlanId} onValueChange={setRedeemPlanId}><SelectTrigger><SelectValue placeholder="选择套餐" /></SelectTrigger><SelectContent>{plans.map((plan: any) => <SelectItem key={plan.id} value={String(plan.id)}>{plan.name}</SelectItem>)}</SelectContent></Select></div>
                    <div className="space-y-2"><Label>期限</Label><Select value={redeemDuration} onValueChange={setRedeemDuration}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="30">1 个月</SelectItem><SelectItem value="90">3 个月</SelectItem><SelectItem value="180">6 个月</SelectItem><SelectItem value="365">1 年</SelectItem></SelectContent></Select></div>
                  </>
                ) : (
                  <div className="space-y-2"><Label>余额金额</Label><Input type="number" min={0.01} step="0.01" value={redeemAmount} onChange={(e) => setRedeemAmount(e.target.value)} /></div>
                )}
                <div className="space-y-2"><Label>数量</Label><Input type="number" min={1} max={500} value={redeemCount} onChange={(e) => setRedeemCount(e.target.value)} /></div>
                <div className="space-y-2">
                  <Label>生效日期</Label>
                  <DatePickerInput value={redeemStartsAt} onChange={setRedeemStartsAt} placeholder="立即生效" />
                </div>
                <div className="space-y-2">
                  <Label>失效日期</Label>
                  <DatePickerInput value={redeemExpiresAt} onChange={setRedeemExpiresAt} placeholder="永久有效" />
                  <p className="text-xs text-muted-foreground">不选择则永久有效。</p>
                </div>
                <div className="flex justify-end md:col-span-4"><Button className="w-full sm:w-auto" onClick={submitRedemption} disabled={createRedemptionCodes.isPending}><Gift className="mr-2 h-4 w-4" /> 生成兑换码</Button></div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <CardTitle>兑换码列表</CardTitle>
                  <CardDescription>筛选、选择并导出兑换码。</CardDescription>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap lg:justify-end">
                  <Select value={redemptionUsageFilter} onValueChange={(value: "all" | "unused" | "used") => setRedemptionUsageFilter(value)}>
                    <SelectTrigger className="w-full sm:w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部</SelectItem>
                      <SelectItem value="unused">未使用</SelectItem>
                      <SelectItem value="used">已使用</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button type="button" variant="outline" onClick={() => exportRedemptionCodes(filteredRedemptionCodes)} disabled={filteredRedemptionCodes.length === 0}>
                    <Download className="mr-2 h-4 w-4" /> 导出当前
                  </Button>
                  <Button type="button" variant="outline" onClick={() => exportRedemptionCodes(selectedRedemptionCodes)} disabled={selectedRedemptionCodes.length === 0}>
                    <Download className="mr-2 h-4 w-4" /> 导出所选
                  </Button>
                  <Button type="button" variant="destructive" onClick={deleteSelectedRedemptionCodes} disabled={selectedRedemptionIds.length === 0 || deleteRedemptionCodes.isPending}>
                    <Trash2 className="mr-2 h-4 w-4" /> 删除所选
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {redemptionCodesLoading ? (
                  <DataSectionLoading label="正在加载兑换码" />
                ) : (
                  <>
                <div className="grid gap-3 md:hidden">
                  {filteredRedemptionCodes.map((code: any) => {
                    const content = code.type === "plan" ? `${code.planName || `套餐 #${code.planId}`} / ${code.durationDays || 30} 天` : money(code.amountCents);
                    const usage = code.usedAt ? `${code.usedByUsername || code.usedByUserId} 于 ${dateText(code.usedAt)}` : "未使用";
                    return (
                      <div key={code.id} className="rounded-lg border border-border/50 bg-background/40 p-3">
                        <div className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            className="mt-1"
                            checked={selectedRedemptionSet.has(Number(code.id))}
                            onChange={(event) => toggleRedemptionCode(Number(code.id), event.target.checked)}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-2">
                              <p className="min-w-0 break-all font-mono text-sm font-medium">{code.code}</p>
                              <Button variant="ghost" size="icon" className="-mr-2 -mt-2 shrink-0 text-destructive" onClick={() => deleteRedemptionCode.mutate({ id: code.id })}>
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                            <div className="mt-3 space-y-2 border-t border-border/40 pt-3">
                              <MobileInfoRow label="类型"><Badge variant="outline">{code.type === "plan" ? "套餐" : "余额"}</Badge></MobileInfoRow>
                              <MobileInfoRow label="内容">{content}</MobileInfoRow>
                              <MobileInfoRow label="有效期">{dateText(code.startsAt)} - {dateText(code.expiresAt)}</MobileInfoRow>
                              <MobileInfoRow label="使用">{usage}</MobileInfoRow>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {filteredRedemptionCodes.length === 0 && (
                    <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">暂无兑换码</div>
                  )}
                </div>
                <div className="hidden overflow-x-auto md:block">
                  <Table>
                  <TableHeader><TableRow><TableHead className="w-12"><input type="checkbox" checked={allFilteredRedemptionSelected} onChange={(event) => toggleAllFilteredRedemptionCodes(event.target.checked)} disabled={filteredRedemptionCodes.length === 0} /></TableHead><TableHead>兑换码</TableHead><TableHead>类型</TableHead><TableHead>内容</TableHead><TableHead>有效期</TableHead><TableHead>使用情况</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {filteredRedemptionCodes.map((code: any) => (
                      <TableRow key={code.id}>
                        <TableCell><input type="checkbox" checked={selectedRedemptionSet.has(Number(code.id))} onChange={(event) => toggleRedemptionCode(Number(code.id), event.target.checked)} /></TableCell>
                        <TableCell className="font-mono break-all">{code.code}</TableCell>
                        <TableCell><Badge variant="outline">{code.type === "plan" ? "套餐" : "余额"}</Badge></TableCell>
                        <TableCell>{code.type === "plan" ? `${code.planName || `套餐 #${code.planId}`} / ${code.durationDays || 30} 天` : money(code.amountCents)}</TableCell>
                        <TableCell>{dateText(code.startsAt)} - {dateText(code.expiresAt)}</TableCell>
                        <TableCell>{code.usedAt ? `${code.usedByUsername || code.usedByUserId} 于 ${dateText(code.usedAt)}` : "未使用"}</TableCell>
                        <TableCell className="text-right"><Button variant="ghost" size="icon" className="text-destructive" onClick={() => deleteRedemptionCode.mutate({ id: code.id })}><Trash2 className="h-4 w-4" /></Button></TableCell>
                      </TableRow>
                    ))}
                    {filteredRedemptionCodes.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">暂无兑换码</TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
                </div>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="discount" className="mt-4 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><TicketPercent className="h-5 w-5" /> 新增折扣码</CardTitle>
                <CardDescription>购买套餐时抵扣。</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-4">
                <div className="space-y-2 md:col-span-2">
                  <Label>折扣码</Label>
                  <div className="flex gap-2">
                    <Input value={discountCode} onChange={(e) => setDiscountCode(normalizeCodeInput(e.target.value))} placeholder="例如 SALE2026" />
                    <Button type="button" variant="outline" onClick={() => setDiscountCode(randomBillingCode("FXD"))}><Shuffle className="mr-2 h-4 w-4" /> 随机</Button>
                  </div>
                  <p className="text-xs text-muted-foreground">可手动填写或随机生成。</p>
                </div>
                <div className="space-y-2"><Label>类型</Label><Select value={discountType} onValueChange={(v: "percent" | "amount") => setDiscountType(v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="percent">百分比</SelectItem><SelectItem value="amount">固定金额</SelectItem></SelectContent></Select></div>
                <div className="space-y-2"><Label>{discountType === "percent" ? "折扣百分比" : "抵扣金额"}</Label><Input type="number" min={1} max={discountType === "percent" ? 100 : undefined} value={discountValue} onChange={(e) => setDiscountValue(e.target.value)} /></div>
                <div className="space-y-2"><Label>可用次数</Label><Input type="number" min={0} value={discountMaxUses} onChange={(e) => setDiscountMaxUses(e.target.value)} placeholder="0=不限" /></div>
                <div className="space-y-2">
                  <Label>生效日期</Label>
                  <DatePickerInput value={discountStartsAt} onChange={setDiscountStartsAt} placeholder="立即生效" />
                </div>
                <div className="space-y-2">
                  <Label>失效日期</Label>
                  <DatePickerInput value={discountExpiresAt} onChange={setDiscountExpiresAt} placeholder="永久有效" />
                </div>
                <div className="space-y-2 md:col-span-4">
                  <Label>适用套餐</Label>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    <button type="button" onClick={() => setDiscountPlanIds([])} className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${discountPlanIds.length === 0 ? "border-primary bg-primary/10 text-primary" : "border-border/60 bg-background/60 hover:bg-muted/60"}`}>全部套餐</button>
                    {plans.map((plan: any) => {
                      const checked = discountPlanIds.includes(Number(plan.id));
                      return (
                        <button key={plan.id} type="button" onClick={() => setDiscountPlanIds((ids) => checked ? ids.filter((id) => id !== Number(plan.id)) : [...ids, Number(plan.id)])} className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${checked ? "border-primary bg-primary/10 text-primary" : "border-border/60 bg-background/60 hover:bg-muted/60"}`}>
                          {plan.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="flex justify-end md:col-span-4"><Button className="w-full sm:w-auto" onClick={submitDiscount} disabled={createDiscountCode.isPending}><TicketPercent className="mr-2 h-4 w-4" /> 创建折扣码</Button></div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>折扣码列表</CardTitle></CardHeader>
              <CardContent>
                {discountCodesLoading ? (
                  <DataSectionLoading label="正在加载折扣码" />
                ) : (
                  <>
                <div className="grid gap-3 md:hidden">
                  {discountCodes.map((code: any) => {
                    const status = discountStatus(code);
                    const planNames = code.planIds?.length ? code.planIds.map((id: number) => (plans as any[]).find((plan: any) => Number(plan.id) === Number(id))?.name || `#${id}`).join("、") : "全部套餐";
                    return (
                      <div key={code.id} className="rounded-lg border border-border/50 bg-background/40 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <p className="min-w-0 break-all font-mono text-sm font-medium">{code.code}</p>
                          <Button variant="ghost" size="icon" className="-mr-2 -mt-2 shrink-0 text-destructive" onClick={() => deleteDiscountCode.mutate({ id: code.id })}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                        <div className="mt-3 space-y-2 border-t border-border/40 pt-3">
                          <MobileInfoRow label="优惠">{code.discountType === "percent" ? `${code.discountValue}%` : money(code.discountValue)}</MobileInfoRow>
                          <MobileInfoRow label="套餐">{planNames}</MobileInfoRow>
                          <MobileInfoRow label="状态"><Badge variant={status === "生效中" ? "default" : "secondary"}>{status}</Badge></MobileInfoRow>
                          <MobileInfoRow label="次数">{code.usedCount || 0} / {code.maxUses || "不限"}</MobileInfoRow>
                          <MobileInfoRow label="有效期">{dateText(code.startsAt)} - {dateText(code.expiresAt)}</MobileInfoRow>
                        </div>
                      </div>
                    );
                  })}
                  {discountCodes.length === 0 && (
                    <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">暂无折扣码</div>
                  )}
                </div>
                <div className="hidden overflow-x-auto md:block">
                  <Table>
                  <TableHeader><TableRow><TableHead>折扣码</TableHead><TableHead>优惠</TableHead><TableHead>适用套餐</TableHead><TableHead>状态</TableHead><TableHead>次数</TableHead><TableHead>有效期</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {discountCodes.map((code: any) => {
                      const status = discountStatus(code);
                      return (
                        <TableRow key={code.id}>
                          <TableCell className="font-mono break-all">{code.code}</TableCell>
                          <TableCell>{code.discountType === "percent" ? `${code.discountValue}%` : money(code.discountValue)}</TableCell>
                          <TableCell>{code.planIds?.length ? code.planIds.map((id: number) => (plans as any[]).find((plan: any) => Number(plan.id) === Number(id))?.name || `#${id}`).join("、") : "全部套餐"}</TableCell>
                          <TableCell><Badge variant={status === "生效中" ? "default" : "secondary"}>{status}</Badge></TableCell>
                          <TableCell>{code.usedCount || 0} / {code.maxUses || "不限"}</TableCell>
                          <TableCell>{dateText(code.startsAt)} - {dateText(code.expiresAt)}</TableCell>
                          <TableCell className="text-right"><Button variant="ghost" size="icon" className="text-destructive" onClick={() => deleteDiscountCode.mutate({ id: code.id })}><Trash2 className="h-4 w-4" /></Button></TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                </div>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
