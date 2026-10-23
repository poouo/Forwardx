import { t as translateText } from "@/i18n";
import DashboardLayout from "@/components/DashboardLayout";
import PaymentCheckoutDialog from "@/components/PaymentCheckoutDialog";
import type { CheckoutOrder } from "@/lib/paymentCheckout";
import AnimatedStatValue from "@/components/AnimatedStatValue";
import DataSectionLoading from "@/components/DataSectionLoading";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { SlidingTabsList, type SlidingTabItem } from "@/components/ui/sliding-tabs";
import { Textarea } from "@/components/ui/textarea";
import { useUrlTab } from "@/hooks/useUrlTab";
import { trpc } from "@/lib/trpc";
import {
  CheckCircle2,
  CircleDollarSign,
  Copy,
  CreditCard,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  WalletCards,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "@/lib/localizedToast";

type PaymentConfigForm = {
  enabled: boolean;
  productName: string;
  minAmount: number;
  maxAmount: number;
  orderTimeoutMinutes: number;
  maxPendingOrders: number;
  routes: {
    alipay: "easypay" | "alipay";
    wxpay: "easypay" | "wxpay";
  };
  easypay: {
    enabled: boolean;
    apiBase: string;
    pid: string;
    pkey: string;
    mode: "redirect" | "api";
    cidAlipay: string;
    cidWxpay: string;
  };
  alipay: {
    enabled: boolean;
    appId: string;
    privateKey: string;
    publicKey: string;
    gateway: string;
    mode: "precreate" | "page" | "wap";
  };
  wxpay: {
    enabled: boolean;
    appId: string;
    mchId: string;
    privateKey: string;
    apiV3Key: string;
    certSerial: string;
    publicKey: string;
    publicKeyId: string;
    mode: "native" | "h5" | "jsapi";
    h5AppName: string;
    h5AppUrl: string;
  };
  stripe: {
    enabled: boolean;
    secretKey: string;
    publishableKey: string;
    webhookSecret: string;
    currency: string;
  };
  gmpay: {
    enabled: boolean;
    apiBase: string;
    pid: string;
    secretKey: string;
    network: "tron" | "ethereum" | "bsc" | "polygon" | "solana" | "aptos" | "plasma";
  };
};

type PaymentTab = "basic" | "easypay" | "alipay" | "wxpay" | "stripe" | "gmpay" | "test";
const PAYMENT_TABS = ["basic", "easypay", "alipay", "wxpay", "stripe", "gmpay", "test"] as const;
const PAYMENT_TAB_ITEMS = [
  { value: "basic", label: translateText("基础设置") },
  { value: "easypay", label: translateText("易支付") },
  { value: "alipay", label: translateText("支付宝官方") },
  { value: "wxpay", label: translateText("微信官方") },
  { value: "stripe", label: "Stripe" },
  { value: "gmpay", label: "USDT" },
  { value: "test", label: translateText("测试下单") },
] as const satisfies readonly SlidingTabItem<PaymentTab>[];
const PAYMENT_TAB_STORAGE_KEY = "forwardx.payments.tab";

const emptyForm: PaymentConfigForm = {
  enabled: false,
  productName: "ForwardX 充值",
  minAmount: 1,
  maxAmount: 0,
  orderTimeoutMinutes: 30,
  maxPendingOrders: 3,
  routes: {
    alipay: "easypay",
    wxpay: "easypay",
  },
  easypay: {
    enabled: false,
    apiBase: "",
    pid: "",
    pkey: "",
    mode: "redirect",
    cidAlipay: "",
    cidWxpay: "",
  },
  alipay: {
    enabled: false,
    appId: "",
    privateKey: "",
    publicKey: "",
    gateway: "https://openapi.alipay.com/gateway.do",
    mode: "precreate",
  },
  wxpay: {
    enabled: false,
    appId: "",
    mchId: "",
    privateKey: "",
    apiV3Key: "",
    certSerial: "",
    publicKey: "",
    publicKeyId: "",
    mode: "native",
    h5AppName: "",
    h5AppUrl: "",
  },
  stripe: {
    enabled: false,
    secretKey: "",
    publishableKey: "",
    webhookSecret: "",
    currency: "cny",
  },
  gmpay: {
    enabled: false,
    apiBase: "",
    pid: "",
    secretKey: "",
    network: "tron",
  },
};

function formatMoney(amountCents?: number | null, currency = "CNY") {
  const value = Number(amountCents || 0) / 100;
  return `${value.toFixed(2)} ${currency.toUpperCase()}`;
}

function PaymentStatCard({
  label,
  value,
  icon: Icon,
  tone = "text-sky-600 dark:text-sky-400",
  loading = false,
  cacheKey,
  fallbackValue,
  action,
}: {
  label: string;
  value: string | number;
  icon: React.ElementType;
  tone?: string;
  loading?: boolean;
  cacheKey: string;
  fallbackValue?: string | number;
  action?: React.ReactNode;
}) {
  return (
    <Card hoverable className="group relative overflow-hidden border-border/40 bg-card/60">
      <div className={`absolute inset-0 opacity-[0.04] transition-opacity group-hover:opacity-[0.08] ${tone}`} />
      <CardContent className="relative flex min-h-[82px] items-center justify-between gap-4 p-4 sm:p-5">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <AnimatedStatValue
            as="p"
            value={value}
            loading={loading}
            cacheKey={cacheKey}
            fallbackValue={fallbackValue}
            className="mt-1.5 truncate text-2xl font-bold leading-none tracking-tight tabular-nums"
          />
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <Icon className={`h-5 w-5 shrink-0 ${tone}`} />
          {action}
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function CallbackItem({ label, value }: { label: string; value: string }) {
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    toast.success(translateText("已复制"));
  };
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border bg-background/70 px-3 py-2">
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate text-xs">{value}</code>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={copy}>
          <Copy className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

export default function Payments() {
  const utils = trpc.useUtils();
  const { data: config, isLoading } = trpc.payment.getConfig.useQuery(undefined, { placeholderData: (previousData) => previousData });
  const { data: stats, isLoading: statsLoading } = trpc.payment.stats.useQuery(undefined, { refetchInterval: 30_000, placeholderData: (previousData) => previousData });
  const { data: settings } = trpc.system.getSettings.useQuery();
  const [form, setForm] = useState<PaymentConfigForm>(emptyForm);
  const [amount, setAmount] = useState("10");
  const [paymentType, setPaymentType] = useState<"alipay" | "wxpay" | "stripe" | "usdt">("alipay");
  const [checkoutOrder, setCheckoutOrder] = useState<CheckoutOrder | null>(null);
  const [activeTab, setActiveTab] = useUrlTab<PaymentTab>({
    values: PAYMENT_TABS,
    defaultValue: "basic",
    storageKey: PAYMENT_TAB_STORAGE_KEY,
  });

  useEffect(() => {
    if (!config) return;
    setForm({
      enabled: config.enabled,
      productName: config.productName,
      minAmount: config.minAmount,
      maxAmount: config.maxAmount,
      orderTimeoutMinutes: config.orderTimeoutMinutes,
      maxPendingOrders: config.maxPendingOrders,
      routes: {
        alipay: config.routes?.alipay || "easypay",
        wxpay: config.routes?.wxpay || "easypay",
      },
      easypay: {
        enabled: config.easypay.enabled,
        apiBase: config.easypay.apiBase || "",
        pid: config.easypay.pid || "",
        pkey: "",
        mode: config.easypay.mode || "redirect",
        cidAlipay: config.easypay.cidAlipay || "",
        cidWxpay: config.easypay.cidWxpay || "",
      },
      alipay: {
        enabled: config.alipay?.enabled || false,
        appId: config.alipay?.appId || "",
        privateKey: "",
        publicKey: "",
        gateway: config.alipay?.gateway || "https://openapi.alipay.com/gateway.do",
        mode: config.alipay?.mode || "precreate",
      },
      wxpay: {
        enabled: config.wxpay?.enabled || false,
        appId: config.wxpay?.appId || "",
        mchId: config.wxpay?.mchId || "",
        privateKey: "",
        apiV3Key: "",
        certSerial: config.wxpay?.certSerial || "",
        publicKey: "",
        publicKeyId: config.wxpay?.publicKeyId || "",
        mode: config.wxpay?.mode || "native",
        h5AppName: config.wxpay?.h5AppName || "",
        h5AppUrl: config.wxpay?.h5AppUrl || "",
      },
      stripe: {
        enabled: config.stripe.enabled,
        secretKey: "",
        publishableKey: config.stripe.publishableKey || "",
        webhookSecret: "",
        currency: config.stripe.currency || "cny",
      },
      gmpay: {
        enabled: config.gmpay?.enabled || false,
        apiBase: config.gmpay?.apiBase || "",
        pid: config.gmpay?.pid || "",
        secretKey: "",
        network: config.gmpay?.network || "tron",
      },
    });
  }, [config]);

  const panelUrl = useMemo(() => {
    const configured = settings?.panelPublicUrl?.trim();
    if (configured) return configured.replace(/\/+$/, "");
    if (typeof window !== "undefined") return window.location.origin;
    return "";
  }, [settings?.panelPublicUrl]);

  const updateConfig = trpc.payment.updateConfig.useMutation({
    onSuccess: () => {
      toast.success(translateText("支付配置已保存"));
      utils.payment.getConfig.invalidate();
    },
    onError: (error) => toast.error(error.message || translateText("保存失败")),
  });

  const testGmPayGateway = trpc.payment.testGmPayGateway.useMutation({
    onSuccess: (result) => {
      if (result.supportsUsdt) {
        toast.success(translateText("GM Pay 连接正常{0}", [result.version ? `（${result.version}）` : ""]));
      } else {
        toast.error(translateText("{0} 当前未启用 USDT", [result.networkLabel]));
      }
    },
    onError: (error) => toast.error(error.message || translateText("GM Pay 网关检测失败")),
  });

  const createOrder = trpc.payment.createOrder.useMutation({
    onSuccess: (order) => {
      toast.success(translateText("测试订单已创建"));
      utils.billing.ledgerPage.invalidate();
      utils.payment.stats.invalidate();
      setCheckoutOrder(order || null);
    },
    onError: (error) => toast.error(error.message || translateText("创建订单失败")),
  });

  const save = () => {
    if (form.maxAmount > 0 && form.maxAmount < form.minAmount) {
      toast.error(translateText("最高金额不能小于最低金额"));
      return;
    }
    updateConfig.mutate({
      ...form,
      minAmount: Number(form.minAmount) || 0,
      maxAmount: Number(form.maxAmount) || 0,
      orderTimeoutMinutes: Number(form.orderTimeoutMinutes) || 30,
      maxPendingOrders: Number(form.maxPendingOrders) || 0,
    });
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="pearl-page-header flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{translateText("支付对接")}</h1>
          </div>
          <Button onClick={save} disabled={updateConfig.isPending || isLoading}>
            {updateConfig.isPending ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}{translateText("保存配置")}</Button>
        </div>

        <div className="grid gap-4 md:grid-cols-4">
          <PaymentStatCard
            label={translateText("支付状态")}
            value={form.enabled ? translateText("已启用") : translateText("未启用")}
            icon={ShieldCheck}
            tone={form.enabled ? "text-emerald-600 dark:text-emerald-400" : "text-sky-600 dark:text-sky-400"}
            loading={isLoading}
            cacheKey="payments.enabled"
            fallbackValue={translateText("未启用")}
            action={
              <span className="inline-flex" title={translateText("关闭后无法下单")}>
                <Switch
                  checked={form.enabled}
                  onCheckedChange={(enabled) => setForm((prev) => ({ ...prev, enabled }))}
                  disabled={isLoading || updateConfig.isPending}
                  aria-label={translateText("启用支付功能")}
                />
              </span>
            }
          />
          <PaymentStatCard
            label={translateText("已支付金额")}
            value={formatMoney(stats?.paidAmountCents)}
            icon={WalletCards}
            tone="text-violet-600 dark:text-violet-400"
            loading={statsLoading}
            cacheKey="payments.paidAmount"
            fallbackValue={formatMoney(0)}
          />
          <PaymentStatCard
            label={translateText("已支付订单")}
            value={stats?.paidOrders || 0}
            icon={CheckCircle2}
            tone="text-emerald-600 dark:text-emerald-400"
            loading={statsLoading}
            cacheKey="payments.paidOrders"
            fallbackValue={0}
          />
          <PaymentStatCard
            label={translateText("待支付订单")}
            value={stats?.pendingOrders || 0}
            icon={RefreshCw}
            tone="text-amber-600"
            loading={statsLoading}
            cacheKey="payments.pendingOrders"
            fallbackValue={0}
          />
        </div>

        <Alert className="border-primary/15 bg-primary/5 text-foreground">
          <ShieldCheck className="h-4 w-4" />
          <AlertTitle>{translateText("回调地址")}</AlertTitle>
          <AlertDescription>{translateText("当前使用 ")}{panelUrl || translateText("未配置")}。
          </AlertDescription>
        </Alert>

        {isLoading ? (
          <DataSectionLoading label={translateText("正在加载支付配置")} minHeight="min-h-[260px]" />
        ) : (
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as PaymentTab)}>
          <SlidingTabsList items={PAYMENT_TAB_ITEMS} activeValue={activeTab} onValueChange={setActiveTab} ariaLabel={translateText("支付对接")} minItemWidthRem={6.75} />

          <TabsContent value="basic" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle>{translateText("基础设置")}</CardTitle>
                <CardDescription>{translateText("用于商店套餐购买。")}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <Field label={translateText("商品名称")}>
                  <Input value={form.productName} onChange={(e) => setForm((prev) => ({ ...prev, productName: e.target.value }))} />
                </Field>
                <Field label={translateText("最低金额")}>
                  <Input type="number" min={0} step="0.01" value={form.minAmount} onChange={(e) => setForm((prev) => ({ ...prev, minAmount: Number(e.target.value) }))} />
                </Field>
                <Field label={translateText("最高金额")} hint={translateText("0 表示不限制")}>
                  <Input type="number" min={0} step="0.01" value={form.maxAmount} onChange={(e) => setForm((prev) => ({ ...prev, maxAmount: Number(e.target.value) }))} />
                </Field>
                <Field label={translateText("订单过期时间（分钟）")}>
                  <Input type="number" min={1} max={1440} value={form.orderTimeoutMinutes} onChange={(e) => setForm((prev) => ({ ...prev, orderTimeoutMinutes: Number(e.target.value) }))} />
                </Field>
                <Field label={translateText("最大待支付订单")} hint={translateText("0 表示不限制")}>
                  <Input type="number" min={0} max={100} value={form.maxPendingOrders} onChange={(e) => setForm((prev) => ({ ...prev, maxPendingOrders: Number(e.target.value) }))} />
                </Field>
                <Field label={translateText("支付宝按钮来源")} hint={translateText("用户侧仍显示为支付宝，后台决定使用哪条支付通道")}>
                  <Select value={form.routes.alipay} onValueChange={(alipay: "easypay" | "alipay") => setForm((prev) => ({ ...prev, routes: { ...prev.routes, alipay } }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="easypay">{translateText("易支付")}</SelectItem>
                      <SelectItem value="alipay">{translateText("支付宝官方")}</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={translateText("微信按钮来源")} hint={translateText("用户侧仍显示为微信，后台决定使用哪条支付通道")}>
                  <Select value={form.routes.wxpay} onValueChange={(wxpay: "easypay" | "wxpay") => setForm((prev) => ({ ...prev, routes: { ...prev.routes, wxpay } }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="easypay">{translateText("易支付")}</SelectItem>
                      <SelectItem value="wxpay">{translateText("微信官方")}</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="easypay" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><WalletCards className="h-5 w-5" />{translateText(" 易支付")}</CardTitle>
                <CardDescription>{translateText("兼容易支付接口。")}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="flex items-center justify-between rounded-lg border bg-background/70 px-4 py-3 md:col-span-2">
                  <div>
                    <div className="font-medium">{translateText("启用易支付")}</div>
                    <div className="text-sm text-muted-foreground">{translateText("支付宝、微信通道")}</div>
                  </div>
                  <Switch checked={form.easypay.enabled} onCheckedChange={(enabled) => setForm((prev) => ({ ...prev, easypay: { ...prev.easypay, enabled } }))} />
                </div>
                <Field label={translateText("接口地址")}>
                  <Input placeholder="https://pay.example.com" value={form.easypay.apiBase} onChange={(e) => setForm((prev) => ({ ...prev, easypay: { ...prev.easypay, apiBase: e.target.value } }))} />
                </Field>
                <Field label={translateText("商户 PID")}>
                  <Input value={form.easypay.pid} onChange={(e) => setForm((prev) => ({ ...prev, easypay: { ...prev.easypay, pid: e.target.value } }))} />
                </Field>
                <Field label={translateText("商户密钥")} hint={config?.easypay?.hasPkey ? translateText("已保存密钥，留空表示不修改") : translateText("尚未保存密钥")}>
                  <Input type="password" value={form.easypay.pkey} onChange={(e) => setForm((prev) => ({ ...prev, easypay: { ...prev.easypay, pkey: e.target.value } }))} />
                </Field>
                <Field label={translateText("下单方式")}>
                  <Select value={form.easypay.mode} onValueChange={(mode: "redirect" | "api") => setForm((prev) => ({ ...prev, easypay: { ...prev.easypay, mode } }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="redirect">{translateText("跳转支付")}</SelectItem>
                      <SelectItem value="api">{translateText("API 下单")}</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={translateText("支付宝通道 CID")} hint={translateText("可选")}>
                  <Input value={form.easypay.cidAlipay} onChange={(e) => setForm((prev) => ({ ...prev, easypay: { ...prev.easypay, cidAlipay: e.target.value } }))} />
                </Field>
                <Field label={translateText("微信通道 CID")} hint={translateText("可选")}>
                  <Input value={form.easypay.cidWxpay} onChange={(e) => setForm((prev) => ({ ...prev, easypay: { ...prev.easypay, cidWxpay: e.target.value } }))} />
                </Field>
                <div className="grid gap-3 md:col-span-2 md:grid-cols-2">
                  <CallbackItem label={translateText("异步通知地址")} value={`${panelUrl}/api/payment/webhook/easypay`} />
                  <CallbackItem label={translateText("同步返回地址")} value={`${panelUrl}/api/payment/return/easypay`} />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="alipay" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><WalletCards className="h-5 w-5" />{translateText(" 支付宝官方")}</CardTitle>
                <CardDescription>{translateText("支付宝官方接口。")}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="flex items-center justify-between rounded-lg border bg-background/70 px-4 py-3 md:col-span-2">
                  <div>
                    <div className="font-medium">{translateText("启用支付宝官方")}</div>
                    <div className="text-sm text-muted-foreground">{translateText("需在基础设置中选择")}</div>
                  </div>
                  <Switch checked={form.alipay.enabled} onCheckedChange={(enabled) => setForm((prev) => ({ ...prev, alipay: { ...prev.alipay, enabled } }))} />
                </div>
                <Field label="AppID">
                  <Input value={form.alipay.appId} onChange={(e) => setForm((prev) => ({ ...prev, alipay: { ...prev.alipay, appId: e.target.value } }))} />
                </Field>
                <Field label={translateText("网关地址")}>
                  <Input value={form.alipay.gateway} onChange={(e) => setForm((prev) => ({ ...prev, alipay: { ...prev.alipay, gateway: e.target.value } }))} />
                </Field>
                <Field label={translateText("支付模式")}>
                  <Select value={form.alipay.mode} onValueChange={(mode: "precreate" | "page" | "wap") => setForm((prev) => ({ ...prev, alipay: { ...prev.alipay, mode } }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="precreate">{translateText("扫码预下单")}</SelectItem>
                      <SelectItem value="page">{translateText("电脑网站支付")}</SelectItem>
                      <SelectItem value="wap">{translateText("手机网站支付")}</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <div className="hidden md:block" />
                <Field label={translateText("应用私钥")} hint={config?.alipay?.hasPrivateKey ? translateText("已保存私钥，留空表示不修改") : translateText("尚未保存私钥")}>
                  <Textarea className="min-h-32 font-mono text-xs" value={form.alipay.privateKey} onChange={(e) => setForm((prev) => ({ ...prev, alipay: { ...prev.alipay, privateKey: e.target.value } }))} />
                </Field>
                <Field label={translateText("支付宝公钥")} hint={config?.alipay?.hasPublicKey ? translateText("已保存公钥，留空表示不修改") : translateText("尚未保存公钥")}>
                  <Textarea className="min-h-32 font-mono text-xs" value={form.alipay.publicKey} onChange={(e) => setForm((prev) => ({ ...prev, alipay: { ...prev.alipay, publicKey: e.target.value } }))} />
                </Field>
                <div className="grid gap-3 md:col-span-2 md:grid-cols-2">
                  <CallbackItem label={translateText("异步通知地址")} value={`${panelUrl}/api/payment/webhook/alipay`} />
                  <CallbackItem label={translateText("同步返回地址")} value={`${panelUrl}/api/payment/return/alipay`} />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="wxpay" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><WalletCards className="h-5 w-5" />{translateText(" 微信官方")}</CardTitle>
                <CardDescription>{translateText("微信支付 APIv3。")}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="flex items-center justify-between rounded-lg border bg-background/70 px-4 py-3 md:col-span-2">
                  <div>
                    <div className="font-medium">{translateText("启用微信官方")}</div>
                    <div className="text-sm text-muted-foreground">{translateText("需在基础设置中选择")}</div>
                  </div>
                  <Switch checked={form.wxpay.enabled} onCheckedChange={(enabled) => setForm((prev) => ({ ...prev, wxpay: { ...prev.wxpay, enabled } }))} />
                </div>
                <Field label="AppID">
                  <Input value={form.wxpay.appId} onChange={(e) => setForm((prev) => ({ ...prev, wxpay: { ...prev.wxpay, appId: e.target.value } }))} />
                </Field>
                <Field label={translateText("商户号 MchID")}>
                  <Input value={form.wxpay.mchId} onChange={(e) => setForm((prev) => ({ ...prev, wxpay: { ...prev.wxpay, mchId: e.target.value } }))} />
                </Field>
                <Field label={translateText("商户证书序列号")}>
                  <Input value={form.wxpay.certSerial} onChange={(e) => setForm((prev) => ({ ...prev, wxpay: { ...prev.wxpay, certSerial: e.target.value } }))} />
                </Field>
                <Field label={translateText("微信支付公钥 ID")}>
                  <Input value={form.wxpay.publicKeyId} onChange={(e) => setForm((prev) => ({ ...prev, wxpay: { ...prev.wxpay, publicKeyId: e.target.value } }))} />
                </Field>
                <Field label={translateText("APIv3 密钥")} hint={config?.wxpay?.hasApiV3Key ? translateText("已保存密钥，留空表示不修改") : translateText("尚未保存密钥")}>
                  <Input type="password" value={form.wxpay.apiV3Key} onChange={(e) => setForm((prev) => ({ ...prev, wxpay: { ...prev.wxpay, apiV3Key: e.target.value } }))} />
                </Field>
                <Field label={translateText("支付模式")} hint={translateText("JSAPI 需要用户 OpenID，当前版本暂未开放前台 OAuth 流程")}>
                  <Select value={form.wxpay.mode} onValueChange={(mode: "native" | "h5" | "jsapi") => setForm((prev) => ({ ...prev, wxpay: { ...prev.wxpay, mode } }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="native">{translateText("Native 扫码")}</SelectItem>
                      <SelectItem value="h5">{translateText("H5 支付")}</SelectItem>
                      <SelectItem value="jsapi" disabled>JSAPI ({translateText("暂不支持")})</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={translateText("H5 应用名称")} hint={translateText("H5 支付可选")}>
                  <Input value={form.wxpay.h5AppName} onChange={(e) => setForm((prev) => ({ ...prev, wxpay: { ...prev.wxpay, h5AppName: e.target.value } }))} />
                </Field>
                <Field label={translateText("H5 应用 URL")} hint={translateText("H5 支付可选")}>
                  <Input value={form.wxpay.h5AppUrl} onChange={(e) => setForm((prev) => ({ ...prev, wxpay: { ...prev.wxpay, h5AppUrl: e.target.value } }))} />
                </Field>
                <Field label={translateText("商户 API 私钥")} hint={config?.wxpay?.hasPrivateKey ? translateText("已保存私钥，留空表示不修改") : translateText("尚未保存私钥")}>
                  <Textarea className="min-h-32 font-mono text-xs" value={form.wxpay.privateKey} onChange={(e) => setForm((prev) => ({ ...prev, wxpay: { ...prev.wxpay, privateKey: e.target.value } }))} />
                </Field>
                <Field label={translateText("微信支付公钥")} hint={config?.wxpay?.hasPublicKey ? translateText("已保存公钥，留空表示不修改") : translateText("尚未保存公钥")}>
                  <Textarea className="min-h-32 font-mono text-xs" value={form.wxpay.publicKey} onChange={(e) => setForm((prev) => ({ ...prev, wxpay: { ...prev.wxpay, publicKey: e.target.value } }))} />
                </Field>
                <div className="grid gap-3 md:col-span-2 md:grid-cols-2">
                  <CallbackItem label={translateText("异步通知地址")} value={`${panelUrl}/api/payment/webhook/wxpay`} />
                  <CallbackItem label={translateText("同步返回地址")} value={`${panelUrl}/api/payment/return/wxpay`} />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="stripe" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><CreditCard className="h-5 w-5" /> Stripe</CardTitle>
                <CardDescription>Stripe Checkout。</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="flex items-center justify-between rounded-lg border bg-background/70 px-4 py-3 md:col-span-2">
                  <div>
                    <div className="font-medium">{translateText("启用 Stripe")}</div>
                    <div className="text-sm text-muted-foreground">{translateText("银行卡和钱包支付")}</div>
                  </div>
                  <Switch checked={form.stripe.enabled} onCheckedChange={(enabled) => setForm((prev) => ({ ...prev, stripe: { ...prev.stripe, enabled } }))} />
                </div>
                <Field label="Secret Key" hint={config?.stripe?.hasSecretKey ? translateText("已保存密钥，留空表示不修改") : translateText("尚未保存密钥")}>
                  <Input type="password" placeholder="sk_live_..." value={form.stripe.secretKey} onChange={(e) => setForm((prev) => ({ ...prev, stripe: { ...prev.stripe, secretKey: e.target.value } }))} />
                </Field>
                <Field label="Publishable Key" hint={translateText("可选，用于前端展示或后续扩展")}>
                  <Input placeholder="pk_live_..." value={form.stripe.publishableKey} onChange={(e) => setForm((prev) => ({ ...prev, stripe: { ...prev.stripe, publishableKey: e.target.value } }))} />
                </Field>
                <Field label="Webhook Secret" hint={config?.stripe?.hasWebhookSecret ? translateText("已保存签名密钥，留空表示不修改") : translateText("尚未保存签名密钥")}>
                  <Input type="password" placeholder="whsec_..." value={form.stripe.webhookSecret} onChange={(e) => setForm((prev) => ({ ...prev, stripe: { ...prev.stripe, webhookSecret: e.target.value } }))} />
                </Field>
                <Field label={translateText("币种")}>
                  <Input value={form.stripe.currency} onChange={(e) => setForm((prev) => ({ ...prev, stripe: { ...prev.stripe, currency: e.target.value.toLowerCase() } }))} />
                </Field>
                <div className="md:col-span-2">
                  <CallbackItem label={translateText("Stripe Webhook 地址")} value={`${panelUrl}/api/payment/webhook/stripe`} />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="gmpay" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><CircleDollarSign className="h-5 w-5" /> USDT</CardTitle>
                <CardDescription>{translateText("GM Pay / Epusdt 托管收银台。")}</CardDescription>
              </CardHeader>
              <CardContent className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2">
                <div className="flex items-center justify-between rounded-lg border bg-background/70 px-4 py-3 md:col-span-2">
                  <div>
                    <div className="font-medium">{translateText("启用 USDT 支付")}</div>
                    <div className="text-sm text-muted-foreground">{translateText("通过独立部署的 GM Pay 网关收款")}</div>
                  </div>
                  <Switch checked={form.gmpay.enabled} onCheckedChange={(enabled) => setForm((prev) => ({ ...prev, gmpay: { ...prev.gmpay, enabled } }))} />
                </div>
                <Field label={translateText("网关地址")}>
                  <Input placeholder="https://pay.example.com" value={form.gmpay.apiBase} onChange={(e) => setForm((prev) => ({ ...prev, gmpay: { ...prev.gmpay, apiBase: e.target.value } }))} />
                </Field>
                <Field label={translateText("商户 PID")}>
                  <Input value={form.gmpay.pid} onChange={(e) => setForm((prev) => ({ ...prev, gmpay: { ...prev.gmpay, pid: e.target.value } }))} />
                </Field>
                <Field label={translateText("商户密钥")} hint={config?.gmpay?.hasSecretKey ? translateText("已保存密钥，留空表示不修改") : translateText("尚未保存密钥")}>
                  <Input type="password" value={form.gmpay.secretKey} onChange={(e) => setForm((prev) => ({ ...prev, gmpay: { ...prev.gmpay, secretKey: e.target.value } }))} />
                </Field>
                <Field label={translateText("USDT 网络")}>
                  <Select value={form.gmpay.network} onValueChange={(network: PaymentConfigForm["gmpay"]["network"]) => setForm((prev) => ({ ...prev, gmpay: { ...prev.gmpay, network } }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="tron">TRON（TRC20）</SelectItem>
                      <SelectItem value="ethereum">Ethereum（ERC20）</SelectItem>
                      <SelectItem value="bsc">BNB Smart Chain（BEP20）</SelectItem>
                      <SelectItem value="polygon">Polygon</SelectItem>
                      <SelectItem value="solana">Solana</SelectItem>
                      <SelectItem value="aptos">Aptos</SelectItem>
                      <SelectItem value="plasma">Plasma</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <div className="flex min-h-10 flex-wrap items-center justify-between gap-3 rounded-lg border bg-background/70 px-4 py-3 md:col-span-2">
                  <div className="flex min-w-0 items-center gap-2 text-sm">
                    {testGmPayGateway.data ? (
                      <>
                        <Badge variant="outline" className={testGmPayGateway.data.supportsUsdt ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-destructive/30 bg-destructive/5 text-destructive"}>
                          {testGmPayGateway.data.supportsUsdt ? translateText("USDT 可用") : translateText("USDT 不可用")}
                        </Badge>
                        <span className="truncate text-muted-foreground">
                          {testGmPayGateway.data.networkLabel}{testGmPayGateway.data.version ? ` · ${testGmPayGateway.data.version}` : ""}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">{translateText("尚未检测网关")}</span>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => testGmPayGateway.mutate({ apiBase: form.gmpay.apiBase, network: form.gmpay.network })}
                    disabled={!form.gmpay.apiBase.trim() || testGmPayGateway.isPending}
                  >
                    <RefreshCw className={`mr-2 h-4 w-4 ${testGmPayGateway.isPending ? "animate-spin" : ""}`} />{translateText("检测网关")}</Button>
                </div>
                <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 md:col-span-2 md:grid-cols-2">
                  <CallbackItem label={translateText("异步通知地址")} value={`${panelUrl}/api/payment/webhook/gmpay`} />
                  <CallbackItem label={translateText("同步返回地址")} value={`${panelUrl}/api/payment/return/gmpay`} />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="test" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle>{translateText("测试下单")}</CardTitle>
                <CardDescription>{translateText("创建测试订单。")}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-[1fr_1fr_auto]">
                <Field label={translateText("金额")}>
                  <Input type="number" min={0.01} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
                </Field>
                <Field label={translateText("支付方式")}>
                  <Select value={paymentType} onValueChange={(value: "alipay" | "wxpay" | "stripe" | "usdt") => setPaymentType(value)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="alipay">{translateText("支付宝")}</SelectItem>
                      <SelectItem value="wxpay">{translateText("微信")}</SelectItem>
                      <SelectItem value="stripe">Stripe</SelectItem>
                      <SelectItem value="usdt">USDT</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <div className="flex items-end">
                  <Button className="w-full" onClick={() => createOrder.mutate({ amount: Number(amount), paymentType, orderType: "test", returnPath: "/payments" })} disabled={createOrder.isPending}>
                    {createOrder.isPending ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <ExternalLink className="mr-2 h-4 w-4" />}{translateText("创建订单")}</Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
        )}

        <PaymentCheckoutDialog order={checkoutOrder} onClose={() => setCheckoutOrder(null)} />
      </div>
    </DashboardLayout>
  );
}
