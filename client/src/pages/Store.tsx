import DashboardLayout from "@/components/DashboardLayout";
import AnimatedStatValue from "@/components/AnimatedStatValue";
import AutoAnimateContainer from "@/components/AutoAnimateContainer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import DataSectionLoading from "@/components/DataSectionLoading";
import { useUrlTab } from "@/hooks/useUrlTab";
import { planResourceText } from "@/lib/planDisplay";
import { trpc } from "@/lib/trpc";
import { formatTrafficMultiplier } from "@shared/trafficMultiplier";
import { CheckCircle2, Coins, CreditCard, Lock, Package, RefreshCw, Route, Server, ShoppingBag, TicketPercent, WalletCards } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

function money(cents?: number, currency = "CNY") {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency }).format((cents || 0) / 100);
}

const MILLI_CENTS_PER_CENT = 1000;
const MILLI_CENTS_PER_YUAN = 100000;

function pricePerGbMilliCents(config: any) {
  const milliCents = Math.round(Number(config?.pricePerGbMilliCents || 0));
  if (milliCents > 0) return milliCents;
  return Math.round(Number(config?.pricePerGbCents || 0)) * MILLI_CENTS_PER_CENT;
}

function moneyFromMilliCents(milliCents?: number, currency = "CNY") {
  const yuan = Number(milliCents || 0) / MILLI_CENTS_PER_YUAN;
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    minimumFractionDigits: yuan > 0 && yuan < 0.01 ? 3 : 2,
    maximumFractionDigits: 3,
  }).format(yuan);
}

function bytes(size?: number | null) {
  const value = Number(size || 0);
  if (!value) return "不限";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = value;
  let idx = 0;
  while (n >= 1024 && idx < units.length - 1) {
    n /= 1024;
    idx++;
  }
  return `${n >= 10 || idx === 0 ? n.toFixed(0) : n.toFixed(2)} ${units[idx]}`;
}

function speed(value?: number | null) {
  const num = Number(value || 0);
  return num > 0 ? `${parseFloat(num.toFixed(2))} Mbps` : "不限";
}

const durationOptions = [
  { value: 30, label: "一个月" },
  { value: 90, label: "三个月" },
  { value: 180, label: "半年" },
  { value: 365, label: "一年" },
  { value: 730, label: "两年" },
];

type StoreTab = "plans" | "billing";
const STORE_TABS = ["plans", "billing"] as const;
const STORE_TAB_STORAGE_KEY = "forwardx.store.tab";

function durationLabel(days?: number | null) {
  return durationOptions.find((item) => item.value === Number(days))?.label || `${days || 30} 天`;
}

function planDescription(plan: any) {
  return String(plan?.description || "").trim();
}

function billingDescription(config: any) {
  return String(config?.description || "").trim();
}

function effectiveBillingPriceMilliCents(config: any) {
  return Math.round(pricePerGbMilliCents(config) * Number(config.multiplier || 100) / 100);
}

function planBenefitItems(plan: any) {
  const items = [
    `连续端口 ${plan.portCount || 0} 个`,
    `套餐流量 ${bytes(plan.trafficLimit)}`,
    `限速 ${speed(plan.rateLimitMbps)}`,
    `规则 ${plan.maxRules || "不限"} · 连接 ${plan.maxConnections || "不限"} · 单 IP ${plan.maxIPs || "不限"}`,
    "限制口径 端口转发按主机，隧道转发按隧道",
    `可用资源 ${planResourceText(plan)}`,
  ];
  if (Number(plan.durationDays || 0) > 30 && Number(plan.trafficLimit || 0) > 0) {
    items.splice(2, 0, "购买日起按月重置套餐流量");
  }
  return items;
}

