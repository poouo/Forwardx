import { t } from "@/i18n";
import { planPortCountText, planRateLimitText, planResourceText, planTrafficQuotaText } from "@/lib/planDisplay";
import { PlanDetails } from "./PlanDetails";
import { PlanTrafficModeBadge } from "./PlanTrafficMode";

type PlanBenefits = Parameters<typeof planResourceText>[0] & {
  description?: string | null;
  portCount: number;
  trafficLimit: number;
  trafficMode?: string | null;
  rateLimitMbps: number;
  maxRules: number;
  maxConnections: number;
  maxIPs: number;
};

export function PlanCheckoutBenefits({ plan, durationDays }: { plan: PlanBenefits; durationDays?: number }) {
  const limitedTraffic = plan.trafficLimit > 0;
  const spansMonths = durationDays !== undefined && (durationDays === 0 || durationDays > 30);
  const validity = durationDays === undefined ? "—" : durationDays === 0 ? t("永久有效") : t("{0} 天", [durationDays]);

  return (
    <section className="min-w-0 space-y-2.5 rounded-lg border border-border/60 bg-muted/20 p-3 text-sm">
      <dl className="space-y-1.5" aria-live="polite">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">{t("本次购买时长")}</dt>
          <dd className="font-medium tabular-nums">{validity}</dd>
        </div>
        {limitedTraffic && spansMonths && <div className="text-xs text-muted-foreground">
          <dt className="sr-only">{t("流量周期")}</dt>
          <dd>{t("流量按月重置，重置日以订阅为准。")}</dd>
        </div>}
      </dl>
      <div className="space-y-2 border-t border-border/50 pt-2">
        <PlanDetails description={plan.description}>
          <h3 className="font-medium">{t("套餐权益")}</h3>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2 [&>div]:min-w-0 [&_dd]:break-words [&_dd]:font-medium [&_dt]:text-xs [&_dt]:text-muted-foreground">
            <div>
              <dt>{t("流量额度")}</dt>
              <dd className="flex flex-wrap items-center gap-1">
                {planTrafficQuotaText(plan.trafficLimit)}
                {limitedTraffic && <PlanTrafficModeBadge mode={plan.trafficMode} />}
              </dd>
            </div>
            <div>
              <dt>{t("连续端口数")}</dt>
              <dd>{planPortCountText(plan.portCount)}</dd>
            </div>
            <div>
              <dt>{t("限速")}</dt>
              <dd>{planRateLimitText(plan.rateLimitMbps)}</dd>
            </div>
            <div>
              <dt>{t("可用资源")}</dt>
              <dd>{planResourceText(plan)}</dd>
            </div>
          </dl>
          <p className="break-words text-xs text-muted-foreground">
            {t("规则 {0} · 连接 {1} · IP {2}", [plan.maxRules || t("不限"), plan.maxConnections || t("不限"), plan.maxIPs || t("不限")])}
          </p>
        </PlanDetails>
      </div>
    </section>
  );
}
