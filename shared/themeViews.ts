import { z } from "zod";
import { THEME_FIELDS, type ThemeField } from "./themeFields";

export type ThemeText = string | { "zh-CN"?: string; en?: string };
export const themeTextSchema = z.union([z.string().max(500), z.object({ "zh-CN": z.string().max(500).optional(), en: z.string().max(500).optional() }).strict().refine(value => value.en !== undefined || value["zh-CN"] !== undefined)]);
const columns = z.object({ mobile: z.number().int().min(1).max(4).optional(), tablet: z.number().int().min(1).max(6).optional(), desktop: z.number().int().min(1).max(6).optional() }).strict();
export type ThemeColumns = z.infer<typeof columns>;
const common = {
  id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/).optional(),
  when: z.enum(["always", "online", "offline"]).optional(),
  span: z.number().int().min(1).max(6).optional(),
};
const field = z.object({
  ...common, type: z.literal("field"), field: z.enum(Object.keys(THEME_FIELDS) as [ThemeField, ...ThemeField[]]),
  when: z.enum(["always", "online", "offline", "available"]).optional(),
  label: z.union([themeTextSchema, z.literal(false)]).optional(),
  display: z.enum(["text", "stat", "progress", "badge"]).optional(),
  precision: z.number().int().min(0).max(3).optional(), missing: themeTextSchema.optional(),
  prefix: themeTextSchema.optional(), suffix: themeTextSchema.optional(),
  tone: z.enum(["default", "muted", "success", "warning", "danger"]).optional(),
}).strict().refine(node => node.display !== "progress" || THEME_FIELDS[node.field].format === "percent", "进度条只能绑定百分比字段");
const text = z.object({ ...common, type: z.literal("text"), text: themeTextSchema, variant: z.enum(["title", "body", "muted"]).optional() }).strict();
export type ThemeNode = (z.infer<typeof field> | z.infer<typeof text> | {
  type: "group"; id?: string; when?: "always" | "online" | "offline"; span?: number;
  direction?: "row" | "column" | "grid"; columns?: ThemeColumns; gap?: number; children: ThemeNode[];
});
function nodeSchema(depth: number): z.ZodType<ThemeNode> {
  if (!depth) return z.union([field, text]);
  return z.union([field, text, z.object({
    ...common, type: z.literal("group"), direction: z.enum(["row", "column", "grid"]).optional(), columns: columns.optional(), gap: z.number().int().min(0).max(48).optional(),
    children: z.array(nodeSchema(depth - 1)).min(1).max(24),
  }).strict()]);
}
export const themeNodeSchema = nodeSchema(5).superRefine((node, context) => {
  let count = 0;
  const ids = new Set<string>();
  const walk = (item: ThemeNode) => {
    count++;
    if (item.id) {
      if (ids.has(item.id)) context.addIssue({ code: "custom", message: `重复布局节点 ID：${item.id}` });
      ids.add(item.id);
    }
    if (item.type === "group") item.children.forEach(walk);
  };
  walk(node);
  if (count > 128) context.addIssue({ code: "custom", message: "每个模板最多 128 个节点" });
});
const pageNode = themeNodeSchema.refine(node => {
  const hasHost = (item: ThemeNode): boolean => item.when === "online" || item.when === "offline" || (item.type === "field" ? THEME_FIELDS[item.field].scope === "host" : item.type === "group" && item.children.some(hasHost));
  return !hasHost(node);
}, "页面级模板不能使用单台主机字段或在线条件，请在 card 模板中使用");
const loginNode = themeNodeSchema.refine(node => {
  const valid = (item: ThemeNode): boolean => item.when !== "online" && item.when !== "offline" && (item.type === "field" ? THEME_FIELDS[item.field].scope === "shared" : item.type !== "group" || item.children.every(valid));
  return valid(node);
}, "登录页模板只支持 site 和 viewer 公共字段");
export const themeViewsSchema = z.object({
  shell: z.object({ navigation: z.enum(["left", "right"]).optional(), contentWidth: z.number().int().min(640).max(2560).optional(), sidebarWidth: z.number().int().min(180).max(400).optional(), spacing: z.enum(["compact", "comfortable"]).optional() }).strict().optional(),
  login: z.object({
    layout: z.enum(["split", "reversed", "centered"]).optional(), showArtwork: z.boolean().optional(), showFeatures: z.boolean().optional(),
    eyebrow: themeTextSchema.optional(), heroTitle: themeTextSchema.optional(), heroDescription: themeTextSchema.optional(),
    loginTitle: themeTextSchema.optional(), registerTitle: themeTextSchema.optional(), loginSubtitle: themeTextSchema.optional(), registerSubtitle: themeTextSchema.optional(),
    usernameLabel: themeTextSchema.optional(), usernamePlaceholder: themeTextSchema.optional(), passwordLabel: themeTextSchema.optional(), passwordPlaceholder: themeTextSchema.optional(),
    loginButton: themeTextSchema.optional(), registerButton: themeTextSchema.optional(), registerLink: themeTextSchema.optional(), loginLink: themeTextSchema.optional(),
    registerUsernamePlaceholder: themeTextSchema.optional(), registerPasswordPlaceholder: themeTextSchema.optional(),
    nicknameLabel: themeTextSchema.optional(), nicknamePlaceholder: themeTextSchema.optional(), confirmPasswordLabel: themeTextSchema.optional(), confirmPasswordPlaceholder: themeTextSchema.optional(),
    emailLabel: themeTextSchema.optional(), emailPlaceholder: themeTextSchema.optional(), registrationNote: themeTextSchema.optional(),
    hero: loginNode.optional(), beforeForm: loginNode.optional(), afterForm: loginNode.optional(), features: z.array(themeTextSchema).max(6).optional(),
    footer: themeTextSchema.optional(),
  }).strict().optional(),
  hosts: z.object({
    title: themeTextSchema.optional(), defaultView: z.enum(["card", "compact-card", "table", "map", "flat-map"]).optional(),
    cardLayout: z.enum(["grid", "rows"]).optional(), columns: columns.optional(), gap: z.number().int().min(0).max(48).optional(),
    showSummary: z.boolean().optional(), sections: z.array(z.enum(["intro", "summary", "groups", "list", "outro"])).length(5).refine(value => new Set(value).size === 5, "页面区域必须各出现一次").optional(),
    intro: pageNode.optional(), outro: pageNode.optional(), card: themeNodeSchema.optional(), actionsPlacement: z.enum(["header", "footer"]).optional(),
  }).strict().optional(),
}).strict();
export type ThemeViews = z.infer<typeof themeViewsSchema>;

export function themeText(value: ThemeText | undefined, language: string, fallback = "") {
  if (typeof value === "string") return value;
  return value?.[language === "en" ? "en" : "zh-CN"] ?? value?.["zh-CN"] ?? value?.en ?? fallback;
}

/** A working example, not enabled for legacy CSS-only packages. */
export function themeHostCardExample(): ThemeNode {
  return { type: "group", id: "host-body", direction: "column", gap: 16, children: [
    { type: "group", direction: "row", children: [{ type: "field", field: "host.name", display: "stat", label: false }, { type: "field", field: "host.online", display: "badge", label: false }] },
    { type: "group", direction: "grid", columns: { mobile: 1, tablet: 2, desktop: 2 }, gap: 12, children: [
      { type: "field", field: "host.address" }, { type: "field", field: "host.region" },
      { type: "field", field: "host.cpuUsage", display: "progress" }, { type: "field", field: "host.memoryUsage", display: "progress" },
      { type: "field", field: "host.networkInSpeed", display: "stat" }, { type: "field", field: "host.networkOutSpeed", display: "stat" },
      { type: "field", field: "host.trafficUsed" }, { type: "field", field: "host.remainingDays", when: "available" },
    ] },
  ] };
}
