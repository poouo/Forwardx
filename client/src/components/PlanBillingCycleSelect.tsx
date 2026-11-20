import { t, getFormatLocale } from "@/i18n";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { PlanCyclePrice } from "@shared/planPurchase";

export function billingCycleLabel(days: number) {
  switch (days) {
    case 30: return t("月付");
    case 90: return t("季付");
    case 180: return t("半年付");
    case 365: return t("年付");
    case 730: return t("两年付");
    case 0: return t("永久有效");
    default: return t("{0} 天", [days]);
  }
}

export function PlanBillingCycleSelect({ options, value, currency = "CNY", onChange, disabled }: {
  options: PlanCyclePrice[];
  value: number;
  currency?: string;
  onChange: (days: number) => void;
  disabled: boolean;
}) {
  const selected = options.find(option => option.durationDays === value);
  if (options.length === 0) return null;
  const amount = new Intl.NumberFormat(getFormatLocale(), { style: "currency", currency });
  const percentage = new Intl.NumberFormat(getFormatLocale(), { maximumFractionDigits: 2 });
  return (
    <div className="space-y-2">
      {options.length > 1 ? <>
        <Label htmlFor="plan-billing-cycle">{t("付款周期")}</Label>
        <Select value={String(value)} onValueChange={(days) => onChange(Number(days))} disabled={disabled}>
          <SelectTrigger id="plan-billing-cycle"><SelectValue /></SelectTrigger>
          <SelectContent>
            {options.map(option => (
              <SelectItem key={option.durationDays} value={String(option.durationDays)}>
                {billingCycleLabel(option.durationDays)} · {amount.format(option.priceCents / 100)}
                {option.discountPercent != null && ` · ${t("优惠 {0}%", [percentage.format(option.discountPercent)])}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </> : selected && (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="text-muted-foreground">{t("付款周期")}</span>
          <span className="font-medium">{billingCycleLabel(selected.durationDays)}</span>
        </div>
      )}
      {selected?.discountPercent != null && selected.referencePriceCents != null && (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md bg-emerald-500/10 px-3 py-2 text-sm" aria-live="polite">
          <span className="font-medium text-emerald-700 dark:text-emerald-400">{t("优惠 {0}%", [percentage.format(selected.discountPercent)])}</span>
          <s className="text-muted-foreground">{amount.format(selected.referencePriceCents / 100)}</s>
          <span className="font-semibold">{amount.format(selected.priceCents / 100)}</span>
        </div>
      )}
    </div>
  );
}
