type PlanResourceSummary = {
  hostIds?: unknown[];
  tunnelIds?: unknown[];
  forwardGroupIds?: unknown[];
};

export function planResourceParts(plan: PlanResourceSummary) {
  return [
    { label: "历史主机", count: plan.hostIds?.length || 0 },
    { label: "隧道", count: plan.tunnelIds?.length || 0 },
    { label: "转发资源", count: plan.forwardGroupIds?.length || 0 },
  ].filter((item) => item.count > 0);
}

export function planResourceText(plan: PlanResourceSummary) {
  const parts = planResourceParts(plan);
  return parts.length ? parts.map((item) => `${item.count} ${item.label}`).join(" / ") : "未绑定资源";
}
