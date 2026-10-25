import { getFormatLocale, t } from "@/i18n";
import type { HostConnectionStats, HostSocketCount } from "@shared/hostConnections";

const unavailableReasons: Record<NonNullable<HostSocketCount["reason"]>, string> = {
  "unsupported-platform": "当前系统不支持连接数统计",
  "permission-denied": "没有权限读取连接数",
  "summary-missing": "系统连接数汇总不存在",
  "summary-unreadable": "无法读取系统连接数汇总",
  "summary-invalid": "系统连接数汇总无效",
  "ipv6-summary-missing": "IPv6 连接数汇总不可用",
};

export default function HostConnectionCount({ snapshot, protocol, isOnline, now = Date.now() }: {
  snapshot?: { stats: HostConnectionStats; receivedAt: number } | null;
  protocol: "tcp" | "udp";
  isOnline: boolean;
  now?: number;
}) {
  const stats = snapshot?.stats;
  const count = stats?.[protocol];
  const expired = !!snapshot && (now - snapshot.receivedAt >= 15 * 60_000 || now - snapshot.stats.sampledAt * 1000 >= 15 * 60_000);
  let title: string;
  let value = "—";
  if (!isOnline) title = t("主机离线，连接数不可用");
  else if (!stats) title = t("尚未收到连接数，请确认 Agent 已更新并等待心跳");
  else if (expired) title = t("连接数采样已过期，等待 Agent 上报");
  else if (count?.status !== "ok" || !Number.isSafeInteger(count.total) || count.total! < 0
    || protocol === "tcp" && (!Number.isSafeInteger(count.inUse) || !Number.isSafeInteger(count.timeWait))) {
    title = t(count?.reason && unavailableReasons[count.reason] || "无法读取系统连接数汇总");
  } else {
    value = count.total!.toLocaleString(getFormatLocale());
    title = protocol === "tcp"
      ? t("TCP 总量：{0}；使用中（含监听）：{1}；TIME_WAIT：{2}", [value, count.inUse!.toLocaleString(getFormatLocale()), count.timeWait!.toLocaleString(getFormatLocale())])
      : t("UDP 套接字数：{0}，不代表远端客户端数量", [value]);
    title += `\n${t(count.ipv6Included ? "包含 IPv4 / IPv6" : "仅 IPv4")}`;
  }
  if (stats && isOnline) title += `\n${t("采样时间：{0}", [new Date(stats.sampledAt * 1000).toLocaleString(getFormatLocale())])}`;
  return <span className="block truncate text-xs font-medium tabular-nums text-muted-foreground" title={title}>{value}</span>;
}
