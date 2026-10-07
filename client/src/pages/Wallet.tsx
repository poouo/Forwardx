import { getFormatLocale } from "@/i18n";
import { t as translateText } from "@/i18n";
import { useAuth } from "@/_core/hooks/useAuth";
import AnimatedStatValue from "@/components/AnimatedStatValue";
import DashboardLayout from "@/components/DashboardLayout";
import DataSectionLoading from "@/components/DataSectionLoading";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { CheckCircle2, CreditCard, Gift, Package, ReceiptText, RefreshCw, WalletCards } from "lucide-react";
import { useState } from "react";
import { toast } from "@/lib/localizedToast";

type PaymentType = "alipay" | "wxpay" | "stripe" | "usdt";

function money(cents?: number | null, currency = "CNY") {
  return new Intl.NumberFormat(getFormatLocale(), { style: "currency", currency }).format((Number(cents) || 0) / 100);
}

function dateText(value?: string | Date | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString(getFormatLocale());
}

function orderTypeText(type?: string | null) {
  if (type === "plan") return translateText("套餐");
  if (type === "test") return translateText("测试");
  return translateText("余额");
}

function paymentMethodText(type?: string | null) {
  if (type === "alipay") return translateText("支付宝");
  if (type === "wxpay") return translateText("微信支付");
  if (type === "stripe") return "Stripe";
  if (type === "usdt" || type === "gmpay") return "USDT";
  return type || "-";
}

