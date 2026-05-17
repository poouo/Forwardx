import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { CheckCircle2, CreditCard, Lock, Package, RefreshCw, ShoppingBag } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

function money(cents?: number, currency = "CNY") {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency }).format((cents || 0) / 100);
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

const durationOptions = [
  { value: 30, label: "一个月" },
  { value: 90, label: "三个月" },
  { value: 180, label: "半年" },
  { value: 365, label: "一年" },
  { value: 730, label: "两年" },
];

function durationLabel(days?: number | null) {
  return durationOptions.find((item) => item.value === Number(days))?.label || `${days || 30} 天`;
}

export default function Store() {
  const utils = trpc.useUtils();
  const { data: storeStatus } = trpc.plans.storeStatus.useQuery();
  const { data: plans = [], isLoading } = trpc.plans.storeList.useQuery();
  const { data: subscriptions = [] } = trpc.plans.mySubscriptions.useQuery();
  const { data: paymentMethods = [] } = trpc.payment.availableMethods.useQuery(undefined, {
    enabled: !!storeStatus?.enabled,
  });
  const [selectedPlan, setSelectedPlan] = useState<any | null>(null);
  const [paymentType, setPaymentType] = useState<"alipay" | "wxpay" | "stripe">("stripe");

  const createOrder = trpc.payment.createOrder.useMutation({
    onSuccess: (order) => {
      toast.success("订单已创建");
      setSelectedPlan(null);
      utils.plans.mySubscriptions.invalidate();
      if (order?.payUrl) window.open(order.payUrl, "_blank", "noopener,noreferrer");
    },
    onError: (error) => toast.error(error.message || "创建订单失败"),
  });

  const buy = (plan: any) => {
    const firstMethod = paymentMethods[0]?.value as "alipay" | "wxpay" | "stripe" | undefined;
    if (!firstMethod) {
      toast.error("当前没有可用的支付方式，请联系管理员");
      return;
    }
    setPaymentType(firstMethod);
    setSelectedPlan(plan);
  };

  const confirmBuy = () => {
    if (!selectedPlan) return;
    createOrder.mutate({
      amount: Number(selectedPlan.priceCents || 0) / 100,
      paymentType,
      planId: selectedPlan.id,
    });
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 p-4 sm:p-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">商店</h1>
          <p className="text-sm text-muted-foreground">购买套餐后会自动获得对应主机和隧道权限，并分配连续端口段。</p>
        </div>

        {!storeStatus?.enabled && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Lock className="h-5 w-5" /> 商店暂未开启</CardTitle>
              <CardDescription>当前只能由管理员在后台手动分配套餐或权限。</CardDescription>
            </CardHeader>
          </Card>
        )}

        {subscriptions.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><CheckCircle2 className="h-5 w-5 text-emerald-600" /> 我的订阅</CardTitle>
              <CardDescription>有效订阅会和手动权限叠加生效。</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {subscriptions.map((sub: any) => (
                <div key={sub.id} className="rounded-lg border bg-background/60 p-4">
                  <div className="font-medium">{sub.planName || `套餐 #${sub.planId}`}</div>
                  <div className="mt-2 text-sm text-muted-foreground">端口段 {sub.portRangeStart}-{sub.portRangeEnd}</div>
                  <div className="text-sm text-muted-foreground">到期 {sub.expiresAt ? new Date(sub.expiresAt).toLocaleString() : "永久"}</div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {storeStatus?.enabled && (
          <>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {plans.map((plan: any) => (
                <Card key={plan.id} className="flex flex-col">
                  <CardHeader>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <CardTitle className="flex items-center gap-2"><Package className="h-5 w-5" /> {plan.name}</CardTitle>
                        <CardDescription className="mt-2 line-clamp-2">{plan.description || "订阅后自动分配权限和端口段"}</CardDescription>
                      </div>
                      <Badge>{durationLabel(plan.durationDays)}</Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="flex-1 space-y-3">
                    <div className="text-3xl font-semibold">{money(plan.priceCents, plan.currency)}</div>
                    <div className="grid gap-2 text-sm text-muted-foreground">
                      <div>连续端口：{plan.portCount} 个</div>
                      <div>总流量：{bytes(plan.trafficLimit)}</div>
                      {Number(plan.durationDays || 0) > 30 && Number(plan.trafficLimit || 0) > 0 && (
                        <div>流量周期：购买日起按月重置</div>
                      )}
                      <div>限速：{speed(plan.rateLimitMbps)}</div>
                      <div>规则：最多 {plan.maxRules || "不限"} 条</div>
                      <div>连接：最多 {plan.maxConnections || "不限"}，单 IP {plan.maxIPs || "不限"}</div>
                      <div>限制口径：端口转发按主机，隧道转发按隧道</div>
                      <div>资源：{plan.hostIds?.length || 0} 台主机 / {plan.tunnelIds?.length || 0} 条隧道</div>
                    </div>
                  </CardContent>
                  <CardFooter>
                    <Button className="w-full" onClick={() => buy(plan)} disabled={createOrder.isPending}>
                      <ShoppingBag className="mr-2 h-4 w-4" /> 购买套餐
                    </Button>
                  </CardFooter>
                </Card>
              ))}
              {!isLoading && plans.length === 0 && (
                <Card className="md:col-span-2 xl:col-span-3">
                  <CardHeader>
                    <CardTitle>暂无可购买套餐</CardTitle>
                    <CardDescription>请等待管理员上架套餐，或联系管理员手动分配。</CardDescription>
                  </CardHeader>
                </Card>
              )}
            </div>
          </>
        )}

        <Dialog open={!!selectedPlan} onOpenChange={(open) => !open && setSelectedPlan(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CreditCard className="h-5 w-5" />
                选择支付方式
              </DialogTitle>
              <DialogDescription>
                购买 {selectedPlan?.name || "套餐"}，金额 {selectedPlan ? money(selectedPlan.priceCents, selectedPlan.currency) : "-"}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              {paymentMethods.map((method: any) => (
                <button
                  key={method.value}
                  type="button"
                  onClick={() => setPaymentType(method.value)}
                  className={`flex items-center justify-between rounded-lg border px-4 py-3 text-left transition-colors ${
                    paymentType === method.value
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border/60 bg-background/60 hover:bg-muted/60"
                  }`}
                >
                  <span className="font-medium">{method.label}</span>
                  {paymentType === method.value && <CheckCircle2 className="h-4 w-4" />}
                </button>
              ))}
              {paymentMethods.length === 0 && (
                <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  当前没有可用的支付方式，请联系管理员。
                </div>
              )}
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setSelectedPlan(null)}>取消</Button>
              <Button onClick={confirmBuy} disabled={createOrder.isPending || paymentMethods.length === 0}>
                {createOrder.isPending ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <ShoppingBag className="mr-2 h-4 w-4" />}
                去支付
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
