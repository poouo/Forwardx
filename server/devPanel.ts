import { eq } from "drizzle-orm";
import { users } from "../drizzle/schema";
import { MIGRATION_TABLES } from "./dbSchema";
import { executeRaw, getDb, insertAndGetId, nowDate, quoteDbIdentifier } from "./dbRuntime";
import { setSetting, setSettings } from "./repositories/settingsRepository";
import { getUserByUsername } from "./repositories/userRepository";
import { hashPassword } from "./password";
import { randomAvataaarsValue } from "../shared/avatar";

export const DEV_PANEL_FLAG = "FORWARDX_DEV_PANEL";
export const DEV_ADMIN_USERNAME = "dev.admin@forwardx.local";
export const DEV_ADMIN_PASSWORD = "forwardx-dev";

export function isDevPanelMode() {
  if (process.env.NODE_ENV === "production") return false;
  return process.env[DEV_PANEL_FLAG] === "1" || process.env[DEV_PANEL_FLAG] === "true";
}

function daysFromNow(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60 * 1000);
}

async function clearDevData() {
  const preserved = new Set(["users", "system_settings"]);
  for (const table of [...MIGRATION_TABLES].reverse()) {
    if (preserved.has(table)) continue;
    await executeRaw(`DELETE FROM ${quoteDbIdentifier(table)}`);
  }
  await executeRaw(
    `DELETE FROM ${quoteDbIdentifier("users")} WHERE ${quoteDbIdentifier("username")} <> ?`,
    [DEV_ADMIN_USERNAME],
  );
}

async function ensureDevAdmin() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const existing = await getUserByUsername(DEV_ADMIN_USERNAME);
  if (existing) {
    await db.update(users).set({
      username: DEV_ADMIN_USERNAME,
      password: hashPassword(DEV_ADMIN_PASSWORD),
      name: "本地开发管理员",
      email: DEV_ADMIN_USERNAME,
      emailVerified: true,
      role: "admin",
      accountEnabled: true,
      canAddRules: true,
      allowForwardXTunnel: true,
      maxRules: 0,
      maxPorts: 0,
      maxConnections: 0,
      maxIPs: 0,
      trafficLimit: 0,
      balanceCents: 100_000,
      updatedAt: nowDate(),
    }).where(eq(users.id, existing.id));
    return existing.id;
  }

  return insertAndGetId("users", {
    username: DEV_ADMIN_USERNAME,
    password: hashPassword(DEV_ADMIN_PASSWORD),
    name: "本地开发管理员",
    email: DEV_ADMIN_USERNAME,
    emailVerified: true,
    avatar: randomAvataaarsValue("forwardx-dev-admin"),
    role: "admin",
    accountEnabled: true,
    canAddRules: true,
    allowForwardXTunnel: true,
    maxRules: 0,
    maxPorts: 0,
    maxConnections: 0,
    maxIPs: 0,
    trafficLimit: 0,
    balanceCents: 100_000,
    createdAt: nowDate(),
    updatedAt: nowDate(),
    lastSignedIn: nowDate(),
  });
}

