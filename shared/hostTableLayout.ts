import { z } from "zod";
import type { TableColumn } from "./tableLayout";

export const HOST_TABLE_COLUMNS = [
  { id: "name", label: "设备名称", width: 180, min: 120, max: 600, required: true },
  { id: "status", label: "状态", width: 80, min: 72, max: 200 },
  { id: "region", label: "地区", width: 160, min: 100, max: 500 },
  { id: "address", label: "主地址", width: 180, min: 120, max: 900 },
  { id: "version", label: "Agent 版本", width: 140, min: 100, max: 400 },
  { id: "load", label: "负载", width: 140, min: 120, max: 400 },
  { id: "uptime", label: "运行时间", width: 120, min: 96, max: 400 },
  { id: "expiry", label: "到期时间", width: 110, min: 96, max: 400 },
  { id: "cpu", label: "CPU", width: 110, min: 96, max: 400 },
  { id: "memory", label: "内存", width: 110, min: 96, max: 400 },
  { id: "disk", label: "磁盘", width: 110, min: 96, max: 400 },
  { id: "total", label: "累计流量", width: 128, min: 112, max: 500 },
  { id: "network", label: "实时网络", width: 128, min: 112, max: 500 },
  { id: "tcpConnections", label: "TCP 连接", width: 136, min: 112, max: 300 },
  { id: "udpConnections", label: "UDP 连接", width: 136, min: 112, max: 300 },
  { id: "system", label: "系统累计", width: 128, min: 112, max: 500 },
  { id: "actions", label: "操作", width: 120, min: 120, max: 400, required: true },
] as const;

export type HostTableColumnId = typeof HOST_TABLE_COLUMNS[number]["id"];
export type HostTableColumn = TableColumn<HostTableColumnId>;
const columnId = z.enum(HOST_TABLE_COLUMNS.map(column => column.id) as [HostTableColumnId, ...HostTableColumnId[]]);
export const hostTableLayoutSchema = z.object({
  order: z.array(columnId).max(HOST_TABLE_COLUMNS.length),
  hidden: z.array(columnId).max(HOST_TABLE_COLUMNS.length),
  widths: z.record(columnId, z.number().int().min(48).max(900)),
}).strict();
export type HostTableLayout = z.infer<typeof hostTableLayoutSchema>;

export function defaultHostTableLayout(): HostTableLayout {
  return { order: HOST_TABLE_COLUMNS.map(column => column.id), hidden: ["version", "load", "uptime", "expiry", "system"], widths: {} };
}

export function normalizeHostTableLayout(input: unknown): HostTableLayout {
  if (typeof input === "string") {
    try { input = input.length <= 16_384 ? JSON.parse(input) : null; } catch { input = null; }
  }
  const parsed = hostTableLayoutSchema.safeParse(input);
  if (!parsed.success) return defaultHostTableLayout();
  const order = [...new Set([...parsed.data.order, ...HOST_TABLE_COLUMNS.map(column => column.id)])];
  const required = new Set<HostTableColumnId>(HOST_TABLE_COLUMNS.filter(column => "required" in column).map(column => column.id));
  const widths: HostTableLayout["widths"] = {};
  for (const column of HOST_TABLE_COLUMNS) {
    const width = parsed.data.widths[column.id];
    if (width !== undefined) widths[column.id] = Math.max(column.min, Math.min(column.max, width));
  }
  return { order, hidden: [...new Set(parsed.data.hidden)].filter(id => !required.has(id)), widths };
}

export function hostTableColumns(layout: HostTableLayout, includeHidden = false): HostTableColumn[] {
  return layout.order.flatMap(id => {
    const column: HostTableColumn | undefined = HOST_TABLE_COLUMNS.find(column => column.id === id);
    return !column || !includeHidden && layout.hidden.includes(id) ? [] : [{ ...column, width: layout.widths[id] ?? column.width }];
  });
}
