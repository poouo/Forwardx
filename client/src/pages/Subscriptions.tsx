import DashboardLayout from "@/components/DashboardLayout";
import AnimatedStatValue from "@/components/AnimatedStatValue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import DataSectionLoading from "@/components/DataSectionLoading";
import { planResourceText } from "@/lib/planDisplay";
import { trpc } from "@/lib/trpc";
import { CalendarClock, CheckCircle2, CreditCard, Gauge, Package, RefreshCw, ShoppingBag, TicketPercent, WalletCards } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

function money(cents?: number | null, currency = "CNY") {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency }).format((Number(cents) || 0) / 100);
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
  return value ? `${bytes(value)}/s` : "不限";
}

function dateTime(value?: string | Date | null) {
  if (!value) return "---";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "---";
  return date.toLocaleString();
}

function statusLabel(status?: string) {
  if (status === "active") return "生效中";
  if (status === "expired") return "已过期";
  if (status === "cancelled") return "已取消";
  return status || "-";
}

function sourceLabel(source?: string) {
  if (source === "admin") return "后台分配";
  if (source === "payment") return "在线购买";
  if (source === "redeem") return "兑换套餐";
  if (source === "balance") return "余额购买";
  return source || "-";
}

function cycleEnd(sub: any) {
  return sub?.nextTrafficResetAt || sub?.expiresAt || null;
}