async function seedHosts(adminId: number) {
  const common = {
    userId: adminId,
    trafficMeasureMode: "both",
    telegramTrafficAlertEnabled: true,
    trafficAlertThresholdPercent: 80,
    telegramRenewalReminderEnabled: true,
    renewalReminderDays: 7,
    trafficAutoReset: true,
    trafficResetDay: 1,
  };
  const now = nowDate();
  const hostRows = [
    {
      name: "香港-入口-01",
      ip: "103.88.45.21",
      ipv4: "103.88.45.21",
      entryIp: "hk-entry.dev.forwardx.local",
      tunnelEntryIp: "10.10.1.10",
      osInfo: "Ubuntu 24.04 LTS",
      cpuInfo: "Intel Xeon Gold 6148",
      memoryTotal: 8 * 1024 ** 3,
      agentVersion: "2.2.127",
      isOnline: true,
      lastHeartbeat: now,
      purchasedAt: daysFromNow(-28),
      stoppedAt: daysFromNow(58),
      trafficLimit: 720 * 1024 ** 3,
      portRangeStart: 10000,
      portRangeEnd: 19999,
      geoCountryCode: "HK",
      geoCountryName: "Hong Kong",
      geoRegion: "Hong Kong",
      geoEmoji: "🇭🇰",
      sortOrder: 1,
      ...common,
    },
    {
      name: "日本-落地-02",
      ip: "2a0e:97c0:3f4:1::41d",
      ipv6: "2a0e:97c0:3f4:1::41d",
      entryIp: "jp-exit.dev.forwardx.local",
      tunnelEntryIp: "fd00:10:10::20",
      osInfo: "Debian 12",
      cpuInfo: "AMD EPYC 7763",
      memoryTotal: 16 * 1024 ** 3,
      agentVersion: "2.2.125",
      agentUpgradeRequested: false,
      isOnline: true,
      lastHeartbeat: now,
      purchasedAt: daysFromNow(-90),
      stoppedAt: daysFromNow(12),
      trafficLimit: Math.round(1.4 * 1024 ** 4),
      portAllowlist: "21000,22000,23000",
      geoCountryCode: "JP",
      geoCountryName: "Japan",
      geoRegion: "Tokyo",
      geoEmoji: "🇯🇵",
      sortOrder: 2,
      ...common,
    },
    {
      name: "新加坡-中转-03",
      ip: "8.219.73.16",
      ipv4: "8.219.73.16",
      entryIp: "8.219.73.16",
      tunnelEntryIp: "10.10.3.10",
      osInfo: "AlmaLinux 9",
      cpuInfo: "Ampere Altra",
      memoryTotal: 12 * 1024 ** 3,
      agentVersion: "2.2.127",
      agentUpgradeRequested: true,
      agentUpgradeTargetVersion: "2.2.127",
      agentUpgradeRequestedAt: minutesAgo(2),
      isOnline: true,
      lastHeartbeat: now,
      purchasedAt: daysFromNow(-12),
      stoppedAt: daysFromNow(2),
      trafficLimit: 860 * 1024 ** 3,
      geoCountryCode: "SG",
      geoCountryName: "Singapore",
      geoRegion: "Singapore",
      geoEmoji: "🇸🇬",
      sortOrder: 3,
      ...common,
    },
    {
      name: "洛杉矶-备用-04",
      ip: "172.86.92.18",
      ipv4: "172.86.92.18",
      entryIp: "172.86.92.18",
      osInfo: "Rocky Linux 9",
      cpuInfo: "Intel Xeon E5",
      memoryTotal: 6 * 1024 ** 3,
      agentVersion: "2.2.124",
      agentUpgradeRequested: true,
      agentUpgradeTargetVersion: "2.2.127",
      agentUpgradeRequestedAt: minutesAgo(20),
      isOnline: false,
      lastHeartbeat: minutesAgo(18),
      purchasedAt: daysFromNow(-180),
      stoppedAt: daysFromNow(-1),
      trafficLimit: 0,
      portRangeStart: 30000,
      portRangeEnd: 39999,
      geoCountryCode: "US",
      geoCountryName: "United States",
      geoRegion: "Los Angeles",
      geoEmoji: "🇺🇸",
      sortOrder: 4,
      ...common,
    },
  ];

  const ids: number[] = [];
  for (const host of hostRows) {
    ids.push(await insertAndGetId("hosts", { ...host, createdAt: nowDate(), updatedAt: nowDate() }));
  }
  return ids;
}

