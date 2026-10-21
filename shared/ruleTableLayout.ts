import { z } from "zod";

export const RULE_TABLE_COLUMNS = [
  { id: "status", label: "状态", width: 56, min: 48, max: 120 },
  { id: "name", label: "规则", width: 140, min: 96, max: 600, required: true },
  { id: "owner", label: "用户", width: 110, min: 96, max: 400, adminOnly: true },
  { id: "resource", label: "所属资源", width: 110, min: 96, max: 500 },
  { id: "groups", label: "所属分组", width: 170, min: 100, max: 500 },
  { id: "entry", label: "转发入口", width: 285, min: 140, max: 900 },
  { id: "exit", label: "转发出口", width: 190, min: 140, max: 900 },
  { id: "route", label: "链路", width: 170, min: 120, max: 600 },
  { id: "protocol", label: "协议", width: 96, min: 88, max: 300 },
  { id: "total", label: "累计", width: 140, min: 112, max: 500 },
  { id: "quota", label: "规则额度", width: 200, min: 112, max: 500 },
  { id: "daily", label: "24H", width: 120, min: 104, max: 400 },
  { id: "latency", label: "延迟", width: 120, min: 104, max: 400 },
  { id: "enabled", label: "开关", width: 70, min: 64, max: 160 },
  { id: "actions", label: "操作", width: 200, min: 200, max: 500, required: true },
] as const;
export type RuleTableColumnId = typeof RULE_TABLE_COLUMNS[number]["id"];
export type RuleTableColumn = { id: RuleTableColumnId; label: string; width: number; min: number; max: number; required?: boolean; adminOnly?: boolean };
const columnId = z.enum(RULE_TABLE_COLUMNS.map(column => column.id) as [RuleTableColumnId, ...RuleTableColumnId[]]);
export const ruleTableLayoutSchema = z.object({
  order: z.array(columnId).max(RULE_TABLE_COLUMNS.length),
  hidden: z.array(columnId).max(RULE_TABLE_COLUMNS.length),
  widths: z.record(columnId, z.number().int().min(48).max(900)),
}).strict();
export type RuleTableLayout = z.infer<typeof ruleTableLayoutSchema>;

export function defaultRuleTableLayout(): RuleTableLayout {
  return { order: RULE_TABLE_COLUMNS.map(column => column.id), hidden: [], widths: {} };
}

export function normalizeRuleTableLayout(input: unknown): RuleTableLayout {
  if (typeof input === "string") {
    try { input = input.length <= 16_384 ? JSON.parse(input) : null; } catch { input = null; }
  }
  const parsed = ruleTableLayoutSchema.safeParse(input);
  if (!parsed.success) return defaultRuleTableLayout();
  const order = [...new Set([...parsed.data.order, ...RULE_TABLE_COLUMNS.map(column => column.id)])];
  const required = new Set<RuleTableColumnId>(RULE_TABLE_COLUMNS.filter(column => "required" in column).map(column => column.id));
  const widths: RuleTableLayout["widths"] = {};
  for (const column of RULE_TABLE_COLUMNS) {
    const width = parsed.data.widths[column.id];
    if (width !== undefined) widths[column.id] = Math.max(column.min, Math.min(column.max, width));
  }
  return { order, hidden: [...new Set(parsed.data.hidden)].filter(id => !required.has(id)), widths };
}

export function ruleTableColumns(layout: RuleTableLayout, isAdmin: boolean, includeHidden = false): RuleTableColumn[] {
  return layout.order.flatMap(id => {
    const column: RuleTableColumn | undefined = RULE_TABLE_COLUMNS.find(column => column.id === id);
    return !column || column.adminOnly && !isAdmin || !includeHidden && layout.hidden.includes(id) ? [] : [{ ...column, width: layout.widths[id] ?? column.width }];
  });
}