export default function Subscriptions() {
  const utils = trpc.useUtils();
  const [, setLocation] = useLocation();
  const { data: storeStatus } = trpc.plans.storeStatus.useQuery();
  const { data: wallet, isLoading: walletLoading } = trpc.billing.me.useQuery();
  const { data: billingFeatures } = trpc.billing.featureStatus.useQuery();
  const { data: paymentMethods = [] } = trpc.payment.availableMethods.useQuery(undefined, {
    enabled: !!storeStatus?.enabled,
  });
  const { data: subscriptions = [], isLoading } = trpc.plans.mySubscriptions.useQuery();
  const [selected, setSelected] = useState<{ sub: any; addon: any } | null>(null);
  const [renewingSub, setRenewingSub] = useState<any | null>(null);
  const [paymentType, setPaymentType] = useState<"alipay" | "wxpay" | "stripe">("stripe");
  const [payMode, setPayMode] = useState<"gateway" | "balance">("gateway");
  const [discountCode, setDiscountCode] = useState("");
  const [discountPreview, setDiscountPreview] = useState<any | null>(null);

  const activeCount = useMemo(
    () => subscriptions.filter((sub: any) => sub.status === "active" && (!sub.expiresAt || new Date(sub.expiresAt) > new Date())).length,
    [subscriptions],
  );

  const purchaseAddon = trpc.billing.purchaseTrafficAddonWithBalance.useMutation({
    onSuccess: () => {
      toast.success("附加流量已购买");
      setSelected(null);
      utils.plans.mySubscriptions.invalidate();
      utils.billing.me.invalidate();
      utils.billing.ledger.invalidate();
      utils.dashboard.userTraffic.invalidate();
    },
    onError: (error) => toast.error(error.message || "购买附加流量失败"),
  });

  const closeRenewDialog = () => {
    setRenewingSub(null);
    setDiscountCode("");
    setDiscountPreview(null);
  };

  const createOrder = trpc.payment.createOrder.useMutation({
    onSuccess: (order) => {
      toast.success("续费订单已创建");
      closeRenewDialog();
      utils.payment.myOrders.invalidate();
      utils.plans.mySubscriptions.invalidate();
      utils.billing.me.invalidate();
      utils.billing.ledger.invalidate();
      if (order?.payUrl) window.open(order.payUrl, "_blank", "noopener,noreferrer");
    },
    onError: (error) => toast.error(error.message || "创建续费订单失败"),
  });

  const renewWithBalance = trpc.billing.purchasePlanWithBalance.useMutation({
    onSuccess: () => {
      toast.success("套餐已续费");
      closeRenewDialog();
      utils.plans.mySubscriptions.invalidate();
      utils.billing.me.invalidate();
      utils.billing.ledger.invalidate();
      utils.dashboard.userTraffic.invalidate();
    },
    onError: (error) => toast.error(error.message || "续费失败"),
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

  const openRenew = (sub: any) => {
    const firstMethod = paymentMethods[0]?.value as "alipay" | "wxpay" | "stripe" | undefined;
    if (firstMethod) setPaymentType(firstMethod);
    setPayMode(firstMethod ? "gateway" : "balance");
    setDiscountCode("");
    setDiscountPreview(null);
    setRenewingSub(sub);
  };

  const confirmRenew = () => {
    if (!renewingSub?.planId) return;
    const planId = Number(renewingSub.planId);
    const code = billingFeatures?.discountEnabled ? discountCode.trim() || undefined : undefined;
    if (payMode === "balance") {
      renewWithBalance.mutate({ planId, discountCode: code });
      return;
    }
    createOrder.mutate({
      amount: Number(renewingSub.priceCents || 0) / 100,
      paymentType,
      planId,
      discountCode: code,
    });
  };

  const selectedPrice = Number(selected?.addon?.priceCents || 0);
  const balanceCents = wallet?.balanceCents == null ? null : Number(wallet.balanceCents);
  const balanceReady = !walletLoading && balanceCents !== null;
  const balance = balanceCents ?? 0;
  const balanceEnough = balanceReady && balance >= selectedPrice;
  const renewingPrice = Number(renewingSub?.priceCents || 0);
  const renewFinalAmountCents = Number(discountPreview?.finalAmountCents ?? renewingPrice);
  const renewBalanceEnough = balanceReady && balance >= renewFinalAmountCents;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">我的订阅</h1>
            <p className="text-sm text-muted-foreground">已购买和已分配的套餐。</p>
          </div>
          <Badge variant="outline" className="w-fit gap-1.5 px-3 py-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
            {activeCount} 个生效套餐
          </Badge>
        </div>

        {isLoading && (
          <DataSectionLoading label="正在加载订阅数据" />
        )}

        {!isLoading && subscriptions.length === 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Package className="h-5 w-5" /> 暂无订阅</CardTitle>
              <CardDescription>当前账户还没有套餐记录。</CardDescription>
            </CardHeader>
            {storeStatus?.enabled && (
              <CardFooter>
                <Button onClick={() => setLocation("/store")}>
                  <ShoppingBag className="mr-2 h-4 w-4" /> 去商店购买
                </Button>
              </CardFooter>
            )}
          </Card>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          {subscriptions.map((sub: any) => {
            const isActive = sub.status === "active" && (!sub.expiresAt || new Date(sub.expiresAt) > new Date());
            const addons = isActive && Number(sub.trafficLimit || 0) > 0 ? (sub.trafficAddons || []) : [];
            const currentAddonBytes = Number(sub.activeTrafficAddonBytes || 0);
            const validUntil = cycleEnd(sub);
            const canRenew = !!storeStatus?.enabled && !!sub.planId && sub.status !== "cancelled";

            return (
              <Card key={sub.id} className="flex flex-col">
                <CardHeader>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <CardTitle className="flex items-center gap-2 truncate">
                        <Package className="h-5 w-5 shrink-0" />
                        <span className="truncate">{sub.planName || `套餐 #${sub.planId}`}</span>
                      </CardTitle>
                      <CardDescription className="mt-2">{sourceLabel(sub.source)}</CardDescription>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                      <Badge variant={isActive ? "default" : "secondary"}>{statusLabel(sub.status)}</Badge>
                      {canRenew && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => openRenew(sub)}
                          disabled={createOrder.isPending || renewWithBalance.isPending}
                        >
                          <CreditCard className="mr-2 h-3.5 w-3.5" />
                          续费
                        </Button>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="flex-1 space-y-4">
                  <div className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
                    <div className="rounded-md border border-border/50 p-3">
                      <div className="text-xs">端口段</div>
                      <div className="mt-1 font-medium text-foreground">{sub.portRangeStart && sub.portRangeEnd ? `${sub.portRangeStart}-${sub.portRangeEnd}` : "---"}</div>
                    </div>
                    <div className="rounded-md border border-border/50 p-3">
                      <div className="text-xs">可用资源</div>
                      <div className="mt-1 font-medium text-foreground">{planResourceText(sub)}</div>
                    </div>
                    <div className="rounded-md border border-border/50 p-3">
                      <div className="text-xs">套餐流量</div>
                      <div className="mt-1 font-medium text-foreground">{bytes(sub.trafficLimit)}</div>
                    </div>
                    <div className="rounded-md border border-border/50 p-3">
                      <div className="text-xs">本周期附加</div>
                      <div className="mt-1 font-medium text-foreground">{currentAddonBytes > 0 ? bytes(currentAddonBytes) : "---"}</div>
                    </div>
                    <div className="rounded-md border border-border/50 p-3">
                      <div className="text-xs">限速</div>
                      <div className="mt-1 font-medium text-foreground">{speed(sub.rateLimitMbps)}</div>
                    </div>
                  </div>

                  <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                    <div className="flex items-center gap-2">
                      <CalendarClock className="h-3.5 w-3.5" />
                      到期：{dateTime(sub.expiresAt)}
                    </div>
                    <div className="flex items-center gap-2">
                      <Gauge className="h-3.5 w-3.5" />
                      下次流量周期：{dateTime(sub.nextTrafficResetAt)}
                    </div>
                  </div>

                  {addons.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-sm font-medium">购买附加流量</div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {addons.map((addon: any) => (
                          <Button
                            key={addon.id}
                            type="button"
                            variant="outline"
                            className="h-auto justify-between gap-3 px-3 py-2"
                            onClick={() => setSelected({ sub, addon })}
                            disabled={purchaseAddon.isPending}
                          >
                            <span className="font-medium">{bytes(addon.trafficBytes)}</span>
                            <span className="text-muted-foreground">{money(addon.priceCents)}</span>
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}

                  {isActive && Number(sub.trafficLimit || 0) > 0 && addons.length === 0 && (
                    <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                      暂无可购买的附加流量包
                    </div>
                  )}
                </CardContent>
                {isActive && validUntil && (
                  <CardFooter className="text-xs text-muted-foreground">
                    本周期附加流量有效至 {dateTime(validUntil)}
                  </CardFooter>
                )}
              </Card>
            );
          })}
        </div>

        <Dialog open={!!renewingSub} onOpenChange={(open) => !open && closeRenewDialog()}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CreditCard className="h-5 w-5" />
                续费套餐
              </DialogTitle>
              <DialogDescription>
                再次购买 {renewingSub?.planName || "当前套餐"} 会延长当前订阅有效期。
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4">
              <div className="rounded-lg border bg-muted/20 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">原价</span>
                  <span>{money(renewingPrice, renewingSub?.currency || "CNY")}</span>
                </div>
                {discountPreview && (
                  <div className="mt-1 flex items-center justify-between text-emerald-600">
                    <span>优惠</span>
                    <span>-{money(discountPreview.discountAmountCents, renewingSub?.currency || "CNY")}</span>
                  </div>
                )}
                <div className="mt-2 flex items-center justify-between font-medium">
                  <span>应付</span>
                  <span>{money(renewFinalAmountCents, renewingSub?.currency || "CNY")}</span>
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>当前到期</span>
                  <span>{dateTime(renewingSub?.expiresAt)}</span>
                </div>
              </div>

              {billingFeatures?.discountEnabled && (
                <div className="flex gap-2">
                  <Input value={discountCode} onChange={(e) => setDiscountCode(e.target.value.toUpperCase())} placeholder="折扣码（可选）" />
                  <Button
                    variant="outline"
                    onClick={() => renewingSub && previewDiscount.mutate({ code: discountCode, amountCents: renewingPrice, planId: Number(renewingSub.planId) })}
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
                      value={money(balance)}
                      loading={walletLoading}
                      cacheKey="subscriptions.wallet.balance.inline"
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
              <Button variant="outline" onClick={closeRenewDialog}>取消</Button>
              <Button
                onClick={confirmRenew}
                disabled={
                  !renewingSub ||
                  createOrder.isPending ||
                  renewWithBalance.isPending ||
                  (payMode === "gateway" && paymentMethods.length === 0) ||
                  (payMode === "balance" && (walletLoading || !renewBalanceEnough))
                }
              >
                {(createOrder.isPending || renewWithBalance.isPending) ? <RefreshCw className="forwardx-icon-spin mr-2 h-4 w-4" /> : <ShoppingBag className="mr-2 h-4 w-4" />}
                {payMode === "balance" ? (walletLoading ? "余额加载中" : renewBalanceEnough ? "余额续费" : "余额不足") : "去支付"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <WalletCards className="h-5 w-5" />
                购买附加流量
              </DialogTitle>
              <DialogDescription>
                {selected?.sub?.planName || "当前套餐"} · {selected ? bytes(selected.addon.trafficBytes) : "-"}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between rounded-lg border p-3">
                <span className="text-muted-foreground">价格</span>
                <span className="font-medium">{money(selected?.addon?.priceCents)}</span>
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3">
                <span className="text-muted-foreground">余额</span>
                <AnimatedStatValue
                  as="span"
                  value={money(balance)}
                  loading={walletLoading}
                  cacheKey="subscriptions.wallet.balance.addon"
                  fallbackValue={money(0)}
                  className={balanceEnough ? "font-medium" : "font-medium text-destructive"}
                />
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3">
                <span className="text-muted-foreground">有效期</span>
                <span className="font-medium">{dateTime(selected ? cycleEnd(selected.sub) : null)}</span>
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setSelected(null)}>取消</Button>
              <Button
                onClick={() => selected && purchaseAddon.mutate({ addonId: Number(selected.addon.id), subscriptionId: Number(selected.sub.id) })}
                disabled={!selected || purchaseAddon.isPending || walletLoading || !balanceEnough}
              >
                {purchaseAddon.isPending ? <RefreshCw className="forwardx-icon-spin mr-2 h-4 w-4" /> : <ShoppingBag className="mr-2 h-4 w-4" />}
                {walletLoading ? "余额加载中" : balanceEnough ? "余额购买" : "余额不足"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