async function seedHostMetrics(hostIds: number[]) {
  const metricRows = [
    { cpuUsage: 18, memoryUsage: 42, memoryUsed: 3.4 * 1024 ** 3, swapUsage: 6, swapUsed: 180 * 1024 ** 2, swapTotal: 3 * 1024 ** 3, diskUsage: 36, diskUsed: 72 * 1024 ** 3, diskTotal: 200 * 1024 ** 3, uptime: 16 * 86400 + 5 * 3600, inSpeed: 8.42 * 1024 ** 2, outSpeed: 11.6 * 1024 ** 2 },
    { cpuUsage: 72, memoryUsage: 68, memoryUsed: 10.8 * 1024 ** 3, swapUsage: 18, swapUsed: 720 * 1024 ** 2, swapTotal: 4 * 1024 ** 3, diskUsage: 51, diskUsed: 122 * 1024 ** 3, diskTotal: 240 * 1024 ** 3, uptime: 42 * 86400 + 11 * 3600, inSpeed: 3.18 * 1024 ** 2, outSpeed: 24.9 * 1024 ** 2 },
    { cpuUsage: 34, memoryUsage: 56, memoryUsed: 6.8 * 1024 ** 3, swapUsage: 3, swapUsed: 96 * 1024 ** 2, swapTotal: 2 * 1024 ** 3, diskUsage: 29, diskUsed: 58 * 1024 ** 3, diskTotal: 200 * 1024 ** 3, uptime: 5 * 86400 + 4 * 3600, inSpeed: 912 * 1024, outSpeed: 1.74 * 1024 ** 2 },
    { cpuUsage: 0, memoryUsage: 0, memoryUsed: 0, swapUsage: 0, swapUsed: 0, swapTotal: 2 * 1024 ** 3, diskUsage: 47, diskUsed: 94 * 1024 ** 3, diskTotal: 200 * 1024 ** 3, uptime: 0, inSpeed: 0, outSpeed: 0 },
  ];
  for (const [index, hostId] of hostIds.entries()) {
    const item = metricRows[index];
    const baseIn = (index + 5) * 1024 ** 4;
    const baseOut = (index + 6) * 1024 ** 4;
    await insertAndGetId("host_metrics", {
      hostId,
      cpuUsage: Math.max(0, item.cpuUsage - 3),
      memoryUsage: Math.max(0, item.memoryUsage - 2),
      memoryUsed: Math.max(0, item.memoryUsed - 180 * 1024 ** 2),
      swapUsage: item.swapUsage,
      swapUsed: item.swapUsed,
      swapTotal: item.swapTotal,
      networkIn: baseIn,
      networkOut: baseOut,
      diskUsage: item.diskUsage,
      diskUsed: item.diskUsed,
      diskTotal: item.diskTotal,
      uptime: Math.max(0, item.uptime - 60),
      recordedAt: minutesAgo(1),
    });
    await insertAndGetId("host_metrics", {
      hostId,
      cpuUsage: item.cpuUsage,
      memoryUsage: item.memoryUsage,
      memoryUsed: Math.round(item.memoryUsed),
      swapUsage: item.swapUsage,
      swapUsed: Math.round(item.swapUsed),
      swapTotal: Math.round(item.swapTotal),
      networkIn: Math.round(baseIn + item.inSpeed * 60),
      networkOut: Math.round(baseOut + item.outSpeed * 60),
      diskUsage: item.diskUsage,
      diskUsed: Math.round(item.diskUsed),
      diskTotal: Math.round(item.diskTotal),
      uptime: item.uptime,
      recordedAt: nowDate(),
    });
  }

  const counters = [
    { bytesIn: 469.56 * 1024 ** 3, bytesOut: 471.24 * 1024 ** 3 },
    { bytesIn: 1.02 * 1024 ** 4, bytesOut: 1.14 * 1024 ** 4 },
    { bytesIn: 227.1 * 1024 ** 3, bytesOut: 248.8 * 1024 ** 3 },
    { bytesIn: 88.2 * 1024 ** 3, bytesOut: 96.3 * 1024 ** 3 },
  ];
  for (const [index, hostId] of hostIds.entries()) {
    await insertAndGetId("host_traffic_counters", {
      hostId,
      bytesIn: Math.round(counters[index].bytesIn),
      bytesOut: Math.round(counters[index].bytesOut),
      lastDeltaIn: Math.round((index + 1) * 1024 ** 2),
      lastDeltaOut: Math.round((index + 2) * 1024 ** 2),
      lastReportedAt: nowDate(),
      createdAt: nowDate(),
      updatedAt: nowDate(),
    });
  }
}

