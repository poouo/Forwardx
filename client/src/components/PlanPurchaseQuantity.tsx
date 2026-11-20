import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Minus, Plus } from "lucide-react";
import { MAX_PLAN_PURCHASE_QUANTITY, planPurchaseTotals } from "@shared/planPurchase";

export function planPurchaseQuote(plan: any, quantity: string) {
  if (!plan) return null;
  try { return planPurchaseTotals(Number(plan.priceCents || 0), Number(plan.durationDays), Number(quantity)); }
  catch { return null; }
}

export function discountQuoteKey(planId: number | undefined, amountCents: number | undefined, code: string) {
  return JSON.stringify([planId, amountCents, code.trim().toUpperCase()]);
}

export function PlanPurchaseQuantity({ value, onChange, durationDays, disabled, valid }: {
  value: string; onChange: (value: string) => void; durationDays: number; disabled: boolean; valid: boolean;
}) {
  const permanent = durationDays === 0;
  const max = permanent ? 1 : MAX_PLAN_PURCHASE_QUANTITY;
  return (
    <div className="space-y-2 rounded-lg border p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="plan-purchase-quantity">{t("购买期数")}</Label>
        <span id="plan-purchase-help" className="text-xs text-muted-foreground">
          {permanent ? t("永久有效") : t("每期 {0} 天", [durationDays])}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="icon" className="shrink-0" aria-label={t("减少购买期数")}
          disabled={disabled || Number(value) <= 1} onClick={() => onChange(String(Math.max(1, Math.min(max, (Number(value) || 1) - 1))))}>
          <Minus className="h-4 w-4" />
        </Button>
        <div className="relative min-w-0 flex-1">
          <Input id="plan-purchase-quantity" type="number" inputMode="numeric" min={1} max={max} step={1}
            value={value} onChange={event => onChange(event.target.value)} disabled={disabled || permanent}
            aria-invalid={!valid} aria-describedby="plan-purchase-help"
            className="px-9 text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-muted-foreground">{t("期")}</span>
        </div>
        <Button type="button" variant="outline" size="icon" className="shrink-0" aria-label={t("增加购买期数")}
          disabled={disabled || Number(value) >= max} onClick={() => onChange(String(Math.min(max, Math.max(1, (Number(value) || 0) + 1))))}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      <p className={`text-xs ${valid ? "text-muted-foreground" : "text-destructive"}`}>
        {valid ? permanent ? t("永久套餐只能购买一期") : t("共 {0} 天，仅延长有效期，流量及其他额度不叠加。", [durationDays * Number(value)])
          : t("请输入有效购买期数（1–{0}）", [max])}
      </p>
    </div>
  );
}
