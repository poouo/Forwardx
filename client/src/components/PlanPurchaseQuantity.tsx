import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Minus, Plus } from "lucide-react";
import { MAX_PLAN_PURCHASE_QUANTITY, planCyclePurchaseTotals } from "@shared/planPurchase";

export function planPurchaseQuote(plan: Parameters<typeof planCyclePurchaseTotals>[0] | null | undefined, quantity: string, billingCycleDays?: number) {
  if (!plan) return null;
  try { return planCyclePurchaseTotals(plan, Number(quantity), billingCycleDays); }
  catch { return null; }
}

export function discountQuoteKey(planId: number | undefined, amountCents: number | undefined, code: string) {
  return JSON.stringify([planId, amountCents, code.trim().toUpperCase()]);
}

export function PlanPurchaseQuantity({ value, onChange, durationDays, disabled, valid, showTotalDuration = true }: {
  value: string; onChange: (value: string) => void; durationDays: number; disabled: boolean; valid: boolean; showTotalDuration?: boolean;
}) {
  const max = MAX_PLAN_PURCHASE_QUANTITY;
  const showHelp = !valid || showTotalDuration;
  return (
    <div className="space-y-2 rounded-lg border p-3 text-sm">
      <Label htmlFor="plan-purchase-quantity">{t("购买数量")}</Label>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="icon" className="shrink-0" aria-label={t("减少购买数量")}
          disabled={disabled || Number(value) <= 1} onClick={() => onChange(String(Math.max(1, Math.min(max, (Number(value) || 1) - 1))))}>
          <Minus className="h-4 w-4" />
        </Button>
        <Input id="plan-purchase-quantity" type="number" inputMode="numeric" min={1} max={max} step={1}
          value={value} onChange={event => onChange(event.target.value)} disabled={disabled}
          aria-invalid={!valid} aria-describedby={showHelp ? "plan-purchase-help" : undefined}
          className="min-w-0 flex-1 text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
        <Button type="button" variant="outline" size="icon" className="shrink-0" aria-label={t("增加购买数量")}
          disabled={disabled || Number(value) >= max} onClick={() => onChange(String(Math.min(max, Math.max(1, (Number(value) || 0) + 1))))}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      {showHelp && <p id="plan-purchase-help" className={`text-xs ${valid ? "text-muted-foreground" : "text-destructive"}`}>
        {valid ? t("共 {0} 天", [durationDays * Number(value)])
          : t("请选择有效数量")}
      </p>}
    </div>
  );
}
