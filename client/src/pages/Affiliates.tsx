import { useEffect, useState } from "react";
import {
  Copy,
  Plus,
  QrCode,
  RefreshCw,
  Users,
  Wallet,
  Percent,
  Clock,
  Settings2,
} from "lucide-react";
import QRCode from "qrcode";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { t, getFormatLocale } from "@/i18n";
import { toast } from "@/lib/localizedToast";
import { copyTextToClipboard } from "@/lib/clipboard";
import { affiliateRequestKey } from "@/lib/affiliateReferral";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  AFFILIATE_DEFAULTS,
  AFFILIATE_STATUS_LABELS,
  type AffiliateConfig,
} from "@shared/affiliate";

const money = (cents: unknown) =>
  new Intl.NumberFormat(getFormatLocale(), {
    style: "currency",
    currency: "CNY",
  }).format(Number(cents || 0) / 100);
const date = (epoch: unknown) =>
  epoch
    ? new Date(Number(epoch) * 1000).toLocaleString(getFormatLocale())
    : "—";
const error = (err: { message: string }) => toast.error(err.message);
type Kind = "commissions" | "withdrawals" | "ledger" | "referrals";
const kinds: Record<Kind, string> = {
  commissions: "返佣记录",
  withdrawals: "提现记录",
  ledger: "佣金流水",
  referrals: "邀请记录",
};
function Pager({
  page,
  total,
  change,
}: {
  page: number;
  total: number;
  change: (n: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 pt-4 text-sm">
      <span>{t("共 {0} 条", [total])}</span>
      <Button
        variant="outline"
        size="sm"
        disabled={page <= 1}
        onClick={() => change(page - 1)}
      >
        {t("上一页")}
      </Button>
      <span>{page}</span>
      <Button
        variant="outline"
        size="sm"
        disabled={page * 20 >= total}
        onClick={() => change(page + 1)}
      >
        {t("下一页")}
      </Button>
    </div>
  );
}
const AFFILIATE_STAT_TONES = {
  emerald: "bg-gradient-to-br from-emerald-500 to-emerald-600",
  amber: "bg-gradient-to-br from-amber-500 to-amber-600",
  sky: "bg-gradient-to-br from-sky-500 to-sky-600",
  violet: "bg-gradient-to-br from-violet-500 to-violet-600",
} as const;

export function AffiliateStats({
  items,
}: {
  items: { label: string; value: string; help: string; icon: typeof Wallet; tone?: keyof typeof AFFILIATE_STAT_TONES }[];
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {items.map(({ label, value, help, icon: Icon, tone = "emerald" }) => (
        <Card key={label} hoverable className="relative overflow-hidden border-border/40 bg-card/60">
          <div aria-hidden="true" className={`pointer-events-none absolute inset-0 opacity-[0.04] ${AFFILIATE_STAT_TONES[tone]}`} />
          <CardHeader className="relative flex-row items-start justify-between gap-3 space-y-0">
            <div className="min-w-0 flex-1">
              <CardDescription>{t(label)}</CardDescription>
              <div className="mt-2 break-words text-2xl font-semibold tabular-nums">
                {value}
              </div>
            </div>
            <div aria-hidden="true" className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl shadow-sm ${AFFILIATE_STAT_TONES[tone]}`}>
              <Icon className="h-5 w-5 text-white" />
            </div>
          </CardHeader>
          <CardContent className="relative">
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t(help)}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
function Records({ admin = false }: { admin?: boolean }) {
  const [kind, setKind] = useState<Kind>("commissions");
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("all");
  const [filterUser, setFilterUser] = useState("");
  const [action, setAction] = useState<{
    id: number;
    kind: "paid" | "rejected" | "cancel";
  } | null>(null);
  const [note, setNote] = useState("");
  const utils = trpc.useUtils();
  const input = {
    kind,
    page,
    status: status as "all",
    ...(admin && /^[1-9]\d*$/.test(filterUser)
      ? { userId: Number(filterUser) }
      : {}),
  };
  const userQuery = trpc.affiliates.list.useQuery(input, { enabled: !admin });
  const adminQuery = trpc.affiliates.adminList.useQuery(input, {
    enabled: admin,
  });
  const query = admin ? adminQuery : userQuery;
  const success = () => {
    setAction(null);
    setNote("");
    void utils.affiliates.invalidate();
    toast.success(t("操作成功"));
  };
  const review = trpc.affiliates.reviewWithdrawal.useMutation({
    onSuccess: success,
    onError: error,
  });
  const cancel = trpc.affiliates.cancelCommission.useMutation({
    onSuccess: success,
    onError: error,
  });
  const states =
    kind === "commissions"
      ? ["pending", "available", "cancelled"]
      : ["pending", "paid", "rejected"];
  const hasStatus = kind === "commissions" || kind === "withdrawals";
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>{t(admin ? "推广明细" : "推广记录")}</CardTitle>
          <Button
            size="icon"
            variant="ghost"
            aria-label={t("刷新")}
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex flex-wrap gap-2 pt-2">
          <Select
            value={kind}
            onValueChange={(v) => {
              setKind(v as Kind);
              setPage(1);
              setStatus("all");
            }}
          >
            <SelectTrigger
              className="w-full sm:w-40"
              aria-label={t("记录类型")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(kinds).map(([key, label]) => (
                <SelectItem key={key} value={key}>
                  {t(label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {hasStatus && (
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label={t("状态")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("全部状态")}</SelectItem>
                {states.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(AFFILIATE_STATUS_LABELS[s])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {admin && (
            <Input
              className="w-full sm:w-40"
              inputMode="numeric"
              value={filterUser}
              placeholder={t("推广用户 ID")}
              aria-label={t("推广用户 ID")}
              onChange={(e) => {
                setFilterUser(e.target.value);
                setPage(1);
              }}
            />
          )}
        </div>
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <p className="py-8 text-center text-muted-foreground">
            {t("加载中...")}
          </p>
        ) : query.error ? (
          <p className="py-8 text-center text-destructive">
            {query.error.message}
          </p>
        ) : !query.data?.items.length ? (
          <p className="py-8 text-center text-muted-foreground">
            {t("暂无记录")}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-left text-sm">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="p-3">{t("编号")}</th>
                  {admin && <th className="p-3">{t("用户 ID")}</th>}
                  <th className="p-3">
                    {t(
                      kind === "commissions"
                        ? "订单号"
                        : kind === "withdrawals"
                          ? "收款信息"
                          : kind === "referrals"
                            ? "受邀用户"
                            : "类型",
                    )}
                  </th>
                  {kind === "commissions" && (
                    <th className="p-3">{t("订单金额")}</th>
                  )}
                  <th className="p-3">
                    {t(kind === "referrals" ? "邀请码 ID" : "金额")}
                  </th>
                  <th className="p-3">
                    {t(
                      kind === "ledger"
                        ? "佣金余额"
                        : kind === "referrals"
                          ? "注册时间"
                          : "状态",
                    )}
                  </th>
                  <th className="p-3">{t("时间")}</th>
                  {admin && hasStatus && <th className="p-3">{t("操作")}</th>}
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((row) => (
                  <tr className="border-b last:border-0" key={row.id}>
                    <td className="p-3">#{row.id}</td>
                    {admin && (
                      <td className="p-3">
                        #
                        {kind === "referrals"
                          ? row.affiliateUserId
                          : row.userId}
                      </td>
                    )}
                    <td className="max-w-64 break-words p-3">
                      {kind === "commissions" ? (
                        row.orderNo
                      ) : kind === "withdrawals" ? (
                        <>
                          <div>
                            {t(
                              row.method === "bank"
                                ? "银行卡"
                                : row.method === "alipay"
                                  ? "支付宝"
                                  : "微信支付",
                            )}{" "}
                            · {row.payee}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {row.account}
                          </div>
                        </>
                      ) : kind === "referrals" ? (
                        `#${row.userId}`
                      ) : (
                        t(AFFILIATE_STATUS_LABELS[row.type] || row.type)
                      )}
                      {row.reason && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {row.reason}
                        </p>
                      )}
                      {row.note && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {row.note}
                        </p>
                      )}
                    </td>
                    {kind === "commissions" && (
                      <td className="whitespace-nowrap p-3">
                        {money(row.orderAmountCents)}
                        <div className="text-xs text-muted-foreground">
                          {Number(row.rateBps) / 100}%
                        </div>
                      </td>
                    )}
                    <td className="whitespace-nowrap p-3 tabular-nums">
                      {kind === "referrals"
                        ? `#${row.codeId}`
                        : money(row.amountCents)}
                    </td>
                    <td className="p-3">
                      {kind === "ledger" ? (
                        money(row.balanceAfterCents)
                      ) : kind === "referrals" ? (
                        date(row.createdAt)
                      ) : (
                        <>
                          <Badge
                            variant="secondary"
                            className="whitespace-nowrap"
                          >
                            {t(
                              AFFILIATE_STATUS_LABELS[row.status] || row.status,
                            )}
                          </Badge>
                          {kind === "commissions" &&
                            row.status === "pending" && (
                              <p className="mt-1 whitespace-nowrap text-xs text-muted-foreground">
                                {date(row.confirmAt)}
                              </p>
                            )}
                        </>
                      )}
                    </td>
                    <td className="whitespace-nowrap p-3 text-xs">
                      {date(row.createdAt)}
                    </td>
                    {admin && hasStatus && (
                      <td className="p-3">
                        <div className="flex gap-2">
                          {kind === "commissions" &&
                            row.status !== "cancelled" && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setNote("");
                                  setAction({ id: row.id, kind: "cancel" });
                                }}
                              >
                                {t("取消返佣")}
                              </Button>
                            )}
                          {kind === "withdrawals" &&
                            row.status === "pending" && (
                              <>
                                <Button
                                  size="sm"
                                  onClick={() => {
                                    setNote("");
                                    setAction({ id: row.id, kind: "paid" });
                                  }}
                                >
                                  {t("确认已打款")}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    setNote("");
                                    setAction({ id: row.id, kind: "rejected" });
                                  }}
                                >
                                  {t("驳回")}
                                </Button>
                              </>
                            )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={page} total={query.data?.total || 0} change={setPage} />
        <Dialog
          open={!!action}
          onOpenChange={(v) => {
            if (!v && !review.isPending && !cancel.isPending) setAction(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {t(
                  action?.kind === "paid"
                    ? "确认已打款"
                    : action?.kind === "cancel"
                      ? "取消返佣"
                      : "驳回提现",
                )}
              </DialogTitle>
              <DialogDescription>
                {t(
                  action?.kind === "paid"
                    ? "请先在线下完成打款，再填写交易凭证。此操作不会自动转账。"
                    : action?.kind === "cancel"
                      ? "已确认佣金将冲正扣回；若已提现或转入余额，会形成佣金欠款。"
                      : "驳回后申请金额自动退回可用佣金。",
                )}
              </DialogDescription>
            </DialogHeader>
            <Label htmlFor="affiliate-review-note">
              {t("处理说明 / 交易凭证")}
            </Label>
            <Textarea
              id="affiliate-review-note"
              value={note}
              maxLength={1000}
              onChange={(e) => setNote(e.target.value)}
            />
            <DialogFooter>
              <Button
                disabled={!note.trim() || review.isPending || cancel.isPending}
                onClick={() =>
                  action &&
                  (action.kind === "cancel"
                    ? cancel.mutate({ id: action.id, reason: note.trim() })
                    : review.mutate({
                        id: action.id,
                        status: action.kind,
                        note: note.trim(),
                      }))
                }
              >
                {t("确认")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
function UserAffiliates() {
  const query = trpc.affiliates.me.useQuery(undefined, {
    refetchOnWindowFocus: true,
  });
  const utils = trpc.useUtils();
  const [modal, setModal] = useState<"withdraw" | "transfer" | null>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"alipay" | "wxpay" | "bank">("alipay");
  const [account, setAccount] = useState("");
  const [payee, setPayee] = useState("");
  const [requestKey, setRequestKey] = useState("");
  const [qr, setQr] = useState("");
  const [qrLink, setQrLink] = useState("");
  const success = () => {
    setModal(null);
    void utils.affiliates.invalidate();
    void utils.billing.invalidate();
    toast.success(t("操作成功"));
  };
  const create = trpc.affiliates.createCode.useMutation({
    onSuccess: () => {
      void utils.affiliates.invalidate();
    },
    onError: error,
  });
  const toggle = trpc.affiliates.setCodeActive.useMutation({
    onSuccess: () => {
      void utils.affiliates.invalidate();
    },
    onError: error,
  });
  const withdraw = trpc.affiliates.requestWithdrawal.useMutation({
    onSuccess: success,
    onError: error,
  });
  const transfer = trpc.affiliates.transfer.useMutation({
    onSuccess: success,
    onError: error,
  });
  const data = query.data;
  const busy = withdraw.isPending || transfer.isPending;
  const open = (kind: "withdraw" | "transfer") => {
    setAmount(((data?.availableCents || 0) / 100).toFixed(2));
    setRequestKey(affiliateRequestKey());
    setModal(kind);
  };
  const copy = async (value: string) => {
    if (await copyTextToClipboard(value)) toast.success(t("已复制"));
    else toast.error(t("复制失败"));
  };
  // Use the configured public origin in the native app, never the WebView origin.
  const link = (code: string) =>
    `${String(data?.panelUrl || window.location.origin).replace(/\/+$/, "")}/login?mode=register&ref=${encodeURIComponent(code)}`;
  if (query.isLoading)
    return <p className="py-12 text-center">{t("加载中...")}</p>;
  if (query.error || !data)
    return <p className="text-destructive">{query.error?.message}</p>;
  const cents = Math.round(Number(amount) * 100);
  const validAmount =
    /^\d+(?:\.\d{1,2})?$/.test(amount) &&
    cents > 0 &&
    cents <= data.availableCents &&
    cents <= 100_000_000 &&
    (modal !== "withdraw" || cents >= data.config.minimumWithdrawalCents);
  return (
    <div className="space-y-5">
      {!data.enabled && (
        <p className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
          {t("推广返佣已关闭，历史佣金仍可查询和处理。")}
        </p>
      )}
      {data.blocked && (
        <p className="text-sm text-destructive">
          {t("推广账户已停用，请联系管理员处理历史佣金。")}
        </p>
      )}
      <AffiliateStats
        items={[
          {
            label: "可用佣金",
            value: money(data.availableCents),
            help: "佣金可申请提现或转入账户余额，负数表示冲正欠款。",
            icon: Wallet,
            tone: "emerald",
          },
          {
            label: "返佣比例",
            value: `${data.rateBps / 100}%`,
            help: data.config.firstOrderOnly
              ? "仅受邀用户首笔在线支付的套餐订单返佣。"
              : "受邀用户在线支付的套餐订单持续返佣。",
            icon: Percent,
            tone: "violet",
          },
          {
            label: "邀请人数",
            value: String(data.invitedCount),
            help: "通过邀请码成功注册的用户总数。",
            icon: Users,
            tone: "sky",
          },
          {
            label: "待确认佣金",
            value: money(data.pendingCents),
            help: "确认期结束后自动转入可用佣金。",
            icon: Clock,
            tone: "amber",
          },
        ]}
      />
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 space-y-1.5">
              <CardTitle>{t("邀请码管理")}</CardTitle>
              <CardDescription>
                {t("分享邀请链接，新用户注册后建立邀请关系。")}
              </CardDescription>
            </div>
            <Button
              disabled={
                !data.enabled ||
                data.blocked ||
                create.isPending ||
                data.codes.length >= data.config.maxCodes
              }
              onClick={() => create.mutate()}
            >
              <Plus className="mr-2 h-4 w-4" />
              {t("新建邀请码")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 lg:grid-cols-2">
            {data.codes.map((code) => (
              <div
                key={code.id}
                className="min-w-0 space-y-3 rounded-lg border bg-muted/25 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <code className="break-all text-sm">{code.code}</code>
                  <Badge
                    variant="secondary"
                    className="shrink-0 whitespace-nowrap"
                  >
                    {t(code.active ? "启用" : "停用")}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {date(code.createdAt)}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void copy(link(code.code))}
                  >
                    <Copy className="mr-1 h-3.5 w-3.5" />
                    {t("复制链接")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void copy(code.code)}
                  >
                    {t("复制邀请码")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={t("邀请二维码")}
                    onClick={async () => {
                      const url = link(code.code);
                      try {
                        setQr(
                          await QRCode.toDataURL(url, {
                            width: 256,
                            margin: 2,
                          }),
                        );
                        setQrLink(url);
                      } catch {
                        toast.error(t("二维码生成失败"));
                      }
                    }}
                  >
                    <QrCode className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={
                      toggle.isPending ||
                      (!code.active && (!data.enabled || data.blocked))
                    }
                    onClick={() =>
                      toggle.mutate({ id: code.id, active: !code.active })
                    }
                  >
                    {t(code.active ? "停用" : "启用")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
          {!data.codes.length && (
            <p className="py-5 text-center text-muted-foreground">
              {t("暂无邀请码")}
            </p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("佣金操作")}</CardTitle>
          <CardDescription>
            {t("最低提现金额：{0}；确认期：{1} 天。", [
              money(data.config.minimumWithdrawalCents),
              data.config.confirmationDays,
            ])}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button
            disabled={
              data.blocked ||
              data.availableCents < data.config.minimumWithdrawalCents
            }
            onClick={() => open("withdraw")}
          >
            {t("申请提现")}
          </Button>
          {data.config.allowBalanceTransfer && (
            <Button
              variant="outline"
              disabled={data.blocked || data.availableCents <= 0}
              onClick={() => open("transfer")}
            >
              {t("转入余额")}
            </Button>
          )}
        </CardContent>
      </Card>
      <Records />
      <Dialog
        open={!!modal}
        onOpenChange={(v) => {
          if (!v && !busy) setModal(null);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {t(modal === "withdraw" ? "申请提现" : "转入余额")}
            </DialogTitle>
            <DialogDescription>
              {t(
                modal === "withdraw"
                  ? "申请后金额立即扣留，由管理员审核并线下打款。"
                  : "转入余额后只能用于消费，不再支持提现。",
              )}
            </DialogDescription>
          </DialogHeader>
          <Label htmlFor="affiliate-amount">{t("金额（元）")}</Label>
          <Input
            id="affiliate-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          {modal === "withdraw" && (
            <>
              <Label>{t("收款方式")}</Label>
              <Select
                value={method}
                onValueChange={(v) => setMethod(v as typeof method)}
              >
                <SelectTrigger aria-label={t("收款方式")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="alipay">{t("支付宝")}</SelectItem>
                  <SelectItem value="wxpay">{t("微信支付")}</SelectItem>
                  <SelectItem value="bank">{t("银行卡")}</SelectItem>
                </SelectContent>
              </Select>
              <Label htmlFor="affiliate-payee">{t("收款人姓名")}</Label>
              <Input
                id="affiliate-payee"
                value={payee}
                maxLength={120}
                onChange={(e) => setPayee(e.target.value)}
              />
              <Label htmlFor="affiliate-account">
                {t("收款账号 / 开户行")}
              </Label>
              <Textarea
                id="affiliate-account"
                value={account}
                maxLength={500}
                onChange={(e) => setAccount(e.target.value)}
              />
            </>
          )}
          <DialogFooter>
            <Button
              disabled={
                busy ||
                !validAmount ||
                (modal === "withdraw" && (!payee.trim() || !account.trim()))
              }
              onClick={() =>
                modal === "withdraw"
                  ? withdraw.mutate({
                      amountCents: cents,
                      method,
                      account: account.trim(),
                      payee: payee.trim(),
                      requestKey,
                    })
                  : transfer.mutate({ amountCents: cents, requestKey })
              }
            >
              {t(busy ? "处理中..." : "确认")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!qr}
        onOpenChange={(v) => {
          if (!v) setQr("");
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("邀请二维码")}</DialogTitle>
            <DialogDescription>{t("扫码打开注册页面")}</DialogDescription>
          </DialogHeader>
          <img
            className="mx-auto h-64 max-w-full rounded-md object-contain"
            src={qr}
            alt={t("邀请二维码")}
          />
          <p className="break-all text-xs text-muted-foreground">{qrLink}</p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
function AdminAffiliates({ settingsOpen, onSettingsOpenChange }: {
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
}) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  const query = trpc.affiliates.adminOverview.useQuery({
    page,
    search: debounced,
  });
  const utils = trpc.useUtils();
  const data = query.data;
  const [config, setConfig] = useState<AffiliateConfig>({
    ...AFFILIATE_DEFAULTS,
  });
  const [dirty, setDirty] = useState(false);
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (data && (!settingsOpen || !dirty)) {
      setConfig(data.config);
      setEnabled(data.enabled);
    }
    if (!settingsOpen) setDirty(false);
  }, [data, dirty, settingsOpen]);
  const [edit, setEdit] = useState<{
    userId: number;
    blocked: boolean;
    rate: string;
  } | null>(null);
  const save = trpc.affiliates.saveConfig.useMutation({
    onSuccess: (_, saved) => {
      const { enabled: savedEnabled, ...savedConfig } = saved;
      utils.affiliates.adminOverview.setData({ page, search: debounced }, (old) =>
        old ? { ...old, config: savedConfig, enabled: savedEnabled } : old,
      );
      setDirty(false);
      onSettingsOpenChange(false);
      void utils.affiliates.invalidate();
      toast.success(t("已保存"));
    },
    onError: error,
  });
  const update = trpc.affiliates.updateAccount.useMutation({
    onSuccess: () => {
      setEdit(null);
      void utils.affiliates.invalidate();
      toast.success(t("已保存"));
    },
    onError: error,
  });
  const change = <K extends keyof AffiliateConfig>(
    key: K,
    value: AffiliateConfig[K],
  ) => {
    setDirty(true);
    setConfig((old) => ({ ...old, [key]: value }));
  };
  const valid =
    Number.isInteger(config.rateBps) &&
    config.rateBps >= 0 &&
    config.rateBps <= 10000 &&
    Number.isInteger(config.confirmationDays) &&
    config.confirmationDays >= 0 &&
    config.confirmationDays <= 365 &&
    Number.isInteger(config.minimumWithdrawalCents) &&
    config.minimumWithdrawalCents > 0 &&
    config.minimumWithdrawalCents <= 100_000_000 &&
    Number.isInteger(config.maxCodes) &&
    config.maxCodes >= 1 &&
    config.maxCodes <= 50;
  return (
    <div className="space-y-5">
      {query.isLoading && <p>{t("加载中...")}</p>}
      {query.error && <p className="text-destructive">{query.error.message}</p>}
      <p className="rounded-md border bg-muted/25 p-4 text-sm text-muted-foreground">
        {t(
          data?.enabled
            ? "推广返佣已开启，可在右上角设置中调整。"
            : "推广返佣默认关闭，可在右上角设置中开启。关闭后仍可处理历史佣金。",
        )}
      </p>
      <AffiliateStats
        items={[
          {
            label: "累计确认佣金",
            value: money(data?.totals?.confirmedCents),
            help: "不含已取消的返佣。",
            icon: Wallet,
            tone: "emerald",
          },
          {
            label: "待确认佣金",
            value: money(data?.totals?.pendingCents),
            help: "确认期结束后自动转入可用佣金。",
            icon: Clock,
            tone: "amber",
          },
          {
            label: "邀请人数",
            value: String(data?.totals?.totalInvites || 0),
            help: "通过邀请码成功注册的用户总数。",
            icon: Users,
            tone: "sky",
          },
          {
            label: "待审核提现",
            value: money(data?.totals?.pendingWithdrawals),
            help: "申请金额已从可用佣金扣留。",
            icon: Wallet,
            tone: "violet",
          },
        ]}
      />
      <Dialog open={settingsOpen} onOpenChange={(open) => {
        if (!save.isPending) onSettingsOpenChange(open);
      }}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("返佣设置")}</DialogTitle>
            <DialogDescription>
              {t(
                "仅按 CNY 在线支付的套餐订单实付金额计佣；充值、余额消费、赠送及测试订单不计佣。设置调整不影响已生成佣金。",
              )}
            </DialogDescription>
          </DialogHeader>
          <fieldset disabled={!data || save.isPending} className="min-w-0 space-y-4">
            <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/25 p-4">
              <div className="space-y-1">
                <Label htmlFor="affiliate-enabled">{t("启用推广返佣")}</Label>
                <p className="text-xs text-muted-foreground">
                  {t("控制新邀请和新订单返佣，关闭后仍可处理历史佣金。菜单显示在系统设置中单独控制。")}
                </p>
              </div>
              <Switch id="affiliate-enabled" className="shrink-0" checked={enabled} onCheckedChange={(value) => {
                setEnabled(value);
                setDirty(true);
              }} />
            </div>
            <div className="grid min-w-0 grid-cols-2 gap-3 [&>*]:min-w-0">
              <div className="space-y-2">
                <Label htmlFor="affiliate-rate">{t("默认返佣比例（%）")}</Label>
                <Input
                  id="affiliate-rate"
                  type="number"
                  min={0}
                  max={100}
                  step={0.01}
                  value={config.rateBps / 100}
                  onChange={(e) =>
                    change("rateBps", Math.round(Number(e.target.value) * 100))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="affiliate-days">{t("确认期（天）")}</Label>
                <Input
                  id="affiliate-days"
                  type="number"
                  min={0}
                  max={365}
                  value={config.confirmationDays}
                  onChange={(e) =>
                    change("confirmationDays", Number(e.target.value))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="affiliate-minimum">
                  {t("最低提现金额（元）")}
                </Label>
                <Input
                  id="affiliate-minimum"
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={config.minimumWithdrawalCents / 100}
                  onChange={(e) =>
                    change(
                      "minimumWithdrawalCents",
                      Math.round(Number(e.target.value) * 100),
                    )
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="affiliate-maxcodes">{t("每人邀请码上限")}</Label>
                <Input
                  id="affiliate-maxcodes"
                  type="number"
                  min={1}
                  max={50}
                  value={config.maxCodes}
                  onChange={(e) => change("maxCodes", Number(e.target.value))}
                />
              </div>
            </div>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="affiliate-first">{t("仅首单返佣")}</Label>
              <Switch
                id="affiliate-first"
                checked={config.firstOrderOnly}
                onCheckedChange={(v) => change("firstOrderOnly", v)}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="affiliate-transfer">{t("允许佣金转入余额")}</Label>
              <Switch
                id="affiliate-transfer"
                checked={config.allowBalanceTransfer}
                onCheckedChange={(v) => change("allowBalanceTransfer", v)}
              />
            </div>
          </fieldset>
          <DialogFooter className="gap-2">
            <Button variant="outline" disabled={save.isPending} onClick={() => onSettingsOpenChange(false)}>{t("取消")}</Button>
            <Button disabled={!data || !dirty || !valid || save.isPending} onClick={() => save.mutate({ ...config, enabled })}>
              {t(save.isPending ? "保存中..." : "保存设置")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Card>
        <CardHeader>
          <CardTitle>{t("推广用户")}</CardTitle>
          <Input
            value={search}
            maxLength={100}
            placeholder={t("搜索用户名或名称")}
            aria-label={t("搜索用户名或名称")}
            onChange={(e) => setSearch(e.target.value)}
          />
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[540px] text-left text-sm">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="p-3">{t("用户")}</th>
                  <th className="p-3">{t("可用佣金")}</th>
                  <th className="p-3">{t("邀请人数")}</th>
                  <th className="p-3">{t("返佣比例")}</th>
                  <th className="p-3">{t("状态")}</th>
                  <th className="p-3">{t("操作")}</th>
                </tr>
              </thead>
              <tbody>
                {data?.accounts.map((row) => (
                  <tr key={row.userId} className="border-b last:border-0">
                    <td className="max-w-64 break-all p-3">
                      {row.name || row.username || t("已删除用户")}
                      <div className="text-xs text-muted-foreground">
                        #{row.userId} · {row.username}
                      </div>
                    </td>
                    <td className="whitespace-nowrap p-3">
                      {money(row.availableCents)}
                    </td>
                    <td className="p-3">{row.invites}</td>
                    <td className="p-3">
                      {row.rateBps == null
                        ? t("默认")
                        : `${Number(row.rateBps) / 100}%`}
                    </td>
                    <td className="p-3">{t(row.blocked ? "停用" : "启用")}</td>
                    <td className="p-3">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setEdit({
                            userId: row.userId,
                            blocked: !!row.blocked,
                            rate:
                              row.rateBps == null
                                ? ""
                                : String(Number(row.rateBps) / 100),
                          })
                        }
                      >
                        {t("编辑")}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} total={data?.total || 0} change={setPage} />
        </CardContent>
      </Card>
      <Records admin />
      <Dialog
        open={!!edit}
        onOpenChange={(v) => {
          if (!v && !update.isPending) setEdit(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("推广账户设置")}</DialogTitle>
            <DialogDescription>
              {t(
                "独立比例留空时使用默认比例；停用后禁止新增返佣、提现和转余额。",
              )}
            </DialogDescription>
          </DialogHeader>
          <Label htmlFor="affiliate-user-rate">{t("独立返佣比例（%）")}</Label>
          <Input
            id="affiliate-user-rate"
            type="number"
            min={0}
            max={100}
            step={0.01}
            value={edit?.rate || ""}
            onChange={(e) => edit && setEdit({ ...edit, rate: e.target.value })}
          />
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="affiliate-blocked">{t("停用推广账户")}</Label>
            <Switch
              id="affiliate-blocked"
              checked={edit?.blocked || false}
              onCheckedChange={(v) => edit && setEdit({ ...edit, blocked: v })}
            />
          </div>
          <DialogFooter>
            <Button
              disabled={
                update.isPending ||
                (!!edit?.rate &&
                  (!/^\d+(?:\.\d{1,2})?$/.test(edit.rate) ||
                    Number(edit.rate) > 100))
              }
              onClick={() =>
                edit &&
                update.mutate({
                  userId: edit.userId,
                  blocked: edit.blocked,
                  rateBps:
                    edit.rate === ""
                      ? null
                      : Math.round(Number(edit.rate) * 100),
                })
              }
            >
              {t("保存")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
export default function AffiliatesPage({ admin = false }: { admin?: boolean }) {
  const { user } = useAuth();
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <DashboardLayout>
      <div className="w-full min-w-0 space-y-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">
              {t(admin ? "推广管理" : "推广返佣")}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {t(
                admin
                  ? "管理邀请关系、返佣结算和提现审核。"
                  : "邀请好友使用 ForwardX，获得套餐订单返佣。",
              )}
            </p>
          </div>
          {admin && user?.role === "admin" && (
            <Button variant="outline" className="shrink-0" onClick={() => setSettingsOpen(true)}>
              <Settings2 className="mr-2 h-4 w-4" />{t("设置")}
            </Button>
          )}
        </div>
        {user &&
          (admin && user.role === "admin" ? (
            <AdminAffiliates settingsOpen={settingsOpen} onSettingsOpenChange={setSettingsOpen} />
          ) : (
            <UserAffiliates />
          ))}
      </div>
    </DashboardLayout>
  );
}