async function seedRules(adminId: number, hostIds: number[]) {
  const rules = [
    { hostId: hostIds[0], name: "网站 TCP 转发", forwardType: "iptables", protocol: "tcp", sourcePort: 15201, targetIp: "2a0e:97c0:3f4:1::41d", targetPort: 5201, isRunning: true },
    { hostId: hostIds[1], name: "游戏 TCP+UDP 转发", forwardType: "realm", protocol: "both", sourcePort: 21001, targetIp: "10.10.3.88", targetPort: 25565, isRunning: true, proxyProtocolSend: true, proxyProtocolExitReceive: true, proxyProtocolExitSend: true },
    { hostId: hostIds[2], name: "UDP over TCP 测试", forwardType: "gost", protocol: "both", sourcePort: 32000, targetIp: "172.16.8.30", targetPort: 19132, udpOverTcp: true, udpOverTcpPort: 32001, isRunning: true },
    { hostId: hostIds[3], name: "离线备用规则", forwardType: "socat", protocol: "tcp", sourcePort: 30080, targetIp: "192.168.9.20", targetPort: 80, isRunning: false, disabledByUser: true },
  ];
  const ids: number[] = [];
  for (const rule of rules) {
    ids.push(await insertAndGetId("forward_rules", {
      userId: adminId,
      targetIp: "",
      targetPort: 1,
      ...rule,
      isEnabled: !rule.disabledByUser,
      createdAt: nowDate(),
      updatedAt: nowDate(),
    }));
  }

  for (const ruleId of ids) {
    for (let i = 24; i >= 0; i--) {
      await insertAndGetId("traffic_stats", {
        ruleId,
        hostId: rules[ids.indexOf(ruleId)].hostId,
        bytesIn: Math.round((40 + i * 3 + ruleId) * 1024 ** 2),
        bytesOut: Math.round((55 + i * 4 + ruleId) * 1024 ** 2),
        connections: 20 + i + ruleId,
        recordedAt: minutesAgo(i * 30),
      });
    }
    await insertAndGetId("tcping_stats", {
      ruleId,
      hostId: rules[ids.indexOf(ruleId)].hostId,
      latencyMs: 8 + ruleId * 11,
      isTimeout: false,
      recordedAt: nowDate(),
    });
  }
  return ids;
}

async function seedTunnelsAndGroups(adminId: number, hostIds: number[]) {
  const tunnelId = await insertAndGetId("tunnels", {
    userId: adminId,
    name: "香港 -> 日本 TLS 链路",
    entryHostId: hostIds[0],
    exitHostId: hostIds[1],
    mode: "tls",
    certDomain: "dev.forwardx.local",
    secret: "dev-secret",
    listenPort: 24001,
    rateLimitMbps: 300,
    portRangeStart: 24000,
    portRangeEnd: 24999,
    networkType: "public",
    connectHost: "jp-exit.dev.forwardx.local",
    isEnabled: true,
    isRunning: true,
    lastLatencyMs: 46,
    lastTestStatus: "success",
    lastTestMessage: "开发数据：链路正常",
    lastTestAt: nowDate(),
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });
  await insertAndGetId("tunnel_latency_stats", {
    tunnelId,
    seriesKey: "total",
    seriesLabel: "总延迟",
    latencyMs: 46,
    isTimeout: false,
    recordedAt: nowDate(),
  });
  await insertAndGetId("tunnel_latency_stats", {
    tunnelId,
    seriesKey: "entry-1",
    seriesLabel: "香港入口 -> 日本出口",
    latencyMs: 42,
    isTimeout: false,
    recordedAt: nowDate(),
  });

  const entryGroupId = await insertAndGetId("forward_groups", {
    userId: adminId,
    name: "亚洲入口组",
    remark: "开发数据：用于检查多入口切换 UI",
    groupType: "host",
    groupMode: "entry",
    forwardType: "iptables",
    sourcePort: 10001,
    protocol: "both",
    targetIp: "198.51.100.10",
    targetPort: 443,
    lastStatus: "healthy",
    lastMessage: "香港入口可用，新加坡入口备用",
    isEnabled: true,
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });
  const member1 = await insertAndGetId("forward_group_members", {
    groupId: entryGroupId,
    memberType: "host",
    hostId: hostIds[0],
    priority: 1,
    isEnabled: true,
    healthStatus: "healthy",
    lastLatencyMs: 18,
    chinaHealthStatus: "healthy",
    chinaHealthLatencyMs: 32,
    lastCheckedAt: nowDate(),
    healthySince: minutesAgo(30),
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });
  await insertAndGetId("forward_group_members", {
    groupId: entryGroupId,
    memberType: "host",
    hostId: hostIds[2],
    priority: 2,
    isEnabled: true,
    healthStatus: "healthy",
    lastLatencyMs: 34,
    chinaHealthStatus: "failed",
    chinaHealthLatencyMs: null,
    failureSince: minutesAgo(8),
    lastCheckedAt: nowDate(),
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });

  const failoverGroupId = await insertAndGetId("forward_groups", {
    userId: adminId,
    name: "游戏转发组",
    remark: "开发数据：自动切换告警开启",
    groupType: "host",
    groupMode: "failover",
    entryGroupId,
    forwardType: "nginx_stream",
    sourcePort: 25565,
    protocol: "both",
    targetIp: "10.20.0.88",
    targetPort: 25565,
    chinaHealthCheckEnabled: true,
    chinaHealthCheckTarget: "www.189.cn:80",
    telegramSwitchNotifyEnabled: true,
    activeMemberId: member1,
    lastStatus: "healthy",
    lastMessage: "当前使用香港入口",
    isEnabled: true,
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });
  await insertAndGetId("forward_group_events", {
    groupId: failoverGroupId,
    memberId: member1,
    type: "auto_switch",
    message: "开发数据：国内健康度检测恢复，自动切换回香港入口",
    createdAt: minutesAgo(12),
  });
  await insertAndGetId("forward_group_latency_stats", {
    groupId: failoverGroupId,
    latencyMs: 36,
    isTimeout: false,
    recordedAt: nowDate(),
  });
}

