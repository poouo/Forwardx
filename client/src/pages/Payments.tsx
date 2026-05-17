import DashboardLayout from "@/components/DashboardLayout";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
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
import { useEffect, useMemo, useState } from "react";
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
    completed: "已完成",
    expired: "已过期",
    cancelled: "已取消",
    failed: "失败",
  };
  const tone = status === "paid" || status === "completed"
    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
    : status === "pending"
      ? "border-amber-200 bg-amber-50 text-amber-700"
      : "border-slate-200 bg-slate-50 text-slate-600";
  return <Badge variant="outline" className={tone}>{text[status] || status}</Badge>;
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

export default function Payments() {
  const utils = trpc.useUtils();
  const { data: config, isLoading } = trpc.payment.getConfig.useQuery();
  const { data: stats } = trpc.payment.stats.useQuery(undefined, { refetchInterval: 30_000 });
  const { data: orders } = trpc.payment.listOrders.useQuery({ limit: 100 }, { refetchInterval: 30_000 });
  const { data: settings } = trpc.system.getSettings.useQuery();
  const [form, setForm] = useState<PaymentConfigForm>(emptyForm);
  const [amount, setAmount] = useState("10");
  const [paymentType, setPaymentType] = useState<"alipay" | "wxpay" | "stripe">("alipay");
  const [createdPayUrl, setCreatedPayUrl] = useState<string | null>(null);

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
      <div className="space-y-6 p-4 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">支付对接</h1>
            <p className="text-sm text-muted-foreground">配置易支付、支付宝官方、微信官方与 Stripe，查看支付订单和回调状态</p>
          </div>
          <Button onClick={save} disabled={updateConfig.isPending || isLoading}>
            {updateConfig.isPending ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
            保存配置
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>支付状态</CardDescription>
              <CardTitle>{form.enabled ? "已启用" : "未启用"}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>已支付金额</CardDescription>
              <CardTitle>{formatMoney(stats?.paidAmountCents)}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>已支付订单</CardDescription>
              <CardTitle>{stats?.paidOrders || 0}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>待支付订单</CardDescription>
              <CardTitle>{stats?.pendingOrders || 0}</CardTitle>
            </CardHeader>
          </Card>
        </div>

        <Alert className="border-blue-200 bg-blue-50/70 text-blue-900">
          <ShieldCheck className="h-4 w-4" />
          <AlertTitle>回调地址依赖面板公开地址</AlertTitle>
          <AlertDescription>
            当前使用 {panelUrl || "未配置"}。如果面板在反向代理或 Docker 后面，请先在系统设置中填写外部可访问地址。
          </AlertDescription>
        </Alert>

        <Tabs defaultValue="basic">
          <TabsList className="flex h-auto flex-wrap">
            <TabsTrigger value="basic">基础设置</TabsTrigger>
            <TabsTrigger value="easypay">易支付</TabsTrigger>
            <TabsTrigger value="alipay">支付宝官方</TabsTrigger>
            <TabsTrigger value="wxpay">微信官方</TabsTrigger>
            <TabsTrigger value="stripe">Stripe</TabsTrigger>
            <TabsTrigger value="test">测试下单</TabsTrigger>
          </TabsList>

          <TabsContent value="basic" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle>基础设置</CardTitle>
                <CardDescription>支付成功后先记录订单状态，不自动修改用户流量或到期时间</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="flex items-center justify-between rounded-lg border bg-background/70 px-4 py-3">
                  <div>
                    <div className="font-medium">启用支付功能</div>
                    <div className="text-sm text-muted-foreground">关闭后用户无法创建支付订单</div>
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
                <CardDescription>兼容常见易支付接口，支持跳转支付和 API 下单</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="flex items-center justify-between rounded-lg border bg-background/70 px-4 py-3 md:col-span-2">
                  <div>
                    <div className="font-medium">启用易支付</div>
                    <div className="text-sm text-muted-foreground">用于支付宝和微信支付</div>
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
                <CardDescription>直接对接支付宝开放平台，支持扫码、电脑网页和手机网站支付</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="flex items-center justify-between rounded-lg border bg-background/70 px-4 py-3 md:col-span-2">
                  <div>
                    <div className="font-medium">启用支付宝官方</div>
                    <div className="text-sm text-muted-foreground">基础设置中将支付宝按钮来源切到支付宝官方后生效</div>
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
                <CardDescription>直接对接微信支付 APIv3，支持 Native 扫码和 H5 支付</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="flex items-center justify-between rounded-lg border bg-background/70 px-4 py-3 md:col-span-2">
                  <div>
                    <div className="font-medium">启用微信官方</div>
                    <div className="text-sm text-muted-foreground">基础设置中将微信按钮来源切到微信官方后生效</div>
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
                <CardDescription>使用 Stripe Checkout 创建支付页面，并通过 Webhook 确认支付结果</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="flex items-center justify-between rounded-lg border bg-background/70 px-4 py-3 md:col-span-2">
                  <div>
                    <div className="font-medium">启用 Stripe</div>
                    <div className="text-sm text-muted-foreground">用于银行卡和 Stripe 支持的钱包支付</div>
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
                <CardDescription>使用当前管理员账号创建一笔真实支付订单，用于检查接口配置</CardDescription>
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
                  <Button className="w-full" onClick={() => createOrder.mutate({ amount: Number(amount), paymentType })} disabled={createOrder.isPending}>
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

        <Card>
          <CardHeader>
            <CardTitle>订单记录</CardTitle>
            <CardDescription>支付成功只记录订单状态，套餐、流量或到期时间需要后续权益规则接入</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
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
                  {(orders || []).map((order) => (
                    <TableRow key={order.id}>
                      <TableCell className="font-mono text-xs">{order.outTradeNo}</TableCell>
                      <TableCell>{order.username || `#${order.userId}`}</TableCell>
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
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
