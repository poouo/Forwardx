import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { t } from "@/i18n";
import { trpc } from "@/lib/trpc";
import { toast } from "@/lib/localizedToast";
import { paymentCheckoutState, paymentPageUrl, paymentQrContent, type CheckoutOrder } from "@/lib/paymentCheckout";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export default function PaymentCheckoutDialog({ order, onClose }: { order: CheckoutOrder | null; onClose: () => void }) {
  const utils = trpc.useUtils();
  const handled = useRef<string | null>(null);
  const [qr, setQr] = useState<{ content: string; data?: string; failed?: boolean } | null>(null);
  const content = order ? paymentQrContent(order) : null;
  const pageUrl = paymentPageUrl(order?.payUrl);
  const { data, isError } = trpc.payment.queryOrder.useQuery({ outTradeNo: order?.outTradeNo || "" }, {
    enabled: !!order,
    refetchInterval: query => paymentCheckoutState(query.state.data?.status) === "completed" || paymentCheckoutState(query.state.data?.status) === "closed" ? false : 3000,
    refetchIntervalInBackground: false,
    retry: false,
    // A previously cached order status must not be mistaken for a new result.
    staleTime: 0,
  });
  const state = paymentCheckoutState(data?.status);

  useEffect(() => {
    let active = true;
    setQr(null);
    if (content) QRCode.toDataURL(content, { width: 240, margin: 1 }).then(
      data => { if (active) setQr({ content, data }); },
      () => { if (active) setQr({ content, failed: true }); },
    );
    return () => { active = false; };
  }, [content]);

  useEffect(() => {
    if (!order || state !== "completed" || handled.current === order.outTradeNo) return;
    handled.current = order.outTradeNo;
    toast.success(t("支付成功！"));
    void utils.payment.myOrders.invalidate();
    void utils.payment.stats.invalidate();
    void utils.billing.me.invalidate();
    void utils.billing.ledger.invalidate();
    void utils.billing.ledgerPage.invalidate();
    void utils.billing.listTransactionsPage.invalidate();
    void utils.plans.mySubscriptions.invalidate();
    void utils.plans.storeList.invalidate();
    onClose();
  }, [order, state, onClose, utils]);

  return <Dialog open={!!order} onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>{content ? t("扫码支付") : t("去支付")}</DialogTitle>
        <DialogDescription>{order?.subject || t("请使用支付宝或微信扫码完成支付")}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col items-center gap-3 py-2">
        {content && state === "pending" && (qr?.content === content && qr.data
          ? <div className="rounded-lg border bg-white p-3"><img src={qr.data} alt={t("支付二维码")} width={240} height={240} /></div>
          : <p className="text-sm text-muted-foreground">{qr?.content === content && qr.failed ? t("支付二维码生成失败，请重新下单或联系管理员") : t("正在生成支付二维码")}</p>)}
        {pageUrl && state === "pending" && <Button asChild><a href={pageUrl} target="_blank" rel="noopener noreferrer">{t("打开支付页")}</a></Button>}
        {!content && !pageUrl && <p className="text-sm text-destructive">{t("支付渠道未返回可用的支付链接，请联系管理员")}</p>}
        <p role="status" className="text-center text-sm text-muted-foreground">
          {state === "processing" ? t("已付款，正在入账，请稍候") : state === "closed" ? t("订单已失效，请重新下单") : isError || data?.reconciliationFailed ? t("支付状态查询失败，正在重试，请勿重复付款") : t("正在等待支付结果……")}
        </p>
        <p className="break-all text-xs text-muted-foreground">{order?.outTradeNo}</p>
      </div>
      <DialogFooter><Button variant="outline" onClick={onClose}>{t("关闭")}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
