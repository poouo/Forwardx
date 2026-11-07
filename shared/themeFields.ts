import { hostNetworkSpeed } from "./hostNetworkSpeed";
/** Explicit presentation data contract. Never spread database rows into a theme model. */
export const THEME_FIELDS = {
  "host.id": { label: "ID", format: "number", scope: "host" },
  "host.name": { label: "设备名称", format: "text", scope: "host" },
  "host.online": { label: "状态", format: "status", scope: "host" },
  "host.address": { label: "主地址", format: "text", scope: "host" },
  "host.ipv4": { label: "IPv4", format: "text", scope: "host" },
  "host.ipv6": { label: "IPv6", format: "text", scope: "host" },
  "host.region": { label: "地区", format: "text", scope: "host" },
  "host.countryCode": { label: "国家代码", format: "text", scope: "host" },
  "host.os": { label: "系统", format: "text", scope: "host" },
  "host.cpuModel": { label: "CPU 型号", format: "text", scope: "host" },
  "host.agentVersion": { label: "Agent 版本", format: "text", scope: "host" },
  "host.lastHeartbeat": { label: "最后心跳", format: "date", scope: "host" },
  "host.purchasedAt": { label: "购买时间", format: "date", scope: "host" },
  "host.expiresAt": { label: "到期时间", format: "date", scope: "host" },
  "host.remainingDays": { label: "剩余天数", format: "number", scope: "host" },
  "host.uptime": { label: "运行时间", format: "duration", scope: "host" },
  "host.cpuUsage": { label: "CPU", format: "percent", scope: "host" },
  "host.load1": { label: "1 分钟负载", format: "number", scope: "host" },
  "host.load5": { label: "5 分钟负载", format: "number", scope: "host" },
  "host.load15": { label: "15 分钟负载", format: "number", scope: "host" },
  "host.memoryUsage": { label: "内存", format: "percent", scope: "host" },
  "host.memoryUsed": { label: "已用内存", format: "bytes", scope: "host" },
  "host.memoryTotal": { label: "内存总量", format: "bytes", scope: "host" },
  "host.swapUsage": { label: "Swap", format: "percent", scope: "host" },
  "host.swapUsed": { label: "已用 Swap", format: "bytes", scope: "host" },
  "host.swapTotal": { label: "Swap 总量", format: "bytes", scope: "host" },
  "host.diskUsage": { label: "磁盘", format: "percent", scope: "host" },
  "host.diskUsed": { label: "已用磁盘", format: "bytes", scope: "host" },
  "host.diskTotal": { label: "磁盘总量", format: "bytes", scope: "host" },
  "host.networkInSpeed": { label: "下行速率", format: "speed", scope: "host" },
  "host.networkOutSpeed": { label: "上行速率", format: "speed", scope: "host" },
  "host.systemNetworkIn": { label: "系统累计入站", format: "bytes", scope: "host" },
  "host.systemNetworkOut": { label: "系统累计出站", format: "bytes", scope: "host" },
  "host.trafficIn": { label: "入站流量", format: "bytes", scope: "host" },
  "host.trafficOut": { label: "出站流量", format: "bytes", scope: "host" },
  "host.trafficUsed": { label: "已用流量", format: "bytes", scope: "host" },
  "host.trafficLimit": { label: "流量额度", format: "bytes", scope: "host" },
  "host.trafficRemaining": { label: "剩余流量", format: "bytes", scope: "host" },
  "host.trafficPercent": { label: "流量使用率", format: "percent", scope: "host" },
  "host.trafficMode": { label: "流量计量方式", format: "text", scope: "host" },
  "host.tcpConnections": { label: "TCP 连接", format: "number", scope: "host" },
  "host.tcpInUse": { label: "TCP 使用中", format: "number", scope: "host" },
  "host.tcpTimeWait": { label: "TCP TIME_WAIT", format: "number", scope: "host" },
  "host.udpConnections": { label: "UDP 连接", format: "number", scope: "host" },
  "host.sampledAt": { label: "采样时间", format: "date", scope: "host" },
  "site.title": { label: "网站标题", format: "text", scope: "shared" },
  "site.version": { label: "面板版本", format: "text", scope: "shared" },
  "viewer.name": { label: "显示名称", format: "text", scope: "shared" },
  "viewer.role": { label: "角色", format: "text", scope: "shared" },
  "fleet.total": { label: "主机总数", format: "number", scope: "fleet" },
  "fleet.online": { label: "在线主机", format: "number", scope: "fleet" },
  "fleet.offline": { label: "离线主机", format: "number", scope: "fleet" },
  "fleet.networkInSpeed": { label: "下行速率", format: "speed", scope: "fleet" },
  "fleet.networkOutSpeed": { label: "上行速率", format: "speed", scope: "fleet" },
  "fleet.trafficIn": { label: "入站流量", format: "bytes", scope: "fleet" },
  "fleet.trafficOut": { label: "出站流量", format: "bytes", scope: "fleet" },
} as const;