async function seedProbeServices(adminId: number, hostIds: number[]) {
  const serviceId = await insertAndGetId("host_probe_services", {
    userId: adminId,
    name: "目标服务 TCPing",
    method: "tcping",
    targetIp: "speedtest.example.com",
    targetPort: 443,
    hostScope: "all",
    intervalSeconds: 30,
    isEnabled: true,
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });
  for (const [index, hostId] of hostIds.entries()) {
    await insertAndGetId("host_probe_service_stats", {
      serviceId,
      hostId,
      latencyMs: index === 3 ? null : 12 + index * 18,
      isTimeout: index === 3,
      recordedAt: nowDate(),
    });
  }
}

async function seedStoreAndContent(adminId: number) {
  await insertAndGetId("subscription_plans", {
    name: "开发入门套餐",
    description: "用于本地 UI 检查的月付套餐，包含基础转发权限。",
    priceCents: 1900,
    durationDays: 30,
    portCount: 20,
    trafficLimit: 500 * 1024 ** 3,
    rateLimitMbps: 200,
    maxRules: 20,
    maxConnections: 2000,
    maxIPs: 10,
    isActive: true,
    isStoreVisible: true,
    sortOrder: 1,
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });
  await insertAndGetId("subscription_plans", {
    name: "开发旗舰套餐",
    description: "用于检查商店卡片、资源绑定和高配套餐展示。",
    priceCents: 9900,
    durationDays: 365,
    portCount: 200,
    trafficLimit: 5 * 1024 ** 4,
    rateLimitMbps: 1000,
    maxRules: 200,
    maxConnections: 20000,
    maxIPs: 100,
    isActive: true,
    isStoreVisible: true,
    sortOrder: 2,
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });
  await insertAndGetId("announcements", {
    title: "开发环境公告",
    content: "这是本地开发后台自动生成的公告，用于检查公告列表和弹窗展示。",
    type: "normal",
    isActive: true,
    createdByUserId: adminId,
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });
}

async function seedSettings() {
  await setSettings({
    setupDataChoice: "new-panel",
    siteTitle: "ForwardX Dev",
    registrationEnabled: "true",
    lookingGlassUserEnabled: "true",
    latestAgentVersion: "2.2.127",
    agentVersion: "2.2.127",
    telegramBotEnabled: "false",
    systemAnnouncementEnabled: "true",
  });
}

export async function seedDevPanelData() {
  if (!isDevPanelMode()) return;
  const db = await getDb();
  if (!db) return;
  const adminId = await ensureDevAdmin();
  await clearDevData();
  const hostIds = await seedHosts(adminId);
  await seedHostMetrics(hostIds);
  await seedRules(adminId, hostIds);
  await seedTunnelsAndGroups(adminId, hostIds);
  await seedProbeServices(adminId, hostIds);
  await seedStoreAndContent(adminId);
  await seedSettings();
  await setSetting("devPanelSeededAt", new Date().toISOString());
  console.log(`[DevPanel] Seeded local development data as ${DEV_ADMIN_USERNAME}`);
}
