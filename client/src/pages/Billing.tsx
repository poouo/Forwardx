import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import { CreditCard, Gift, Package, ReceiptText, Shuffle, TicketPercent, Trash2, WalletCards } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function money(cents?: number, currency = "CNY") {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency }).format((Number(cents) || 0) / 100);
}

function dateText(value?: string | Date | null) {
  return value ? new Date(value).toLocaleString() : "不限";
}

function randomBillingCode() {
  const length = 6 + Math.floor(Math.random() * 5);
  return Array.from({ length }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
}

function parseLocalTime(value: string) {
  return value ? new Date(value).getTime() : 0;
}

function discountStatus(code: any) {
  const now = Date.now();
  if (!code.isActive) return "停用";
  if (code.startsAt && new Date(code.startsAt).getTime() > now) return "等待生效";
  if (code.expiresAt && new Date(code.expiresAt).getTime() <= now) return "已过期";
  if (Number(code.maxUses || 0) > 0 && Number(code.usedCount || 0) >= Number(code.maxUses)) return "已用完";
  return "生效中";
}

function normalizeCodeInput(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 64);
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

export default function Billing() {
  const utils = trpc.useUtils();
  const { data: users = [] } = trpc.users.list.useQuery();
  const { data: plans = [] } = trpc.plans.list.useQuery();
  const { data: transactions = [] } = trpc.billing.listTransactions.useQuery({ limit: 100 });
  const [ledgerUserId, setLedgerUserId] = useState("all");
  const { data: ledger = [] } = trpc.billing.ledger.useQuery({
    limit: 200,
    userId: ledgerUserId === "all" ? undefined : Number(ledgerUserId),
  });
  const { data: redemptionCodes = [] } = trpc.billing.listRedemptionCodes.useQuery();
  const { data: discountCodes = [] } = trpc.billing.listDiscountCodes.useQuery();
  const { data: featureStatus } = trpc.billing.featureStatus.useQuery();

  const [redeemType, setRedeemType] = useState<"plan" | "balance">("plan");
  const [redeemCode, setRedeemCode] = useState("");
  const [redeemPlanId, setRedeemPlanId] = useState("");
  const [redeemDuration, setRedeemDuration] = useState("30");
  const [redeemAmount, setRedeemAmount] = useState("");
  const [redeemCount, setRedeemCount] = useState("1");
  const [redeemStartsAt, setRedeemStartsAt] = useState("");
  const [redeemExpiresAt, setRedeemExpiresAt] = useState("");

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
      setRedeemCode("");
      utils.billing.listRedemptionCodes.invalidate();
    },
    onError: (error) => toast.error(error.message || "生成失败"),
  });

  const deleteRedemptionCode = trpc.billing.deleteRedemptionCode.useMutation({
    onSuccess: () => {
      toast.success("兑换码已删除");
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
      <div className="space-y-6 p-4 sm:p-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">余额与营销</h1>
          <p className="text-sm text-muted-foreground">管理余额流水、兑换码和套餐折扣码。用户充值请在用户管理中操作。</p>
        </div>

        <div className="grid gap-4 md:grid-cols-5">
          <Card><CardHeader className="pb-2"><CardDescription>用户余额总额</CardDescription><CardTitle>{money(totalBalance)}</CardTitle></CardHeader></Card>
          <Card><CardHeader className="pb-2"><CardDescription>可用兑换码</CardDescription><CardTitle>{activeRedemptionCodes}</CardTitle></CardHeader></Card>
          <Card><CardHeader className="pb-2"><CardDescription>生效折扣码</CardDescription><CardTitle>{activeDiscountCodes}</CardTitle></CardHeader></Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>用户兑换入口</CardDescription>
              <CardTitle className="flex items-center justify-between text-base">
                {featureStatus?.redemptionEnabled ? "已开启" : "已关闭"}
                <Switch checked={featureStatus?.redemptionEnabled ?? true} onCheckedChange={(redemptionEnabled) => setFeatureStatus.mutate({ redemptionEnabled })} />
              </CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>购买折扣入口</CardDescription>
              <CardTitle className="flex items-center justify-between text-base">
                {featureStatus?.discountEnabled ? "已开启" : "已关闭"}
                <Switch checked={featureStatus?.discountEnabled ?? true} onCheckedChange={(discountEnabled) => setFeatureStatus.mutate({ discountEnabled })} />
              </CardTitle>
            </CardHeader>
          </Card>
        </div>

        <Tabs defaultValue="balance">
          <TabsList className="flex h-auto flex-wrap">
            <TabsTrigger value="ledger">账单流水</TabsTrigger>
            <TabsTrigger value="balance">余额流水</TabsTrigger>
            <TabsTrigger value="redeem">兑换码</TabsTrigger>
            <TabsTrigger value="discount">折扣码</TabsTrigger>
          </TabsList>

          <TabsContent value="ledger" className="mt-4">
            <Card>
              <CardHeader className="gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2"><ReceiptText className="h-5 w-5" /> 账单流水</CardTitle>
                  <CardDescription>整合余额变动、支付订单和套餐订阅记录，管理员可按用户筛选。</CardDescription>
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
              <CardContent className="overflow-x-auto">
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
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="balance" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><WalletCards className="h-5 w-5" /> 余额流水</CardTitle>
                <CardDescription>管理员充值、用户购买套餐、兑换余额都会记录在这里。</CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow><TableHead>用户</TableHead><TableHead>类型</TableHead><TableHead>金额</TableHead><TableHead>余额</TableHead><TableHead>说明</TableHead><TableHead>时间</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {transactions.map((tx: any) => (
                      <TableRow key={tx.id}>
                        <TableCell>{tx.username || `#${tx.userId}`}</TableCell>
                        <TableCell><Badge variant="outline">{tx.type}</Badge></TableCell>
                        <TableCell className={Number(tx.amountCents) >= 0 ? "text-emerald-600" : "text-destructive"}>{money(tx.amountCents)}</TableCell>
                        <TableCell>{money(tx.balanceAfterCents)}</TableCell>
                        <TableCell>{tx.description || "-"}</TableCell>
                        <TableCell>{dateText(tx.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="redeem" className="mt-4 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Gift className="h-5 w-5" /> 生成兑换码</CardTitle>
                <CardDescription>兑换码只可使用一次，可兑换指定套餐期限或余额。</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-4">
                <div className="space-y-2 md:col-span-2">
                  <Label>兑换码</Label>
                  <div className="flex gap-2">
                    <Input value={redeemCode} onChange={(e) => setRedeemCode(normalizeCodeInput(e.target.value))} placeholder="留空自动生成" />
                    <Button type="button" variant="outline" onClick={() => setRedeemCode(randomBillingCode())}><Shuffle className="mr-2 h-4 w-4" /> 随机</Button>
                  </div>
                  <p className="text-xs text-muted-foreground">随机码为 6-10 位大写字母和数字；批量生成时仅第一条使用手动填写的兑换码。</p>
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
                <div className="space-y-2"><Label>生效时间</Label><Input type="datetime-local" value={redeemStartsAt} onChange={(e) => setRedeemStartsAt(e.target.value)} /></div>
                <div className="space-y-2"><Label>失效时间</Label><Input type="datetime-local" value={redeemExpiresAt} onChange={(e) => setRedeemExpiresAt(e.target.value)} /></div>
                <div className="flex items-end md:col-span-2"><Button onClick={submitRedemption} disabled={createRedemptionCodes.isPending}><Gift className="mr-2 h-4 w-4" /> 生成兑换码</Button></div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>兑换码列表</CardTitle></CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow><TableHead>兑换码</TableHead><TableHead>类型</TableHead><TableHead>内容</TableHead><TableHead>有效期</TableHead><TableHead>使用情况</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {redemptionCodes.map((code: any) => (
                      <TableRow key={code.id}>
                        <TableCell className="font-mono">{code.code}</TableCell>
                        <TableCell><Badge variant="outline">{code.type === "plan" ? "套餐" : "余额"}</Badge></TableCell>
                        <TableCell>{code.type === "plan" ? `${code.planName || `套餐 #${code.planId}`} / ${code.durationDays || 30} 天` : money(code.amountCents)}</TableCell>
                        <TableCell>{dateText(code.startsAt)} - {dateText(code.expiresAt)}</TableCell>
                        <TableCell>{code.usedAt ? `${code.usedByUsername || code.usedByUserId} 于 ${dateText(code.usedAt)}` : "未使用"}</TableCell>
                        <TableCell className="text-right"><Button variant="ghost" size="icon" className="text-destructive" onClick={() => deleteRedemptionCode.mutate({ id: code.id })}><Trash2 className="h-4 w-4" /></Button></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="discount" className="mt-4 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><TicketPercent className="h-5 w-5" /> 新增折扣码</CardTitle>
                <CardDescription>折扣码用于用户购买套餐时抵扣，可限制有效期、使用次数和适用套餐。</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-4">
                <div className="space-y-2 md:col-span-2">
                  <Label>折扣码</Label>
                  <div className="flex gap-2">
                    <Input value={discountCode} onChange={(e) => setDiscountCode(normalizeCodeInput(e.target.value))} placeholder="例如 SALE2026" />
                    <Button type="button" variant="outline" onClick={() => setDiscountCode(randomBillingCode())}><Shuffle className="mr-2 h-4 w-4" /> 随机</Button>
                  </div>
                  <p className="text-xs text-muted-foreground">未填写时不会提交，请填写或点击随机生成。</p>
                </div>
                <div className="space-y-2"><Label>类型</Label><Select value={discountType} onValueChange={(v: "percent" | "amount") => setDiscountType(v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="percent">百分比</SelectItem><SelectItem value="amount">固定金额</SelectItem></SelectContent></Select></div>
                <div className="space-y-2"><Label>{discountType === "percent" ? "折扣百分比" : "抵扣金额"}</Label><Input type="number" min={1} max={discountType === "percent" ? 100 : undefined} value={discountValue} onChange={(e) => setDiscountValue(e.target.value)} /></div>
                <div className="space-y-2"><Label>可用次数</Label><Input type="number" min={0} value={discountMaxUses} onChange={(e) => setDiscountMaxUses(e.target.value)} placeholder="0=不限" /></div>
                <div className="space-y-2"><Label>生效时间</Label><Input type="datetime-local" value={discountStartsAt} onChange={(e) => setDiscountStartsAt(e.target.value)} /></div>
                <div className="space-y-2"><Label>失效时间</Label><Input type="datetime-local" value={discountExpiresAt} onChange={(e) => setDiscountExpiresAt(e.target.value)} /></div>
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
                <div className="flex items-end md:col-span-2"><Button onClick={submitDiscount} disabled={createDiscountCode.isPending}><TicketPercent className="mr-2 h-4 w-4" /> 创建折扣码</Button></div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>折扣码列表</CardTitle></CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow><TableHead>折扣码</TableHead><TableHead>优惠</TableHead><TableHead>适用套餐</TableHead><TableHead>状态</TableHead><TableHead>次数</TableHead><TableHead>有效期</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {discountCodes.map((code: any) => {
                      const status = discountStatus(code);
                      return (
                        <TableRow key={code.id}>
                          <TableCell className="font-mono">{code.code}</TableCell>
                          <TableCell>{code.discountType === "percent" ? `${code.discountValue}%` : money(code.discountValue)}</TableCell>
                          <TableCell>{code.planIds?.length ? code.planIds.map((id: number) => plans.find((plan: any) => Number(plan.id) === Number(id))?.name || `#${id}`).join("、") : "全部套餐"}</TableCell>
                          <TableCell><Badge variant={status === "生效中" ? "default" : "secondary"}>{status}</Badge></TableCell>
                          <TableCell>{code.usedCount || 0} / {code.maxUses || "不限"}</TableCell>
                          <TableCell>{dateText(code.startsAt)} - {dateText(code.expiresAt)}</TableCell>
                          <TableCell className="text-right"><Button variant="ghost" size="icon" className="text-destructive" onClick={() => deleteDiscountCode.mutate({ id: code.id })}><Trash2 className="h-4 w-4" /></Button></TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
