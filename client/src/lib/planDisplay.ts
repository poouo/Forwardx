import { t as translateText } from "@/i18n";
type PlanResourceSummary = {
  hostIds?: unknown[];
  tunnelIds?: unknown[];
  forwardGroupIds?: unknown[];
};

export function planDescription(plan: { description?: unknown } | null | undefined) {
  return typeof plan?.description === "string" ? plan.description.trim() : "";
}

export function planResourceParts(plan: PlanResourceSummary) {
  return [
    { label: translateText("历史主机"), count: plan.hostIds?.length || 0 },
    { label: translateText("隧道"), count: plan.tunnelIds?.length || 0 },
    { label: translateText("转发资源"), count: plan.forwardGroupIds?.length || 0 },
  ].filter((item) => item.count > 0);
}

export function planResourceText(plan: PlanResourceSummary) {
  const parts = planResourceParts(plan);
  return parts.length ? parts.map((item) => `${item.count} ${item.label}`).join(" / ") : translateText("未绑定资源");
}