function StorePlanCard({
  plan,
  purchasing,
  onBuy,
}: {
  plan: any;
  purchasing?: boolean;
  onBuy: () => void;
}) {
  const description = planDescription(plan) || "订阅后自动开通端口段和可用资源。";
  const benefits = planBenefitItems(plan);

  return (
    <div className="flex min-h-[29rem] flex-col overflow-hidden rounded-lg border border-border/40 bg-card/60 shadow-sm backdrop-blur-md transition-colors hover:border-primary/35">
      <div className="h-1.5 bg-gradient-to-r from-primary/45 via-primary/20 to-emerald-500/25" />

      <div className="flex flex-1 flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-md border border-primary/15 bg-primary/10 text-primary">
              <Package className="h-5 w-5" />
            </div>
            <h3 className="line-clamp-1 text-base font-semibold text-foreground">{plan.name}</h3>
            <p className="mt-2 line-clamp-3 text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          </div>
          <Badge variant="outline" className="shrink-0 border-primary/25 bg-primary/5 text-primary">
            {durationLabel(plan.durationDays)}
          </Badge>
        </div>

        <div className="grid grid-cols-2 gap-2 rounded-md border border-border/50 bg-muted/25 p-1">
          <div className="rounded-[6px] bg-background/80 px-3 py-2 shadow-sm">
            <div className="text-[11px] font-medium text-muted-foreground">周期</div>
            <div className="mt-1 truncate text-sm font-semibold text-foreground">{durationLabel(plan.durationDays)}</div>
          </div>
          <div className="rounded-[6px] px-3 py-2">
            <div className="text-[11px] font-medium text-muted-foreground">端口</div>
            <div className="mt-1 truncate text-sm font-semibold text-foreground">{plan.portCount || 0} 个</div>
          </div>
        </div>

        <div className="flex-1 rounded-md border border-border/40 bg-background/35 p-4">
          <p className="text-sm font-semibold text-foreground">套餐权益</p>
          <ul className="mt-3 space-y-2.5">
            {benefits.map((item) => (
              <li key={item} className="grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-2 text-xs leading-5 text-muted-foreground">
                <span className="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <CheckCircle2 className="h-3 w-3" />
                </span>
                <span className="break-words">{item}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col gap-3 border-t border-border/40 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="break-words text-2xl font-semibold tracking-tight text-foreground">
              {money(plan.priceCents, plan.currency)}
            </div>
            <div className="mt-0.5 text-[11px] font-medium text-muted-foreground">
              / {durationLabel(plan.durationDays)}
            </div>
          </div>
          <Button
            className="h-9 shrink-0 px-4"
            onClick={onBuy}
            disabled={purchasing}
          >
            <ShoppingBag className="mr-2 h-4 w-4" />
            购买套餐
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function Store() {
  const utils = trpc.useUtils();
  const { data: storeStatus, isLoading: storeStatusLoading } = trpc.plans.storeStatus.useQuery();
  const { data: plans = [], isLoading } = trpc.plans.storeList.useQuery();
  const { data: trafficBillingStore, isLoading: trafficBillingLoading } = trpc.trafficBilling.storeResources.useQuery(undefined, {
    enabled: !!storeStatus?.enabled,
  });
  const { data: wallet, isLoading: walletLoading } = trpc.billing.me.useQuery();
  const { data: billingFeatures } = trpc.billing.featureStatus.useQuery();
  const { data: paymentMethods = [] } = trpc.payment.availableMethods.useQuery(undefined, {
    enabled: !!storeStatus?.enabled,
  });
  const [selectedPlan, setSelectedPlan] = useState<any | null>(null);
  const [paymentType, setPaymentType] = useState<"alipay" | "wxpay" | "stripe">("stripe");
  const [payMode, setPayMode] = useState<"gateway" | "balance">("gateway");
  const [discountCode, setDiscountCode] = useState("");
  const [discountPreview, setDiscountPreview] = useState<any | null>(null);
  const [activeTab, setActiveTab] = useUrlTab<StoreTab>({
    values: STORE_TABS,
    defaultValue: "plans",
    storageKey: STORE_TAB_STORAGE_KEY,
  });

  const createOrder = trpc.payment.createOrder.useMutation({
    onSuccess: (order) => {
      toast.success("订单已创建");
      setSelectedPlan(null);
      utils.plans.mySubscriptions.invalidate();
      utils.billing.me.invalidate();
      utils.billing.ledger.invalidate();
      if (order?.payUrl) window.open(order.payUrl, "_blank", "noopener,noreferrer");
    },
    onError: (error) => toast.error(error.message || "创建订单失败"),
  });

  const buyWithBalance = trpc.billing.purchasePlanWithBalance.useMutation({
    onSuccess: () => {
      toast.success("套餐已购买");
      setSelectedPlan(null);
      setDiscountCode("");
      setDiscountPreview(null);
      utils.plans.mySubscriptions.invalidate();
      utils.billing.me.invalidate();
      utils.billing.ledger.invalidate();
    },
    onError: (error) => toast.error(error.message || "购买失败"),
  });

  const previewDiscount = trpc.billing.previewDiscount.useMutation({
    onSuccess: (data) => {
      setDiscountPreview(data);
      toast.success("折扣码已应用");
    },
    onError: (error) => {
      setDiscountPreview(null);
      toast.error(error.message || "折扣码不可用");
    },
  });

  const buy = (plan: any) => {
    const firstMethod = paymentMethods[0]?.value as "alipay" | "wxpay" | "stripe" | undefined;
    if (firstMethod) setPaymentType(firstMethod);
    setPayMode(firstMethod ? "gateway" : "balance");
    setDiscountCode("");
    setDiscountPreview(null);
    setSelectedPlan(plan);
  };

  const confirmBuy = () => {
    if (!selectedPlan) return;
    if (payMode === "balance") {
      buyWithBalance.mutate({ planId: selectedPlan.id, discountCode: billingFeatures?.discountEnabled ? discountCode.trim() || undefined : undefined });
      return;
    }
    createOrder.mutate({
      amount: Number(selectedPlan.priceCents || 0) / 100,
      paymentType,
      planId: selectedPlan.id,
      discountCode: billingFeatures?.discountEnabled ? discountCode.trim() || undefined : undefined,
    });
  };

  const finalAmountCents = discountPreview?.finalAmountCents ?? selectedPlan?.priceCents ?? 0;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">商店</h1>
          <p className="text-sm text-muted-foreground">购买套餐，开通资源。</p>
        </div>

        {storeStatusLoading && (
          <DataSectionLoading label="正在加载商店状态" />
        )}

        {!storeStatusLoading && !storeStatus?.enabled && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Lock className="h-5 w-5" /> 商店暂未开启</CardTitle>
              <CardDescription>请联系管理员开通。</CardDescription>
            </CardHeader>
          </Card>
        )}

        {!storeStatusLoading && storeStatus?.enabled && (
          <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as StoreTab)} className="space-y-4">
            <TabsList className="grid h-auto w-full grid-cols-2 sm:w-auto">
              <TabsTrigger value="plans" className="gap-2">
                <Package className="h-4 w-4" /> 订阅套餐
              </TabsTrigger>
              <TabsTrigger value="billing" className="gap-2">
                <Coins className="h-4 w-4" /> 按量计费
              </TabsTrigger>
            </TabsList>

            <TabsContent value="plans" className="mt-0">
              {isLoading ? (
                <DataSectionLoading label="正在加载商店套餐" />
              ) : (
                <AutoAnimateContainer className="standard-card-grid gap-4">
                  {plans.map((plan: any) => (
                    <StorePlanCard
                      key={plan.id}
                      plan={plan}
                      purchasing={createOrder.isPending || buyWithBalance.isPending}
                      onBuy={() => buy(plan)}
                    />
                  ))}
                  {!isLoading && plans.length === 0 && (
                    <Card className="col-span-full">
                      <CardHeader>
                        <CardTitle>暂无可购买套餐</CardTitle>
                        <CardDescription>暂无可用套餐。</CardDescription>
                      </CardHeader>
                    </Card>
                  )}
                </AutoAnimateContainer>
              )}
            </TabsContent>

            <TabsContent value="billing" className="mt-0">
              {trafficBillingLoading ? (
                <DataSectionLoading label="正在加载按量计费资源" />
              ) : (
                <AutoAnimateContainer className="standard-card-grid gap-4">
                  {(trafficBillingStore?.configs || []).map((config: any) => (
                    <Card key={`${config.resourceType}-${config.resourceId}`} className="flex flex-col">
                      <CardHeader>
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <CardTitle className="flex items-center gap-2">
                              {config.resourceType === "host" ? <Server className="h-5 w-5" /> : <Route className="h-5 w-5" />}
                              {config.resourceName}
                            </CardTitle>
                            <CardDescription className="mt-2">余额可用时可直接在转发规则中使用。</CardDescription>
                          </div>
                          <Badge variant="outline">{config.resourceKind || (config.resourceType === "host" ? "历史主机" : config.resourceType === "tunnel" ? "隧道转发" : "转发资源")}</Badge>
                        </div>
                      </CardHeader>
                      <CardContent className="flex-1 space-y-4">
                        <div className="text-3xl font-semibold">{moneyFromMilliCents(effectiveBillingPriceMilliCents(config))}<span className="ml-1 text-sm font-normal text-muted-foreground">/ 计费GB</span></div>
                        {billingDescription(config) ? (
                          <div className="whitespace-pre-line break-words text-sm leading-7 text-muted-foreground">
                            {billingDescription(config)}
                          </div>
                        ) : (
                          <>
                            <div className="grid gap-2 text-sm text-muted-foreground">
                              <div>基础单价：{moneyFromMilliCents(pricePerGbMilliCents(config))} / GB</div>
                              <div>倍率：{config.multiplierText || formatTrafficMultiplier(config.multiplier || 100)}</div>
                              <div>资源编号：#{config.resourceId}</div>
                              <div>使用方式：创建转发规则时选择该资源，按实际计费流量从余额扣费</div>
                            </div>
                            <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-sm text-muted-foreground">
                              该资源无需购买套餐；账户有余额即可使用。
                            </div>
                          </>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                  {(trafficBillingStore?.configs || []).length === 0 && (
                    <Card className="col-span-full">
                      <CardHeader>
                        <CardTitle>暂无公开按量计费资源</CardTitle>
                        <CardDescription>管理员公开资源后会在这里展示倍率和单价。</CardDescription>
                      </CardHeader>
                    </Card>
                  )}
                </AutoAnimateContainer>
              )}
            </TabsContent>
          </Tabs>
        )}

        <Dialog open={!!selectedPlan} onOpenChange={(open) => !open && setSelectedPlan(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CreditCard className="h-5 w-5" />
                选择支付方式
              </DialogTitle>
              <DialogDescription>
                购买 {selectedPlan?.name || "套餐"}，金额 {selectedPlan ? money(finalAmountCents, selectedPlan.currency) : "-"}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4">
              <div className="rounded-lg border bg-muted/20 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">原价</span>
                  <span>{selectedPlan ? money(selectedPlan.priceCents, selectedPlan.currency) : "-"}</span>
                </div>
                {discountPreview && (
                  <div className="mt-1 flex items-center justify-between text-emerald-600">
                    <span>优惠</span>
                    <span>-{money(discountPreview.discountAmountCents, selectedPlan?.currency)}</span>
                  </div>
                )}
                <div className="mt-2 flex items-center justify-between font-medium">
                  <span>应付</span>
                  <span>{money(finalAmountCents, selectedPlan?.currency)}</span>
                </div>
              </div>
              {billingFeatures?.discountEnabled && (
              <div className="flex gap-2">
                <Input value={discountCode} onChange={(e) => setDiscountCode(e.target.value.toUpperCase())} placeholder="折扣码（可选）" />
                <Button
                  variant="outline"
                  onClick={() => selectedPlan && previewDiscount.mutate({ code: discountCode, amountCents: Number(selectedPlan.priceCents || 0), planId: selectedPlan.id })}
                  disabled={!discountCode.trim() || previewDiscount.isPending}
                >
                  <TicketPercent className="mr-2 h-4 w-4" /> 应用
                </Button>
              </div>
              )}
              <div className="grid gap-2">
                <button
                  type="button"
                  onClick={() => setPayMode("balance")}
                  disabled={walletLoading}
                  className={`flex items-center justify-between rounded-lg border px-4 py-3 text-left transition-colors ${
                    payMode === "balance" ? "border-primary bg-primary/10 text-primary" : "border-border/60 bg-background/60 hover:bg-muted/60"
                  } disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  <span className="flex items-center gap-2 font-medium">
                    <WalletCards className="h-4 w-4" />
                    余额支付（
                    <AnimatedStatValue
                      value={money(wallet?.balanceCents)}
                      loading={walletLoading}
                      cacheKey="store.wallet.balance.inline"
                      fallbackValue={money(0)}
                      className="inline-block align-middle"
                    />
                    ）
                  </span>
                  {payMode === "balance" && <CheckCircle2 className="h-4 w-4" />}
                </button>
                {paymentMethods.map((method: any) => (
                  <button
                    key={method.value}
                    type="button"
                    onClick={() => { setPayMode("gateway"); setPaymentType(method.value); }}
                    className={`flex items-center justify-between rounded-lg border px-4 py-3 text-left transition-colors ${
                      payMode === "gateway" && paymentType === method.value
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border/60 bg-background/60 hover:bg-muted/60"
                    }`}
                  >
                    <span className="font-medium">{method.label}</span>
                    {payMode === "gateway" && paymentType === method.value && <CheckCircle2 className="h-4 w-4" />}
                  </button>
                ))}
                {paymentMethods.length === 0 && (
                  <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                    暂无在线支付方式。
                  </div>
                )}
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setSelectedPlan(null)}>取消</Button>
              <Button onClick={confirmBuy} disabled={createOrder.isPending || buyWithBalance.isPending || (payMode === "gateway" && paymentMethods.length === 0) || (payMode === "balance" && walletLoading)}>
                {(createOrder.isPending || buyWithBalance.isPending) ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <ShoppingBag className="mr-2 h-4 w-4" />}
                {payMode === "balance" ? (walletLoading ? "余额加载中" : "余额购买") : "去支付"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
