import { getFormatLocale } from "@/i18n";
import { t as translateText } from "@/i18n";
import DashboardLayout from "@/components/DashboardLayout";
import PaymentCheckoutDialog from "@/components/PaymentCheckoutDialog";
import { PlanPurchaseQuantity, planPurchaseQuote, discountQuoteKey } from "@/components/PlanPurchaseQuantity";
import { PlanBillingCycleSelect } from "@/components/PlanBillingCycleSelect";
import { planBillingCycles } from "@shared/planPurchase";
import { SubscriptionStatusTabs, type SubscriptionListStatus } from "@/components/SubscriptionStatusTabs";
import type { CheckoutOrder } from "@/lib/paymentCheckout";
import AnimatedStatValue from "@/components/AnimatedStatValue";
import { PlanTrafficModeBadge } from "@/components/PlanTrafficMode";
import { subscriptionPortRangeText } from "@/lib/planDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import DataSectionLoading from "@/components/DataSectionLoading";
import { useAuth } from "@/_core/hooks/useAuth";
import { planResourceText } from "@/lib/planDisplay";
import { pollingInterval } from "@/lib/polling";
import { trafficQuotaBreakdown, type TrafficQuotaSourceKind } from "@/lib/trafficQuota";
import { trpc } from "@/lib/trpc";
import { CalendarClock, CheckCircle2, CreditCard, Gauge, Minus, Package, Plus, RefreshCw, ShoppingBag, TicketPercent, WalletCards } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "@/lib/localizedToast";
import { useLocation } from "wouter";
import { BILLING_DATE_TIME_FORMAT_OPTIONS } from "@shared/billingTime";
import { MAX_TRAFFIC_ADDON_QUANTITY, trafficAddonPurchaseTotals } from "@shared/trafficAddonPurchase";

function money(cents?: number | null, currency = "CNY") {
  return new Intl.NumberFormat(getFormatLocale(), { style: "currency", currency }).format((Number(cents) || 0) / 100);
}

function bytes(size?: number | null) {
  const value = Number(size || 0);
  if (!value) return translateText("不限");
  const gigabytes = value / (1024 ** 3);
  return `${parseFloat(gigabytes.toFixed(2))} GB`;
}

function speed(value?: number | null) {
  const num = Number(value || 0);
  return num > 0 ? `${parseFloat(num.toFixed(2))} Mbps` : translateText("不限");
}

function dateTime(value?: string | Date | null) {
  if (!value) return "---";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "---";
  return date.toLocaleString(getFormatLocale());
}

function billingDateTime(value?: string | Date | null) {
  if (!value) return "---";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "---";
  return date.toLocaleString(getFormatLocale(), BILLING_DATE_TIME_FORMAT_OPTIONS);
}

function statusLabel(status?: string) {
  if (status === "active") return translateText("生效中");
  if (status === "expired") return translateText("已过期");
  if (status === "cancelled") return translateText("已取消");
  return status || "-";
}

function sourceLabel(source?: string) {
  if (source === "admin") return translateText("后台分配");
  if (source === "payment") return translateText("在线购买");
  if (source === "redeem") return translateText("兑换套餐");
  if (source === "balance") return translateText("余额购买");
  return source || "-";
}

function cycleEnd(sub: any) {
  return sub?.nextTrafficResetAt || sub?.expiresAt || null;
}

function quotaSourceLabel(kind: TrafficQuotaSourceKind) {
  if (kind === "manual") return translateText("手工额度");
  if (kind === "addon") return translateText("已购附加流量");
  if (kind === "grant") return translateText("管理员加赠");
  return translateText("套餐额度");
}

