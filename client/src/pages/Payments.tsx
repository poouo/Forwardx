import DashboardLayout from "@/components/DashboardLayout";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { SlidingTabsList, type SlidingTabItem } from "@/components/ui/sliding-tabs";
import { Textarea } from "@/components/ui/textarea";
import { useUrlTab } from "@/hooks/useUrlTab";
import { trpc } from "@/lib/trpc";
import {
  CheckCircle2,
  Copy,
  CreditCard,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  WalletCards,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

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
};

type PaymentTab = "basic" | "easypay" | "alipay" | "wxpay" | "stripe" | "test";
const PAYMENT_TABS = ["basic", "easypay", "alipay", "wxpay", "stripe", "test"] as const;
const PAYMENT_TAB_ITEMS = [
  { value: "basic", label: "基础设置" },
  { value: "easypay", label: "易支付" },
  { value: "alipay", label: "支付宝官方" },
  { value: "wxpay", label: "微信官方" },
  { value: "stripe", label: "Stripe" },
  { value: "test", label: "测试下单" },
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
};

function formatMoney(amountCents?: number | null, currency = "CNY") {
  const value = Number(amountCents || 0) / 100;
  return `${value.toFixed(2)} ${currency.toUpperCase()}`;
}

function formatDate(value: unknown) {
  if (!value) return "-";
  const date = value instanceof Date ? value : new Date(value as any);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function paymentTypeLabel(value: string) {
  if (value === "alipay") return "支付宝";
  if (value === "wxpay") return "微信";
  if (value === "stripe") return "Stripe";
  return value;
}

function providerLabel(value: string) {
  if (value === "easypay") return "易支付";
  if (value === "alipay") return "支付宝官方";
  if (value === "wxpay") return "微信官方";
  if (value === "stripe") return "Stripe";
  return value;
}

function statusBadge(status: string) {
  const text: Record<string, string> = {
    pending: "待支付",
    paid: "已支付",
    processing: "处理中",
    completed: "已完成",
    expired: "已过期",
    cancelled: "已取消",
    failed: "失败",
  };
  const tone = status === "paid" || status === "processing" || status === "completed"
    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
    : status === "pending"
      ? "border-amber-200 bg-amber-50 text-amber-700"
      : "border-slate-200 bg-slate-50 text-slate-600";
  return <Badge variant="outline" className={tone}>{text[status] || status}</Badge>;
}

function PaymentStatCard({
  label,
  value,
  icon: Icon,
  tone = "text-primary",
  loading = false,
  cacheKey,
  fallbackValue,
}: {
  label: string;
  value: string | number;
  icon: React.ElementType;
  tone?: string;
  loading?: boolean;
  cacheKey: string;
  fallbackValue?: string | number;
}) {
  return (
    <Card className="group relative overflow-hidden border-border/40 bg-card/60 backdrop-blur-md transition-all duration-300 hover:-translate-y-0.5 hover:border-border/70 hover:shadow-lg hover:shadow-primary/5">
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
        <Icon className={`h-5 w-5 shrink-0 ${tone}`} />
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
    toast.success("已复制");
  };
  return (
    <div className="rounded-lg border bg-background/70 px-3 py-2">
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

function MobileOrderInfoRow({
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

export default function Payments() {
  const utils = trpc.useUtils();
  const { data: config, isLoading } = trpc.payment.getConfig.useQuery();
  const { data: stats, isLoading: statsLoading } = trpc.payment.stats.useQuery(undefined, { refetchInterval: 30_000 });
  const { data: orders, isLoading: ordersLoading } = trpc.payment.listOrders.useQuery({ limit: 100 }, { refetchInterval: 30_000 });
  const { data: settings } = trpc.system.getSettings.useQuery();
  const [form, setForm] = useState<PaymentConfigForm>(emptyForm);
  const [amount, setAmount] = useState("10");
  const [paymentType, setPaymentType] = useState<"alipay" | "wxpay" | "stripe">("alipay");
  const [createdPayUrl, setCreatedPayUrl] = useState<string | null>(null);
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
      toast.success("支付配置已保存");
      utils.payment.getConfig.invalidate();
    },
    onError: (error) => toast.error(error.message || "保存失败"),
  });

  const createOrder = trpc.payment.createOrder.useMutation({
    onSuccess: (order) => {
      toast.success("测试订单已创建");
      setCreatedPayUrl(order?.payUrl || null);
      utils.payment.listOrders.invalidate();
      utils.payment.stats.invalidate();
    },
    onError: (error) => toast.error(error.message || "创建订单失败"),
  });

  const save = () => {
    if (form.maxAmount > 0 && form.maxAmount < form.minAmount) {
      toast.error("最高金额不能小于最低金额");
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
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">支付对接</h1>
            <p className="text-sm text-muted-foreground">配置支付方式和订单。</p>
          </div>
          <Button onClick={save} disabled={updateConfig.isPending || isLoading}>
            {updateConfig.isPending ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
            保存配置
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-4">
          <PaymentStatCard
            label="支付状态"
            value={form.enabled ? "已启用" : "未启用"}
            icon={ShieldCheck}
            tone={form.enabled ? "text-emerald-600" : "text-muted-foreground"}
            loading={isLoading}
            cacheKey="payments.enabled"
            fallbackValue="未启用"
          />
          <PaymentStatCard
            label="已支付金额"
            value={formatMoney(stats?.paidAmountCents)}
            icon={WalletCards}
            tone="text-primary"
            loading={statsLoading}
            cacheKey="payments.paidAmount"
            fallbackValue={formatMoney(0)}
          />
          <PaymentStatCard
            label="已支付订单"
            value={stats?.paidOrders || 0}
            icon={CheckCircle2}
            tone="text-emerald-600"
            loading={statsLoading}
            cacheKey="payments.paidOrders"
            fallbackValue={0}
          />
          <PaymentStatCard
            label="待支付订单"
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
          <AlertTitle>回调地址</AlertTitle>
          <AlertDescription>
            当前使用 {panelUrl || "未配置"}。
          </AlertDescription>
        </Alert>

        {isLoading ? (
          <DataSectionLoading label="正在加载支付配置" minHeight="min-h-[260px]" />
        ) : (
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as PaymentTab)}>
          <SlidingTabsList items={PAYMENT_TAB_ITEMS} activeValue={activeTab} ariaLabel="支付对接" minItemWidthRem={6.75} />

          <TabsContent value="basic" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle>基础设置</CardTitle>
                <CardDescription>用于商店套餐购买。</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="flex items-center justify-between rounded-lg border bg-background/70 px-4 py-3">
                  <div>
                    <div className="font-medium">启用支付功能</div>
                    <div className="text-sm text-muted-foreground">关闭后无法下单</div>
                  </div>
                  <Switch checked={form.enabled} onCheckedChange={(enabled) => setForm((prev) => ({ ...prev, enabled }))} />
                </div>
                <Field label="商品名称">
                  <Input value={form.productName} onChange={(e) => setForm((prev) => ({ ...prev, productName: e.target.value }))} />
                </Field>
                <Field label="最低金额">
                  <Input type="number" min={0} step="0.01" value={form.minAmount} onChange={(e) => setForm((prev) => ({ ...prev, minAmount: Number(e.target.value) }))} />
                </Field>
                <Field label="最高金额" hint="0 表示不限制">
                  <Input type="number" min={0} step="0.01" value={form.maxAmount} onChange={(e) => setForm((prev) => ({ ...prev, maxAmount: Number(e.target.value) }))} />
                </Field>
                <Field label="订单过期时间（分钟）">
                  <Input type="number" min={1} max={1440} value={form.orderTimeoutMinutes} onChange={(e) => setForm((prev) => ({ ...prev, orderTimeoutMinutes: Number(e.target.value) }))} />
                </Field>
                <Field label="最大待支付订单" hint="0 表示不限制">
                  <Input type="number" min={0} max={100} value={form.maxPendingOrders} onChange={(e) => setForm((prev) => ({ ...prev, maxPendingOrders: Number(e.target.value) }))} />
                </Field>
                <Field label="支付宝按钮来源" hint="用户侧仍显示为支付宝，后台决定使用哪条支付通道">
                  <Select value={form.routes.alipay} onValueChange={(alipay: "easypay" | "alipay") => setForm((prev) => ({ ...prev, routes: { ...prev.routes, alipay } }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="easypay">易支付</SelectItem>
                      <SelectItem value="alipay">支付宝官方</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="微信按钮来源" hint="用户侧仍显示为微信，后台决定使用哪条支付通道">
                  <Select value={form.routes.wxpay} onValueChange={(wxpay: "easypay" | "wxpay") => setForm((prev) => ({ ...prev, routes: { ...prev.routes, wxpay } }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="easypay">易支付</SelectItem>
                      <SelectItem value="wxpay">微信官方</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="easypay" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><WalletCards className="h-5 w-5" /> 易支付</CardTitle>
                <CardDescription>兼容易支付接口。</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="flex items-center justify-between rounded-lg border bg-background/70 px-4 py-3 md:col-span-2">
                  <div>
                    <div className="font-medium">启用易支付</div>
                    <div className="text-sm text-muted-foreground">支付宝、微信通道</div>
                  </div>
                  <Switch checked={form.easypay.enabled} onCheckedChange={(enabled) => setForm((prev) => ({ ...prev, easypay: { ...prev.easypay, enabled } }))} />
                </div>
                <Field label="接口地址">
                  <Input placeholder="https://pay.example.com" value={form.easypay.apiBase} onChange={(e) => setForm((prev) => ({ ...prev, easypay: { ...prev.easypay, apiBase: e.target.value } }))} />
                </Field>
                <Field label="商户 PID">
                  <Input value={form.easypay.pid} onChange={(e) => setForm((prev) => ({ ...prev, easypay: { ...prev.easypay, pid: e.target.value } }))} />
                </Field>
                <Field label="商户密钥" hint={config?.easypay?.hasPkey ? "已保存密钥，留空表示不修改" : "尚未保存密钥"}>
                  <Input type="password" value={form.easypay.pkey} onChange={(e) => setForm((prev) => ({ ...prev, easypay: { ...prev.easypay, pkey: e.target.value } }))} />
                </Field>
                <Field label="下单方式">
                  <Select value={form.easypay.mode} onValueChange={(mode: "redirect" | "api") => setForm((prev) => ({ ...prev, easypay: { ...prev.easypay, mode } }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="redirect">跳转支付</SelectItem>
                      <SelectItem value="api">API 下单</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="支付宝通道 CID" hint="可选">
                  <Input value={form.easypay.cidAlipay} onChange={(e) => setForm((prev) => ({ ...prev, easypay: { ...prev.easypay, cidAlipay: e.target.value } }))} />
                </Field>
                <Field label="微信通道 CID" hint="可选">
                  <Input value={form.easypay.cidWxpay} onChange={(e) => setForm((prev) => ({ ...prev, easypay: { ...prev.easypay, cidWxpay: e.target.value } }))} />
                </Field>
                <div className="grid gap-3 md:col-span-2 md:grid-cols-2">
                  <CallbackItem label="异步通知地址" value={`${panelUrl}/api/payment/webhook/easypay`} />
                  <CallbackItem label="同步返回地址" value={`${panelUrl}/api/payment/return/easypay`} />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="alipay" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><WalletCards className="h-5 w-5" /> 支付宝官方</CardTitle>
                <CardDescription>支付宝官方接口。</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="flex items-center justify-between rounded-lg border bg-background/70 px-4 py-3 md:col-span-2">
                  <div>
                    <div className="font-medium">启用支付宝官方</div>
                    <div className="text-sm text-muted-foreground">需在基础设置中选择</div>
                  </div>
                  <Switch checked={form.alipay.enabled} onCheckedChange={(enabled) => setForm((prev) => ({ ...prev, alipay: { ...prev.alipay, enabled } }))} />
                </div>
                <Field label="AppID">
                  <Input value={form.alipay.appId} onChange={(e) => setForm((prev) => ({ ...prev, alipay: { ...prev.alipay, appId: e.target.value } }))} />
                </Field>
                <Field label="网关地址">
                  <Input value={form.alipay.gateway} onChange={(e) => setForm((prev) => ({ ...prev, alipay: { ...prev.alipay, gateway: e.target.value } }))} />
                </Field>
                <Field label="支付模式">
                  <Select value={form.alipay.mode} onValueChange={(mode: "precreate" | "page" | "wap") => setForm((prev) => ({ ...prev, alipay: { ...prev.alipay, mode } }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="precreate">扫码预下单</SelectItem>
                      <SelectItem value="page">电脑网站支付</SelectItem>
                      <SelectItem value="wap">手机网站支付</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <div className="hidden md:block" />
                <Field label="应用私钥" hint={config?.alipay?.hasPrivateKey ? "已保存私钥，留空表示不修改" : "尚未保存私钥"}>
                  <Textarea className="min-h-32 font-mono text-xs" value={form.alipay.privateKey} onChange={(e) => setForm((prev) => ({ ...prev, alipay: { ...prev.alipay, privateKey: e.target.value } }))} />
                </Field>
                <Field label="支付宝公钥" hint={config?.alipay?.hasPublicKey ? "已保存公钥，留空表示不修改" : "尚未保存公钥"}>
                  <Textarea className="min-h-32 font-mono text-xs" value={form.alipay.publicKey} onChange={(e) => setForm((prev) => ({ ...prev, alipay: { ...prev.alipay, publicKey: e.target.value } }))} />
                </Field>
                <div className="grid gap-3 md:col-span-2 md:grid-cols-2">
                  <CallbackItem label="异步通知地址" value={`${panelUrl}/api/payment/webhook/alipay`} />
                  <CallbackItem label="同步返回地址" value={`${panelUrl}/api/payment/return/alipay`} />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="wxpay" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><WalletCards className="h-5 w-5" /> 微信官方</CardTitle>
                <CardDescription>微信支付 APIv3。</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="flex items-center justify-between rounded-lg border bg-background/70 px-4 py-3 md:col-span-2">
                  <div>
                    <div className="font-medium">启用微信官方</div>
                    <div className="text-sm text-muted-foreground">需在基础设置中选择</div>
                  </div>
                  <Switch checked={form.wxpay.enabled} onCheckedChange={(enabled) => setForm((prev) => ({ ...prev, wxpay: { ...prev.wxpay, enabled } }))} />
                </div>
                <Field label="AppID">
                  <Input value={form.wxpay.appId} onChange={(e) => setForm((prev) => ({ ...prev, wxpay: { ...prev.wxpay, appId: e.target.value } }))} />
                </Field>
                <Field label="商户号 MchID">
                  <Input value={form.wxpay.mchId} onChange={(e) => setForm((prev) => ({ ...prev, wxpay: { ...prev.wxpay, mchId: e.target.value } }))} />
                </Field>
                <Field label="商户证书序列号">
                  <Input value={form.wxpay.certSerial} onChange={(e) => setForm((prev) => ({ ...prev, wxpay: { ...prev.wxpay, certSerial: e.target.value } }))} />
                </Field>
                <Field label="微信支付公钥 ID">
                  <Input value={form.wxpay.publicKeyId} onChange={(e) => setForm((prev) => ({ ...prev, wxpay: { ...prev.wxpay, publicKeyId: e.target.value } }))} />
                </Field>
                <Field label="APIv3 密钥" hint={config?.wxpay?.hasApiV3Key ? "已保存密钥，留空表示不修改" : "尚未保存密钥"}>
                  <Input type="password" value={form.wxpay.apiV3Key} onChange={(e) => setForm((prev) => ({ ...prev, wxpay: { ...prev.wxpay, apiV3Key: e.target.value } }))} />
                </Field>
                <Field label="支付模式" hint="JSAPI 需要用户 OpenID，当前版本暂未开放前台 OAuth 流程">
                  <Select value={form.wxpay.mode} onValueChange={(mode: "native" | "h5" | "jsapi") => setForm((prev) => ({ ...prev, wxpay: { ...prev.wxpay, mode } }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="native">Native 扫码</SelectItem>
                      <SelectItem value="h5">H5 支付</SelectItem>
                      <SelectItem value="jsapi">JSAPI</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="H5 应用名称" hint="H5 支付可选">
                  <Input value={form.wxpay.h5AppName} onChange={(e) => setForm((prev) => ({ ...prev, wxpay: { ...prev.wxpay, h5AppName: e.target.value } }))} />
                </Field>
                <Field label="H5 应用 URL" hint="H5 支付可选">
                  <Input value={form.wxpay.h5AppUrl} onChange={(e) => setForm((prev) => ({ ...prev, wxpay: { ...prev.wxpay, h5AppUrl: e.target.value } }))} />
                </Field>
                <Field label="商户 API 私钥" hint={config?.wxpay?.hasPrivateKey ? "已保存私钥，留空表示不修改" : "尚未保存私钥"}>
                  <Textarea className="min-h-32 font-mono text-xs" value={form.wxpay.privateKey} onChange={(e) => setForm((prev) => ({ ...prev, wxpay: { ...prev.wxpay, privateKey: e.target.value } }))} />
                </Field>
                <Field label="微信支付公钥" hint={config?.wxpay?.hasPublicKey ? "已保存公钥，留空表示不修改" : "尚未保存公钥"}>
                  <Textarea className="min-h-32 font-mono text-xs" value={form.wxpay.publicKey} onChange={(e) => setForm((prev) => ({ ...prev, wxpay: { ...prev.wxpay, publicKey: e.target.value } }))} />
                </Field>
                <div className="grid gap-3 md:col-span-2 md:grid-cols-2">
                  <CallbackItem label="异步通知地址" value={`${panelUrl}/api/payment/webhook/wxpay`} />
                  <CallbackItem label="同步返回地址" value={`${panelUrl}/api/payment/return/wxpay`} />
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
                    <div className="font-medium">启用 Stripe</div>
                    <div className="text-sm text-muted-foreground">银行卡和钱包支付</div>
                  </div>
                  <Switch checked={form.stripe.enabled} onCheckedChange={(enabled) => setForm((prev) => ({ ...prev, stripe: { ...prev.stripe, enabled } }))} />
                </div>
                <Field label="Secret Key" hint={config?.stripe?.hasSecretKey ? "已保存密钥，留空表示不修改" : "尚未保存密钥"}>
                  <Input type="password" placeholder="sk_live_..." value={form.stripe.secretKey} onChange={(e) => setForm((prev) => ({ ...prev, stripe: { ...prev.stripe, secretKey: e.target.value } }))} />
                </Field>
                <Field label="Publishable Key" hint="可选，用于前端展示或后续扩展">
                  <Input placeholder="pk_live_..." value={form.stripe.publishableKey} onChange={(e) => setForm((prev) => ({ ...prev, stripe: { ...prev.stripe, publishableKey: e.target.value } }))} />
                </Field>
                <Field label="Webhook Secret" hint={config?.stripe?.hasWebhookSecret ? "已保存签名密钥，留空表示不修改" : "尚未保存签名密钥"}>
                  <Input type="password" placeholder="whsec_..." value={form.stripe.webhookSecret} onChange={(e) => setForm((prev) => ({ ...prev, stripe: { ...prev.stripe, webhookSecret: e.target.value } }))} />
                </Field>
                <Field label="币种">
                  <Input value={form.stripe.currency} onChange={(e) => setForm((prev) => ({ ...prev, stripe: { ...prev.stripe, currency: e.target.value.toLowerCase() } }))} />
                </Field>
                <div className="md:col-span-2">
                  <CallbackItem label="Stripe Webhook 地址" value={`${panelUrl}/api/payment/webhook/stripe`} />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="test" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle>测试下单</CardTitle>
                <CardDescription>创建测试订单。</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-[1fr_1fr_auto]">
                <Field label="金额">
                  <Input type="number" min={0.01} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
                </Field>
                <Field label="支付方式">
                  <Select value={paymentType} onValueChange={(value: "alipay" | "wxpay" | "stripe") => setPaymentType(value)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="alipay">支付宝</SelectItem>
                      <SelectItem value="wxpay">微信</SelectItem>
                      <SelectItem value="stripe">Stripe</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <div className="flex items-end">
                  <Button className="w-full" onClick={() => createOrder.mutate({ amount: Number(amount), paymentType, orderType: "test" })} disabled={createOrder.isPending}>
                    {createOrder.isPending ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <ExternalLink className="mr-2 h-4 w-4" />}
                    创建订单
                  </Button>
                </div>
                {createdPayUrl && (
                  <div className="rounded-lg border bg-background/70 p-3 md:col-span-3">
                    <div className="mb-2 text-sm text-muted-foreground">支付链接</div>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <code className="min-w-0 flex-1 truncate text-xs">{createdPayUrl}</code>
                      <Button variant="outline" onClick={() => window.open(createdPayUrl, "_blank")}>打开支付页</Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
        )}

        <Card>
          <CardHeader>
            <CardTitle>订单记录</CardTitle>
            <CardDescription>套餐订单和测试订单。</CardDescription>
          </CardHeader>
          <CardContent>
            {ordersLoading ? (
              <DataSectionLoading label="正在加载支付订单" />
            ) : (
              <>
            <div className="grid gap-3 md:hidden">
              {(orders || []).map((order: any) => (
                <div key={order.id} className="rounded-lg border border-border/50 bg-background/40 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium">{order.name || order.username || `#${order.userId}`}</p>
                      <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{order.outTradeNo}</p>
                    </div>
                    <div className="shrink-0 text-right text-sm font-semibold tabular-nums">
                      {formatMoney(order.amountCents, order.currency)}
                    </div>
                  </div>
                  <div className="mt-3 space-y-2 border-t border-border/40 pt-3">
                    <MobileOrderInfoRow label="通道">
                      <div className="flex flex-wrap justify-end gap-1">
                        <Badge variant="secondary">{providerLabel(order.provider)}</Badge>
                        <Badge variant="outline">{paymentTypeLabel(order.paymentType)}</Badge>
                      </div>
                    </MobileOrderInfoRow>
                    <MobileOrderInfoRow label="状态">{statusBadge(order.status)}</MobileOrderInfoRow>
                    <MobileOrderInfoRow label="网关流水" valueClassName="font-mono text-xs text-muted-foreground">
                      {order.tradeNo || "-"}
                    </MobileOrderInfoRow>
                    <MobileOrderInfoRow label="创建时间">{formatDate(order.createdAt)}</MobileOrderInfoRow>
                    <MobileOrderInfoRow label="支付时间">{formatDate(order.paidAt)}</MobileOrderInfoRow>
                  </div>
                </div>
              ))}
              {(orders || []).length === 0 && (
                <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  暂无支付订单
                </div>
              )}
            </div>
            <div className="hidden overflow-x-auto md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>订单号</TableHead>
                    <TableHead>用户</TableHead>
                    <TableHead>通道</TableHead>
                    <TableHead>金额</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>网关流水</TableHead>
                    <TableHead>创建时间</TableHead>
                    <TableHead>支付时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(orders || []).map((order: any) => (
                    <TableRow key={order.id}>
                      <TableCell className="font-mono text-xs">{order.outTradeNo}</TableCell>
                      <TableCell>{order.name || order.username || `#${order.userId}`}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          <Badge variant="secondary">{providerLabel(order.provider)}</Badge>
                          <Badge variant="outline">{paymentTypeLabel(order.paymentType)}</Badge>
                        </div>
                      </TableCell>
                      <TableCell>{formatMoney(order.amountCents, order.currency)}</TableCell>
                      <TableCell>{statusBadge(order.status)}</TableCell>
                      <TableCell className="font-mono text-xs">{order.tradeNo || "-"}</TableCell>
                      <TableCell>{formatDate(order.createdAt)}</TableCell>
                      <TableCell>{formatDate(order.paidAt)}</TableCell>
                    </TableRow>
                  ))}
                  {(orders || []).length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                        暂无支付订单
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
