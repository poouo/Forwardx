import { t } from "@/i18n";
import { trpc } from "@/lib/trpc";

export default function PaymentFeeBreakdown({
  amountCents,
  paymentType,
  currency = "CNY",
  enabled,
}: {
  amountCents: number;
  paymentType: "alipay" | "wxpay" | "stripe" | "usdt";
  currency?: string;
  enabled: boolean;
}) {
  const { data } = trpc.payment.feeQuote.useQuery({ amountCents: Math.max(0, Math.round(amountCents)), paymentType }, {
    enabled: enabled && amountCents > 0,
  });
  if (!enabled || !data?.enabled || data.feeCents <= 0) return null;
  const money = (cents: number) => `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;

  return (
    <div className="space-y-1 border-t border-border/50 pt-2 text-sm">
      <div className="flex items-center justify-between text-muted-foreground">
        <span>{t("支付通道费用")}</span>
        <span>{money(data.feeCents)}</span>
      </div>
      <div className="flex items-center justify-between font-medium">
        <span>{t("在线支付实付")}</span>
        <span>{money(data.totalAmountCents)}</span>
      </div>
    </div>
  );
}