export default function Subscriptions() {
  const utils = trpc.useUtils();
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { data: storeStatus } = trpc.plans.storeStatus.useQuery();
  const { data: wallet, isLoading: walletLoading } = trpc.billing.me.useQuery();
  const { data: billingFeatures } = trpc.billing.featureStatus.useQuery();
  const { data: subscriptions = [], isLoading } = trpc.plans.mySubscriptions.useQuery();
  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionListStatus>("active");
  const hasRenewableSubscription = subscriptions.some((sub: any) =>
    sub.status !== "cancelled"
    && sub.source === "admin"
    && (sub.allowSelfRenew === true || Number(sub.allowSelfRenew) === 1),
  );
  const { data: paymentMethods = [] } = trpc.payment.availableMethods.useQuery(undefined, {
    enabled: !!storeStatus?.enabled || hasRenewableSubscription,
  });
  const { data: userTraffic = [] } = trpc.dashboard.userTraffic.useQuery(undefined, {
    refetchInterval: pollingInterval("slow"),
    placeholderData: (previousData) => previousData,
  });
  const [selected, setSelected] = useState<{ sub: any; addon: any } | null>(null);
  const [addonQuantity, setAddonQuantity] = useState("1");
  const [renewingSub, setRenewingSub] = useState<any | null>(null);
  const [renewQuantity, setRenewQuantity] = useState("1");
  const [renewalCycleDays, setRenewalCycleDays] = useState<number | undefined>();
  const [paymentType, setPaymentType] = useState<"alipay" | "wxpay" | "stripe" | "usdt">("stripe");
  const [payMode, setPayMode] = useState<"gateway" | "balance">("gateway");
  const [discountCode, setDiscountCode] = useState("");
  const [discountPreview, setDiscountPreview] = useState<any | null>(null);

  const now = Date.now();
  const isActive = (sub: (typeof subscriptions)[number]) =>
    sub.status === "active" && (!sub.expiresAt || new Date(sub.expiresAt).getTime() > now);
  const activeSubscriptions = subscriptions.filter(isActive);
  const activeCount = activeSubscriptions.length;
  const visibleSubscriptions = subscriptionStatus === "active" ? activeSubscriptions
    : subscriptions.filter((sub) => sub.status === "expired" || (sub.status === "active" && !isActive(sub)));
  const currentUserTraffic = useMemo(
    () => userTraffic.find((item: any) => Number(item.id) === Number(user?.id)) || user,
    [user, userTraffic],
  );
  const quota = useMemo(
    () => trafficQuotaBreakdown(currentUserTraffic, subscriptions),
    [currentUserTraffic, subscriptions],
  );
  const effectiveTrafficLimit = quota.unlimited
    ? 0
    : Number(currentUserTraffic?.trafficLimit || 0) || quota.totalBytes;

  const purchaseAddon = trpc.billing.purchaseTrafficAddonWithBalance.useMutation({
    onSuccess: () => {
      toast.success(translateText("附加流量已购买"));
      setSelected(null);
      utils.plans.mySubscriptions.invalidate();
      utils.billing.me.invalidate();
      utils.billing.ledger.invalidate();
      utils.billing.ledgerPage.invalidate();
      utils.billing.listTransactionsPage.invalidate();
      utils.dashboard.userTraffic.invalidate();
    },
    onError: (error) => toast.error(error.message || translateText("购买附加流量失败")),
  });

  const closeRenewDialog = () => {
    setRenewingSub(null);
    setDiscountCode("");
    setDiscountPreview(null);
  };

  const [checkoutOrder, setCheckoutOrder] = useState<CheckoutOrder | null>(null);
  const createOrder = trpc.payment.createOrder.useMutation({
    onSuccess: (order) => {
      toast.success(translateText("续费订单已创建"));
      closeRenewDialog();
      utils.payment.myOrders.invalidate();
      utils.plans.mySubscriptions.invalidate();
      utils.billing.me.invalidate();
      utils.billing.ledger.invalidate();
      utils.billing.ledgerPage.invalidate();
      utils.billing.listTransactionsPage.invalidate();
      setCheckoutOrder(order || null);
    },
    onError: (error) => toast.error(error.message || translateText("创建续费订单失败")),
  });

  const renewWithBalance = trpc.billing.purchasePlanWithBalance.useMutation({
    onSuccess: () => {
      toast.success(translateText("套餐已续费"));
      closeRenewDialog();
      utils.plans.mySubscriptions.invalidate();
      utils.billing.me.invalidate();
      utils.billing.ledger.invalidate();
      utils.billing.ledgerPage.invalidate();
      utils.billing.listTransactionsPage.invalidate();
      utils.dashboard.userTraffic.invalidate();
    },
    onError: (error) => toast.error(error.message || translateText("续费失败")),
  });

  const previewDiscount = trpc.billing.previewDiscount.useMutation({
    onSuccess: (data, variables) => {
      setDiscountPreview({ ...data, quoteKey: discountQuoteKey(variables.planId, variables.amountCents, variables.code) });
      toast.success(translateText("折扣码已应用"));
    },
    onError: (error) => {
      setDiscountPreview(null);
      toast.error(error.message || translateText("折扣码不可用"));
    },
  });

  const openRenew = (sub: any) => {
    const firstMethod = paymentMethods[0]?.value as "alipay" | "wxpay" | "stripe" | "usdt" | undefined;
    if (firstMethod) setPaymentType(firstMethod);
    setPayMode(firstMethod ? "gateway" : "balance");
    setDiscountCode("");
    setDiscountPreview(null);
    setRenewQuantity("1");
    setRenewalCycleDays(undefined);
    setRenewingSub(sub);
  };

  const confirmRenew = () => {
    if (!renewingSub?.planId || !renewTotals) return;
    const planId = Number(renewingSub.planId);
    const code = billingFeatures?.discountEnabled ? discountCode.trim() || undefined : undefined;
    if (payMode === "balance" || freeRenewal) {
      renewWithBalance.mutate({
        planId,
        subscriptionId: Number(renewingSub.id),
        quantity: renewTotals.quantity,
        billingCycleDays: selectedRenewalCycleDays,
        discountCode: code,
      });
      return;
    }
    createOrder.mutate({
      amount: Math.max(0.01, renewTotals.priceCents / 100),
      quantity: renewTotals.quantity,
      billingCycleDays: selectedRenewalCycleDays,
      paymentType,
      planId,
      subscriptionId: Number(renewingSub.id),
      discountCode: code,
      returnPath: "/subscriptions",
    });
  };

  const addonTotals = useMemo(() => {
    if (!selected) return null;
    try {
      return trafficAddonPurchaseTotals(Number(selected.addon.trafficBytes), Number(selected.addon.priceCents), Number(addonQuantity));
    } catch { return null; }
  }, [selected, addonQuantity]);
  const balanceCents = wallet?.balanceCents == null ? null : Number(wallet.balanceCents);
  const balanceReady = !walletLoading && balanceCents !== null;
  const balance = balanceCents ?? 0;
  const balanceEnough = balanceReady && !!addonTotals && balance >= addonTotals.priceCents;
  const selectedRenewalCycleDays = renewalCycleDays ?? Number(renewingSub?.durationDays || 0);
  const renewalCycles = renewingSub ? planBillingCycles(renewingSub) : [];
  const permitsMultiple = renewalCycles.length > 1;
  const renewTotals = planPurchaseQuote(renewingSub, permitsMultiple ? renewQuantity : "1", selectedRenewalCycleDays);
  const renewingPrice = renewTotals?.priceCents ?? 0;
  const appliedDiscount = billingFeatures?.discountEnabled && discountPreview?.quoteKey === discountQuoteKey(Number(renewingSub?.planId), renewTotals?.priceCents, discountCode) ? discountPreview : null;
  const renewFinalAmountCents = Number(appliedDiscount?.finalAmountCents ?? renewingPrice);
  const freeRenewal = !!renewTotals && renewFinalAmountCents === 0;
  const renewBalanceEnough = balanceReady && balance >= renewFinalAmountCents;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="pearl-page-header flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{translateText("我的订阅")}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="w-fit gap-1.5 px-3 py-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
              {activeCount}{translateText(" 个生效套餐")}</Badge>
          </div>
        </div>

        {!isLoading && quota.hasQuota && (
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 border-y border-border/50 py-3 sm:flex sm:flex-wrap sm:items-center sm:gap-x-8">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{translateText("当前总额度")}</p>
              <p className="mt-0.5 truncate text-sm font-semibold tabular-nums">
                {quota.unlimited ? translateText("不限") : bytes(effectiveTrafficLimit)}
              </p>
            </div>
            {quota.sources.map((source) => (
              <div key={source.kind} className="min-w-0">
                <p className="text-xs text-muted-foreground">{quotaSourceLabel(source.kind)}</p>
                <p className="mt-0.5 truncate text-sm font-medium tabular-nums">
                  {source.unlimited ? translateText("不限") : bytes(source.bytes)}
                </p>
              </div>
            ))}
          </div>
        )}

        <SubscriptionStatusTabs value={subscriptionStatus} onChange={setSubscriptionStatus}>
        {isLoading && (
          <DataSectionLoading label={translateText("正在加载订阅数据")} />
        )}

        {!isLoading && visibleSubscriptions.length === 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Package className="h-5 w-5" />{translateText(subscriptionStatus === "active" ? "暂无有效订阅" : "暂无过期订阅")}</CardTitle>
            </CardHeader>
            {subscriptionStatus === "active" && storeStatus?.enabled && (
              <CardFooter>
                <Button onClick={() => setLocation("/store")}>
                  <ShoppingBag className="mr-2 h-4 w-4" />{translateText(" 去商店购买")}</Button>
              </CardFooter>
            )}
          </Card>
        )}

        <div className="grid items-start gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {visibleSubscriptions.map((sub: any) => {
            const isActive = subscriptionStatus === "active";
            const addons = isActive && Number(sub.trafficLimit || 0) > 0 ? (sub.trafficAddons || []) : [];
            const currentAddonBytes = Number(sub.activeTrafficAddonBytes || 0);
            const purchasedAddonBytes = Number(sub.purchasedTrafficAddonBytes || 0);
            const grantedAddonBytes = Number(sub.grantedTrafficAddonBytes || 0);
            const validUntil = cycleEnd(sub);
            const allowSelfRenew = sub.allowSelfRenew === true || Number(sub.allowSelfRenew) === 1;
            const canRenew = !!sub.planId && sub.status !== "cancelled"
              && ((!!storeStatus?.enabled && (sub.source === "payment" || sub.source === "balance"))
                || (sub.source === "admin" && allowSelfRenew));
            const requiresAdminRenewal = sub.status !== "cancelled"
              && (sub.source === "redeem" || (sub.source === "admin" && !allowSelfRenew));

            return (
              <Card key={sub.id} className="flex min-w-0 flex-col" data-subscription-card="true">
                <CardHeader className="p-4 pb-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="flex items-center gap-2 text-base">
                        <Package className="h-4 w-4 shrink-0" />
                        <span className="truncate">{sub.planName || translateText("套餐 #{0}", [sub.planId])}</span>
                      </CardTitle>
                      <CardDescription className="mt-1 text-xs">{sourceLabel(sub.source)}</CardDescription>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                      <Badge variant={isActive ? "default" : "secondary"}>{statusLabel(subscriptionStatus)}</Badge>
                      {canRenew && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => openRenew(sub)}
                          disabled={createOrder.isPending || renewWithBalance.isPending}
                        >
                          <CreditCard className="mr-2 h-3.5 w-3.5" />{translateText("续费")}</Button>
                      )}
                      {requiresAdminRenewal && (
                        <span className="text-xs text-muted-foreground">{translateText("请联系管理员续期")}</span>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 px-4 pb-4">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg bg-muted/30 p-3 text-sm text-muted-foreground">
                    <div className="min-w-0">
                      <div className="text-xs">{translateText("端口段")}</div>
                      <div className="mt-1 break-words font-medium text-foreground">{subscriptionPortRangeText(sub)}</div>
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs">{translateText("可用资源")}</div>
                      <div className="mt-1 break-words font-medium text-foreground">{planResourceText(sub)}</div>
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs">{translateText("套餐额度")}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 font-medium text-foreground">{bytes(sub.trafficLimit)}<PlanTrafficModeBadge mode={sub.trafficMode} /></div>
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs">{translateText("限速")}</div>
                      <div className="mt-1 font-medium text-foreground">{speed(sub.rateLimitMbps)}</div>
                    </div>
                  </div>

                  {(purchasedAddonBytes > 0 || grantedAddonBytes > 0) && (
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {purchasedAddonBytes > 0 && <span>{translateText("已购附加流量")} <span className="font-medium text-foreground">{bytes(purchasedAddonBytes)}</span></span>}
                      {grantedAddonBytes > 0 && <span>{translateText("管理员加赠")} <span className="font-medium text-foreground">{bytes(grantedAddonBytes)}</span></span>}
                    </div>
                  )}

                  {addons.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-xs font-medium text-muted-foreground">{translateText("购买附加流量")}</div>
                      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-2">
                        {addons.map((addon: any) => (
                          <Button
                            key={addon.id}
                            type="button"
                            variant="outline"
                            className="h-9 min-w-0 justify-between gap-2 px-3 text-xs"
                            onClick={() => { setAddonQuantity("1"); setSelected({ sub, addon }); }}
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
                    <div className="text-xs text-muted-foreground">{translateText("暂无可购买的附加流量包")}</div>
                  )}
                  {isActive && currentAddonBytes > 0 && validUntil && (
                    <p className="text-xs text-muted-foreground">{translateText("本周期附加流量有效至 ")}{dateTime(validUntil)}</p>
                  )}
                  <div className="space-y-2 border-t border-border/50 pt-3 text-xs text-muted-foreground">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <span className="flex items-center gap-1.5"><Gauge className="h-3.5 w-3.5 shrink-0" />{translateText("下次流量周期：")}</span>
                      <span className="tabular-nums">{billingDateTime(sub.nextTrafficResetAt)}</span>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <span className="flex items-center gap-1.5"><CalendarClock className="h-3.5 w-3.5 shrink-0" />{translateText("到期：")}</span>
                      <span className="tabular-nums">{dateTime(sub.expiresAt)}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        </SubscriptionStatusTabs>
        <Dialog open={!!renewingSub} onOpenChange={(open) => !open && closeRenewDialog()}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CreditCard className="h-5 w-5" />{translateText("续费套餐")}</DialogTitle>
              <DialogDescription>{translateText("再次购买 ")}{renewingSub?.planName || translateText("当前套餐")}{translateText(" 会延长当前订阅有效期。")}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4">
              {renewingSub && <PlanBillingCycleSelect options={renewalCycles} value={selectedRenewalCycleDays} currency={renewingSub.currency || undefined}
                onChange={(days) => { setRenewalCycleDays(days); setDiscountPreview(null); }} disabled={createOrder.isPending || renewWithBalance.isPending} />}
              {permitsMultiple && <PlanPurchaseQuantity value={renewQuantity} onChange={(value) => { setRenewQuantity(value); setDiscountPreview(null); }}
                durationDays={selectedRenewalCycleDays} valid={!!renewTotals} disabled={createOrder.isPending || renewWithBalance.isPending} />}
              <div className="rounded-lg border bg-muted/20 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{translateText("套餐金额")}</span>
                  <span>{money(renewingPrice, renewingSub?.currency || "CNY")}</span>
                </div>
                {appliedDiscount && (
                  <div className="mt-1 flex items-center justify-between text-emerald-600">
                    <span>{translateText("优惠")}</span>
                    <span>-{money(appliedDiscount.discountAmountCents, renewingSub?.currency || "CNY")}</span>
                  </div>
                )}
                <div className="mt-2 flex items-center justify-between font-medium">
                  <span>{translateText("应付")}</span>
                  <span>{money(renewFinalAmountCents, renewingSub?.currency || "CNY")}</span>
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{translateText("当前到期")}</span>
                  <span>{dateTime(renewingSub?.expiresAt)}</span>
                </div>
              </div>

              {billingFeatures?.discountEnabled && (
                <div className="flex gap-2">
                  <Input value={discountCode} onChange={(e) => { setDiscountCode(e.target.value.toUpperCase()); setDiscountPreview(null); }} placeholder={translateText("折扣码（可选）")} />
                  <Button
                    variant="outline"
                    onClick={() => renewingSub && previewDiscount.mutate({ code: discountCode, amountCents: renewingPrice, planId: Number(renewingSub.planId) })}
                    disabled={!renewTotals || !discountCode.trim() || previewDiscount.isPending}
                  >
                    <TicketPercent className="mr-2 h-4 w-4" />{translateText(" 应用")}</Button>
                </div>
              )}

              {!freeRenewal && <div className="grid gap-2">
                <button
                  type="button"
                  onClick={() => setPayMode("balance")}
                  disabled={walletLoading}
                  className={`flex items-center justify-between rounded-lg border px-4 py-3 text-left transition-colors ${
                    payMode === "balance" ? "border-primary bg-primary/10 text-primary" : "border-border/60 bg-background/60 hover:bg-muted/60"
                  } disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  <span className="flex items-center gap-2 font-medium">
                    <WalletCards className="h-4 w-4" />{translateText("余额支付（")}<AnimatedStatValue
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
                  <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{translateText("暂无在线支付方式。")}</div>
                )}
              </div>}
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={closeRenewDialog}>{translateText("取消")}</Button>
              <Button
                onClick={confirmRenew}
                disabled={
                  !renewingSub || !renewTotals || previewDiscount.isPending ||
                  createOrder.isPending ||
                  renewWithBalance.isPending ||
                  (!freeRenewal && (payMode === "gateway" ? paymentMethods.length === 0 : walletLoading || !renewBalanceEnough))
                }
              >
                {(createOrder.isPending || renewWithBalance.isPending) ? <RefreshCw className="forwardx-icon-spin mr-2 h-4 w-4" /> : <ShoppingBag className="mr-2 h-4 w-4" />}
                {freeRenewal ? translateText("确认续费") : payMode === "balance" ? (walletLoading ? translateText("余额加载中") : renewBalanceEnough ? translateText("余额续费") : translateText("余额不足")) : translateText("去支付")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <WalletCards className="h-5 w-5" />{translateText("购买附加流量")}</DialogTitle>
              <DialogDescription>
                {selected?.sub?.planName || translateText("当前套餐")} · {selected ? bytes(selected.addon.trafficBytes) : "-"}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <div className="space-y-2 rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="traffic-addon-quantity">{translateText("购买数量")}</Label>
                  <span id="traffic-addon-quantity-help" className="text-xs text-muted-foreground">{translateText("单次最多 {0} 份", [MAX_TRAFFIC_ADDON_QUANTITY])}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" size="icon" className="shrink-0" aria-label={translateText("减少购买数量")}
                    disabled={purchaseAddon.isPending || Number(addonQuantity) <= 1}
                    onClick={() => setAddonQuantity(String(Math.max(1, Math.min(MAX_TRAFFIC_ADDON_QUANTITY, (Number(addonQuantity) || 1) - 1))))}>
                    <Minus className="h-4 w-4" />
                  </Button>
                  <div className="relative min-w-0 flex-1">
                    <Input id="traffic-addon-quantity" type="number" inputMode="numeric" min={1} max={MAX_TRAFFIC_ADDON_QUANTITY} step={1}
                      value={addonQuantity} onChange={(event) => setAddonQuantity(event.target.value)} disabled={purchaseAddon.isPending}
                      aria-invalid={!addonTotals} aria-describedby="traffic-addon-quantity-help"
                      className="px-9 text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
                    <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-muted-foreground">{translateText("份")}</span>
                  </div>
                  <Button type="button" variant="outline" size="icon" className="shrink-0" aria-label={translateText("增加购买数量")}
                    disabled={purchaseAddon.isPending || Number(addonQuantity) >= MAX_TRAFFIC_ADDON_QUANTITY}
                    onClick={() => setAddonQuantity(String(Math.min(MAX_TRAFFIC_ADDON_QUANTITY, Math.max(1, (Number(addonQuantity) || 0) + 1))))}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="space-y-2 rounded-lg border p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="shrink-0 text-muted-foreground">{translateText("单价")}</span>
                  <span className="min-w-0 break-words text-right font-medium">{money(selected?.addon?.priceCents)}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="shrink-0 text-muted-foreground">{translateText("总流量")}</span>
                  <span className="min-w-0 break-words text-right font-medium">{addonTotals ? bytes(addonTotals.trafficBytes) : "—"}</span>
                </div>
                <div className="flex items-center justify-between gap-3 border-t pt-2">
                  <span className="shrink-0 text-muted-foreground">{translateText("合计金额")}</span>
                  <span className="min-w-0 break-words text-right font-semibold">{addonTotals ? money(addonTotals.priceCents) : "—"}</span>
                </div>
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3">
                <span className="text-muted-foreground">{translateText("余额")}</span>
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
                <span className="text-muted-foreground">{translateText("有效期")}</span>
                <span className="font-medium">{dateTime(selected ? cycleEnd(selected.sub) : null)}</span>
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setSelected(null)}>{translateText("取消")}</Button>
              <Button
                onClick={() => selected && addonTotals && purchaseAddon.mutate({ addonId: Number(selected.addon.id), subscriptionId: Number(selected.sub.id), quantity: addonTotals.quantity })}
                disabled={!selected || !addonTotals || purchaseAddon.isPending || walletLoading || !balanceEnough}
              >
                {purchaseAddon.isPending ? <RefreshCw className="forwardx-icon-spin mr-2 h-4 w-4" /> : <ShoppingBag className="mr-2 h-4 w-4" />}
                {!addonTotals ? translateText("请选择有效数量") : walletLoading ? translateText("余额加载中") : balanceEnough ? translateText("余额购买") : translateText("余额不足")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      <PaymentCheckoutDialog order={checkoutOrder} onClose={() => setCheckoutOrder(null)} />
    </DashboardLayout>
  );
}
