import {
  STREAM_UNLOCK_PROBE_VERSION,
  STREAM_UNLOCK_PROVIDER_CATALOG,
  type StreamUnlockDnsResult,
  type StreamUnlockProviderStatus,
  type StreamUnlockTaskSnapshot,
} from "../shared/streamUnlock";

type DevStreamUnlockHost = {
  id: number;
  geoCountryCode?: string | null;
  ip?: string | null;
  ipv4?: string | null;
  ipv6?: string | null;
};

const fixtures = new Map<number, StreamUnlockTaskSnapshot>();

function enabled() {
  return process.env.NODE_ENV !== "production"
    && ["1", "true"].includes(process.env.FORWARDX_DEV_PANEL || "");
}

/** In-memory fixtures only; no database writes or Agent tasks are created. */
export function seedDevStreamUnlockResults(hosts: DevStreamUnlockHost[], now = new Date()) {
  fixtures.clear();
  if (!enabled()) return;
  const timestamp = new Date(now.getTime() - 5 * 60_000).toISOString();
  const statuses: StreamUnlockProviderStatus[] = [
    "available", "available", "available", "available", "blocked", "blocked", "unknown", "available",
  ];
  const domains = ["netflix.com", "disneyplus.com", "youtube.com", "spotify.com", "bilibili.tv", "ani.gamer.com.tw", "api.abema.io"];
  const count = Math.floor(hosts.length / 2);
  for (let index = 0; index < count; index++) {
    const host = hosts[index * 2];
    const hostId = Number(host.id);
    const region = String(host.geoCountryCode || "HK").toUpperCase();
    const families = host.ipv6 ? ["ipv4", "ipv6"] as const : ["ipv4"] as const;
    const providers = families.flatMap((family) => STREAM_UNLOCK_PROVIDER_CATALOG.map((provider, providerIndex) => {
      const status = provider.id === "spotify"
        ? family === "ipv4" ? "available" : "blocked"
        : statuses[(providerIndex + index) % statuses.length];
      return {
        providerId: provider.id,
        providerName: provider.name,
        family,
        status,
        region: status === "available" || status === "partial" ? region : undefined,
        httpStatus: status === "blocked" ? 403 : 200,
        latencyMs: 26 + providerIndex * 17 + index * 13 + (family === "ipv6" ? 8 : 0),
        checkedAt: timestamp,
        detail: status === "partial" ? "仅部分内容可用" : status === "blocked" ? "当前出口所在地区不受支持" : status === "unknown" ? "接口未返回可判断的地区信息" : "公开接口可访问",
        evidence: `${family}:local-demo`,
      };
    }));
    const dns: StreamUnlockDnsResult[] = families.flatMap((family) => domains.map((domain, providerIndex) => ({
      domain,
      family,
      mode: providerIndex === 0 ? "smart_dns_suspected" : "public_dns",
      systemAddresses: family === "ipv6" ? ["2001:db8:30::10"] : ["192.0.2.100"],
      publicAddresses: family === "ipv6" ? ["2001:db8:40::10"] : ["198.51.100.100"],
      detail: providerIndex === 0 ? "系统解析存在智能 DNS 特征" : "未发现智能 DNS 特征",
      checkedAt: timestamp,
    })));
    fixtures.set(hostId, {
      taskId: `dev-stream-unlock-${hostId}`,
      hostId,
      probeVersion: STREAM_UNLOCK_PROBE_VERSION,
      family: families.length === 2 ? "both" : "ipv4",
      status: "success",
      running: false,
      exitIPv4: host.ipv4 || (host.ip && !host.ip.includes(":") ? host.ip : "192.0.2.21"),
      exitIPv6: host.ipv6 || undefined,
      providers,
      dns,
      startedAt: new Date(Date.parse(timestamp) - 12_000).toISOString(),
      finishedAt: timestamp,
      checkedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
}

export function getDevStreamUnlockResult(hostId: number, taskId?: string) {
  if (!enabled()) return null;
  const fixture = fixtures.get(Number(hostId));
  if (!fixture || (taskId && fixture.taskId !== taskId)) return null;
  return fixture;
}