export type ThemeField = keyof typeof THEME_FIELDS;
export type ThemeFieldFormat = typeof THEME_FIELDS[ThemeField]["format"];
export type ThemeValues = Partial<Record<ThemeField, string | number | boolean | null>>;

const number = (value: unknown) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : null;
const text = (value: unknown) => typeof value === "string" && value.trim() ? value : null;
const date = (value: unknown) => {
  const time = value instanceof Date ? value.getTime() : typeof value === "number" ? value : typeof value === "string" && value ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 ? time : null;
};

/** Input comes exclusively from the existing permission-checked host queries. */
export function hostThemeValues(host: Record<string, any>, metrics: readonly Record<string, any>[] | null | undefined, traffic?: { bytesIn?: unknown; bytesOut?: unknown } | null, now = Date.now()): ThemeValues {
  const metric = metrics?.[0] || {}, previous = metrics?.[1];
  const online = !!host.isOnline;
  const live = (value: unknown) => online ? number(value) : null;
  const inBytes = number(traffic?.bytesIn), outBytes = number(traffic?.bytesOut);
  const mode = ["outbound", "max"].includes(host.trafficMeasureMode) ? host.trafficMeasureMode : "both";
  const used = mode === "outbound" ? outBytes : mode === "max" ? (inBytes === null || outBytes === null ? null : Math.max(inBytes, outBytes)) : (inBytes === null || outBytes === null ? null : inBytes + outBytes);
  const limit = number(host.trafficLimit);
  const expires = date(host.stoppedAt);
  const networkSpeed = hostNetworkSpeed(metric, previous, { now, isOnline: online });
  const connection = (protocol: "tcp" | "udp", key: "total" | "inUse" | "timeWait") => {
    const snapshot = host.connectionStats, count = snapshot?.stats?.[protocol];
    if (!online || !snapshot || count?.status !== "ok" || !Number.isFinite(snapshot.receivedAt) || !Number.isFinite(snapshot.stats.sampledAt)
      || now - snapshot.receivedAt >= 900_000 || now - snapshot.stats.sampledAt * 1000 >= 900_000) return null;
    const value = count[key];
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  return {
    "host.id": number(host.id), "host.name": text(host.name), "host.online": online,
    "host.address": text(host.preferredIpv4) || text(host.ipv4) || text(host.ip) || text(host.preferredIpv6) || text(host.ipv6),
    "host.ipv4": text(host.preferredIpv4) || text(host.ipv4), "host.ipv6": text(host.preferredIpv6) || text(host.ipv6),
    "host.region": [text(host.geoCountryName) || text(host.geoCountryCode), text(host.geoRegion)].filter(Boolean).join(" · ") || null,
    "host.countryCode": text(host.geoCountryCode), "host.os": text(host.osInfo), "host.cpuModel": text(host.cpuInfo),
    "host.agentVersion": text(host.agentVersion), "host.lastHeartbeat": date(host.lastHeartbeat), "host.purchasedAt": date(host.purchasedAt), "host.expiresAt": expires,
    "host.remainingDays": expires === null ? null : Math.max(0, Math.ceil((expires - now) / 86_400_000)),
    "host.uptime": live(metric.uptime), "host.cpuUsage": live(metric.cpuUsage), "host.load1": live(metric.load1), "host.load5": live(metric.load5), "host.load15": live(metric.load15),
    "host.memoryUsage": live(metric.memoryUsage), "host.memoryUsed": live(metric.memoryUsed), "host.memoryTotal": number(host.memoryTotal),
    "host.swapUsage": live(metric.swapUsage), "host.swapUsed": live(metric.swapUsed), "host.swapTotal": live(metric.swapTotal),
    "host.diskUsage": live(metric.diskUsage), "host.diskUsed": live(metric.diskUsed), "host.diskTotal": number(metric.diskTotal),
    "host.networkInSpeed": networkSpeed.in, "host.networkOutSpeed": networkSpeed.out, "host.systemNetworkIn": live(metric.networkIn), "host.systemNetworkOut": live(metric.networkOut),
    "host.trafficIn": inBytes, "host.trafficOut": outBytes, "host.trafficUsed": used, "host.trafficLimit": limit,
    "host.trafficRemaining": limit && used !== null ? Math.max(0, limit - used) : null,
    "host.trafficPercent": limit && used !== null ? used / limit * 100 : null,
    "host.trafficMode": mode,
    "host.tcpConnections": connection("tcp", "total"), "host.tcpInUse": connection("tcp", "inUse"), "host.tcpTimeWait": connection("tcp", "timeWait"), "host.udpConnections": connection("udp", "total"),
    "host.sampledAt": online ? date(metric.recordedAt) : null,
  };
}
