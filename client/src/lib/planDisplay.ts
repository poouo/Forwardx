import { t as translateText } from "@/i18n";
import { looksLikeHtml, markdownToHtml } from "@/lib/htmlContent";
import { sanitizeHtml } from "@shared/htmlSanitizer";

export function renderPlanDescriptionHtml(content: string) {
  // Code samples containing HTML remain escaped Markdown, not an HTML document.
  const outsideCode = content.replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g, "");
  return sanitizeHtml(looksLikeHtml(outsideCode) ? content : markdownToHtml(content));
}

export function planDescriptionTemplate(kind: "subscription" | "metered" = "subscription") {
  if (kind === "metered") return translateText("## 按量计费介绍\n\n在这里介绍适用场景与服务特色。\n\n### 服务亮点\n- **线路特色**：填写节点或线路介绍\n- **计费方式**：填写流量单价与倍率说明\n- **售后支持**：填写联系方式或服务时间\n\n> 使用前请确认计费方式和使用规则，实际费用以系统配置为准。");
  return translateText("## 套餐介绍\n\n在这里介绍套餐适用场景与服务特色。\n\n### 服务亮点\n- **线路特色**：填写节点或线路介绍\n- **使用额度**：填写流量、端口或速率说明\n- **售后支持**：填写联系方式或服务时间\n\n> 购买前请确认套餐权益和使用规则。");
}
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
