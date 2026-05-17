import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { CheckCircle2, CreditCard, Lock, Package, ShoppingBag } from "lucide-react";
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

export default function Store() {
  const utils = trpc.useUtils();
  const { data: storeStatus } = trpc.plans.storeStatus.useQuery();
  const { data: plans = [], isLoading } = trpc.plans.storeList.useQuery();
  const { data: subscriptions = [] } = trpc.plans.mySubscriptions.useQuery();
  const [paymentType, setPaymentType] = useState("stripe");

  const createOrder = trpc.payment.createOrder.useMutation({
    onSuccess: (order) => {
      toast.success("订单已创建");
      utils.plans.mySubscriptions.invalidate();
      if (order?.payUrl) window.open(order.payUrl, "_blank", "noopener,noreferrer");
    },
    onError: (error) => toast.error(error.message || "创建订单失败"),
  });

  const buy = (plan: any) => {
    createOrder.mutate({
      amount: Number(plan.priceCents || 0) / 100,
      paymentType: paymentType as any,
      planId: plan.id,
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
            <div className="flex max-w-xs items-center gap-2">
              <CreditCard className="h-4 w-4 text-muted-foreground" />
              <Select value={paymentType} onValueChange={setPaymentType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="stripe">Stripe</SelectItem>
                  <SelectItem value="alipay">支付宝</SelectItem>
                  <SelectItem value="wxpay">微信支付</SelectItem>
                  <SelectItem value="epay">易支付</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {plans.map((plan: any) => (
                <Card key={plan.id} className="flex flex-col">
                  <CardHeader>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <CardTitle className="flex items-center gap-2"><Package className="h-5 w-5" /> {plan.name}</CardTitle>
                        <CardDescription className="mt-2 line-clamp-2">{plan.description || "订阅后自动分配权限和端口段"}</CardDescription>
                      </div>
                      <Badge>{plan.durationDays || "永久"} 天</Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="flex-1 space-y-3">
                    <div className="text-3xl font-semibold">{money(plan.priceCents, plan.currency)}</div>
                    <div className="grid gap-2 text-sm text-muted-foreground">
                      <div>连续端口：{plan.portCount} 个</div>
                      <div>总流量：{bytes(plan.trafficLimit)}</div>
                      <div>限速：{speed(plan.rateLimitMbps)}</div>
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
      </div>
    </DashboardLayout>
  );
}