function balanceTypeText(type?: string | null) {
  if (type === "admin_recharge") return translateText("管理员充值");
  if (type === "admin_adjust") return translateText("管理员修改");
  if (type === "payment") return translateText("在线充值入账");
  if (type === "purchase") return translateText("余额消费");
  if (type === "redeem") return translateText("兑换入账");
  if (type === "traffic_billing") return translateText("流量计费");
  if (type === "traffic_addon_purchase") return translateText("购买附加流量");
  return type || translateText("余额变动");
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

export default function Wallet() {
  const utils = trpc.useUtils();
  const { user } = useAuth();
  const { data: wallet, isLoading: walletLoading } = trpc.billing.me.useQuery(undefined, { placeholderData: (previousData) => previousData });
  const { data: ledger = [], isLoading: ledgerLoading } = trpc.billing.ledger.useQuery({ limit: 150 }, { placeholderData: (previousData) => previousData });
  const { data: billingFeatures } = trpc.billing.featureStatus.useQuery(undefined, { placeholderData: (previousData) => previousData });
  const { data: paymentOrders = [], isLoading: paymentOrdersLoading } = trpc.payment.myOrders.useQuery({ limit: 50 }, { placeholderData: (previousData: any) => previousData });
  const { data: paymentMethods = [] } = trpc.payment.availableMethods.useQuery(undefined, { placeholderData: (previousData) => previousData });
  const [rechargeOpen, setRechargeOpen] = useState(false);
  const [amount, setAmount] = useState("50");
  const [paymentType, setPaymentType] = useState<PaymentType>("stripe");
  const [redeemCode, setRedeemCode] = useState("");

  const createOrder = trpc.payment.createOrder.useMutation({
    onSuccess: (order) => {
      toast.success(translateText("充值订单已创建"));
      setRechargeOpen(false);
      utils.payment.myOrders.invalidate();
      utils.billing.ledger.invalidate();
      if (order?.payUrl) window.open(order.payUrl, "_blank", "noopener,noreferrer");
    },
    onError: (error) => toast.error(error.message || translateText("创建订单失败")),
  });

  const redeem = trpc.billing.redeem.useMutation({
    onSuccess: () => {
      toast.success(translateText("兑换成功"));
      setRedeemCode("");
      utils.billing.me.invalidate();
      utils.billing.ledger.invalidate();
      utils.plans.mySubscriptions.invalidate();
    },
    onError: (error) => toast.error(error.message || translateText("兑换失败")),
  });

  const openRecharge = () => {
    const first = paymentMethods[0]?.value as PaymentType | undefined;
    if (first) setPaymentType(first);
    setRechargeOpen(true);
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{translateText("账单中心")}</h1>
            <p className="text-sm text-muted-foreground">{translateText("余额、充值和订单记录。")}</p>
          </div>
          <Button onClick={openRecharge}>
            <CreditCard className="mr-2 h-4 w-4" />{translateText("自助充值")}</Button>
        </div>

        <div className={`grid gap-4 ${billingFeatures?.redemptionEnabled ? "md:grid-cols-2" : ""}`}>
          <Card>
            <CardHeader>
              <CardDescription>{translateText("当前余额")}</CardDescription>
              <AnimatedStatValue
                as={CardTitle}
                value={money(wallet?.balanceCents)}
                loading={walletLoading}
                cacheKey={`wallet.balance.${user?.id || "current"}`}
                fallbackValue={money(0)}
                className="text-4xl"
              />
            </CardHeader>
          </Card>

          {billingFeatures?.redemptionEnabled && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Gift className="h-5 w-5" />{translateText("兑换码")}</CardTitle>
                <CardDescription>{translateText("输入兑换码即可使用。")}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 sm:flex-row">
                <Input
                  value={redeemCode}
                  onChange={(event) => setRedeemCode(event.target.value.toUpperCase())}
                  placeholder={translateText("输入兑换码")}
                />
                <Button onClick={() => redeem.mutate({ code: redeemCode.trim() })} disabled={!redeemCode.trim() || redeem.isPending}>
                  {redeem.isPending ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}{translateText("兑换")}</Button>
              </CardContent>
            </Card>
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ReceiptText className="h-5 w-5" />{translateText("账单流水")}</CardTitle>
            <CardDescription>{translateText("按时间查看全部记录。")}</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {ledgerLoading ? (
              <DataSectionLoading label={translateText("正在加载账单流水")} />
            ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{translateText("项目")}</TableHead>
                  <TableHead>{translateText("类型")}</TableHead>
                  <TableHead>{translateText("金额")}</TableHead>
                  <TableHead>{translateText("状态")}</TableHead>
                  <TableHead>{translateText("关联信息")}</TableHead>
                  <TableHead>{translateText("时间")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ledger.map((item: any) => {
                  const Icon = ledgerIcon(item);
                  return (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div className="flex min-w-56 items-start gap-3">
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
                      <TableCell>
                        <Badge variant={item.status === "completed" || item.status === "paid" || item.status === "active" ? "default" : "secondary"}>
                          {item.statusLabel || item.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {item.paymentOrderNo || item.tradeNo || (item.planId ? `plan#${item.planId}` : "-")}
                      </TableCell>
                      <TableCell>{dateText(item.createdAt)}</TableCell>
                    </TableRow>
                  );
                })}
                {ledger.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">{translateText("暂无账单流水")}</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <WalletCards className="h-5 w-5" />{translateText("余额流水")}</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {walletLoading ? (
              <DataSectionLoading label={translateText("正在加载余额流水")} />
            ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{translateText("类型")}</TableHead>
                  <TableHead>{translateText("金额")}</TableHead>
                  <TableHead>{translateText("余额")}</TableHead>
                  <TableHead>{translateText("说明")}</TableHead>
                  <TableHead>{translateText("时间")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(wallet?.transactions || []).map((tx: any) => (
                  <TableRow key={tx.id}>
                    <TableCell>
                      <Badge variant="outline">{tx.typeLabel || balanceTypeText(tx.type)}</Badge>
                    </TableCell>
                    <TableCell className={Number(tx.amountCents) >= 0 ? "text-emerald-600" : "text-destructive"}>
                      {money(tx.amountCents)}
                    </TableCell>
                    <TableCell>{money(tx.balanceAfterCents)}</TableCell>
                    <TableCell>{tx.description || "-"}</TableCell>
                    <TableCell>{dateText(tx.createdAt)}</TableCell>
                  </TableRow>
                ))}
                {(!wallet?.transactions || wallet.transactions.length === 0) && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">{translateText("暂无余额流水")}</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CreditCard className="h-5 w-5" />{translateText("支付流水")}</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {paymentOrdersLoading ? (
              <DataSectionLoading label={translateText("正在加载支付流水")} />
            ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{translateText("订单号")}</TableHead>
                  <TableHead>{translateText("类型")}</TableHead>
                  <TableHead>{translateText("支付方式")}</TableHead>
                  <TableHead>{translateText("金额")}</TableHead>
                  <TableHead>{translateText("状态")}</TableHead>
                  <TableHead>{translateText("时间")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paymentOrders.map((order: any) => (
                  <TableRow key={order.id}>
                    <TableCell className="font-mono text-xs">{order.outTradeNo}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{orderTypeText(order.orderType)}</Badge>
                    </TableCell>
                    <TableCell>{paymentMethodText(order.paymentType || order.provider)}</TableCell>
                    <TableCell>{money(order.amountCents, order.currency || "CNY")}</TableCell>
                    <TableCell>
                      <Badge variant={order.status === "completed" || order.status === "paid" ? "default" : "secondary"}>
                        {order.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{dateText(order.createdAt)}</TableCell>
                  </TableRow>
                ))}
                {paymentOrders.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">{translateText("暂无支付流水")}</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            )}
          </CardContent>
        </Card>

        <Dialog open={rechargeOpen} onOpenChange={setRechargeOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{translateText("自助充值")}</DialogTitle>
              <DialogDescription>{translateText("充值成功后自动入账。")}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>{translateText("充值金额")}</Label>
                <Input type="number" min={0.01} step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{translateText("支付方式")}</Label>
                <Select value={paymentType} onValueChange={(value: PaymentType) => setPaymentType(value)}>
                  <SelectTrigger>
                    <SelectValue placeholder={translateText("选择支付方式")} />
                  </SelectTrigger>
                  <SelectContent>
                    {paymentMethods.map((method: any) => (
                      <SelectItem key={method.value} value={method.value}>
                        {method.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRechargeOpen(false)}>{translateText("取消")}</Button>
              <Button
                onClick={() => createOrder.mutate({ amount: Number(amount), paymentType, returnPath: "/wallet" })}
                disabled={!amount || paymentMethods.length === 0 || createOrder.isPending}
              >
                {createOrder.isPending ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <CreditCard className="mr-2 h-4 w-4" />}{translateText("去支付")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
