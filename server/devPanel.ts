import { eq } from "drizzle-orm";
import { users } from "../drizzle/schema";
import { MIGRATION_TABLES } from "./dbSchema";
import { executeRaw, getDb, insertAndGetId, nowDate, quoteDbIdentifier } from "./dbRuntime";
import { setSetting, setSettings } from "./repositories/settingsRepository";
import { getUserByUsername } from "./repositories/userRepository";
import { hashPassword } from "./password";
import { randomAvataaarsValue } from "../shared/avatar";
import { syncForwardGroupRules } from "./repositories/forwardGroupRepository";
import { reconcileForwardRuleTunnelExits } from "./repositories/tunnelRepository";

export const DEV_PANEL_FLAG = "FORWARDX_DEV_PANEL";
export const DEV_ADMIN_USERNAME = "dev.admin@forwardx.local";
export const DEV_ADMIN_PASSWORD = "forwardx-dev";

type DevUsers = {
  adminId: number;
  activeUserId: number;
  pausedUserId: number;
  expiredUserId: number;
};

type DevResources = {
  tunnels: {
    primaryTunnelId: number;
    multiEntryMultiExitTunnelId: number;
  };
  groups: {
    entryGroupId: number;
    exitGroupId: number;
    failoverGroupId: number;
    chainGroupId: number;
  };
};

type DevRules = {
  allRuleIds: number[];
  adminRuleIds: number[];
  userRuleIds: {
    activeUserRuleId: number;
    pausedUserRuleId: number;
    expiredUserRuleId: number;
  };
};

type DevCatalog = {
  starterPlanId: number;
  proPlanId: number;
  addonIds: {
    burstAddonId: number;
    monthlyAddonId: number;
  };
  announcementIds: {
    normalAnnouncementId: number;
    popupAnnouncementId: number;
  };
};

type DevPlanSnapshot = {
  name: string;
  portCount: number;
  trafficLimit: number;
  rateLimitMbps: number;
  maxRules: number;
  maxConnections: number;
  maxIPs: number;
  hostIds?: number[];
  tunnelIds?: number[];
  forwardGroupIds?: number[];
};

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

function buildPlanSnapshot(plan: DevPlanSnapshot) {
  return JSON.stringify({
    name: plan.name,
    portCount: plan.portCount,
    trafficLimit: plan.trafficLimit,
    rateLimitMbps: plan.rateLimitMbps,
    maxRules: plan.maxRules,
    maxConnections: plan.maxConnections,
    maxIPs: plan.maxIPs,
    hostIds: plan.hostIds || [],
    tunnelIds: plan.tunnelIds || [],
    forwardGroupIds: plan.forwardGroupIds || [],
  });
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
  const patch = {
    username: DEV_ADMIN_USERNAME,
    password: hashPassword(DEV_ADMIN_PASSWORD),
    name: "Local Dev Admin",
    email: DEV_ADMIN_USERNAME,
    emailVerified: true,
    role: "admin",
    accountEnabled: true,
    canAddRules: true,
    allowForwardXTunnel: true,
    manualCanAddRules: true,
    manualAllowForwardXTunnel: true,
    maxRules: 0,
    maxPorts: 0,
    maxConnections: 0,
    maxIPs: 0,
    manualMaxRules: 0,
    manualMaxPorts: 0,
    manualMaxConnections: 0,
    manualMaxIPs: 0,
    trafficLimit: 0,
    balanceCents: 100_000,
    updatedAt: nowDate(),
  };
  if (existing) {
    await db.update(users).set(patch).where(eq(users.id, existing.id));
    return existing.id;
  }

  return insertAndGetId("users", {
    ...patch,
    avatar: randomAvataaarsValue("forwardx-dev-admin"),
    createdAt: nowDate(),
    lastSignedIn: nowDate(),
  });
}

async function seedUsers(adminId: number): Promise<DevUsers> {
  const rows = [
    {
      username: "edge.user@forwardx.local",
      password: "forwardx-edge",
      name: "Edge User",
      email: "edge.user@forwardx.local",
      role: "user",
      accountEnabled: true,
      canAddRules: true,
      allowForwardXTunnel: true,
      manualCanAddRules: true,
      manualAllowForwardXTunnel: true,
      maxRules: 12,
      maxPorts: 24,
      maxConnections: 4000,
      maxIPs: 24,
      manualMaxRules: 12,
      manualMaxPorts: 24,
      manualMaxConnections: 4000,
      manualMaxIPs: 24,
      trafficLimit: Math.round(420 * 1024 ** 3),
      trafficUsed: Math.round(188 * 1024 ** 3),
      manualTrafficLimit: Math.round(420 * 1024 ** 3),
      balanceCents: 12_800,
      expiresAt: daysFromNow(18),
      manualExpiresAt: daysFromNow(18),
      trafficAutoReset: true,
      trafficResetDay: 1,
      lastTrafficReset: daysFromNow(-6),
      lastSignedIn: minutesAgo(6),
    },
    {
      username: "billing.pause@forwardx.local",
      password: "forwardx-billing",
      name: "Billing Pause",
      email: "billing.pause@forwardx.local",
      role: "user",
      accountEnabled: true,
      canAddRules: false,
      allowForwardXTunnel: false,
      manualCanAddRules: true,
      manualAllowForwardXTunnel: true,
      forwardAccessPauseReason: "traffic_billing_balance",
      maxRules: 8,
      maxPorts: 16,
      maxConnections: 1500,
      maxIPs: 8,
      manualMaxRules: 8,
      manualMaxPorts: 16,
      manualMaxConnections: 1500,
      manualMaxIPs: 8,
      trafficLimit: Math.round(160 * 1024 ** 3),
      trafficUsed: Math.round(149 * 1024 ** 3),
      manualTrafficLimit: Math.round(160 * 1024 ** 3),
      balanceCents: 0,
      expiresAt: daysFromNow(40),
      manualExpiresAt: daysFromNow(40),
      trafficAutoReset: true,
      trafficResetDay: 8,
      lastTrafficReset: daysFromNow(-8),
      lastSignedIn: minutesAgo(90),
    },
    {
      username: "expired.user@forwardx.local",
      password: "forwardx-expired",
      name: "Expired User",
      email: "expired.user@forwardx.local",
      role: "user",
      accountEnabled: true,
      canAddRules: false,
      allowForwardXTunnel: false,
      manualCanAddRules: false,
      manualAllowForwardXTunnel: false,
      forwardAccessPauseReason: "expired",
      maxRules: 4,
      maxPorts: 8,
      maxConnections: 500,
      maxIPs: 4,
      manualMaxRules: 4,
      manualMaxPorts: 8,
      manualMaxConnections: 500,
      manualMaxIPs: 4,
      trafficLimit: Math.round(80 * 1024 ** 3),
      trafficUsed: Math.round(82 * 1024 ** 3),
      manualTrafficLimit: Math.round(80 * 1024 ** 3),
      balanceCents: 5_000,
      expiresAt: daysFromNow(-5),
      manualExpiresAt: daysFromNow(-5),
      trafficAutoReset: false,
      trafficResetDay: 1,
      lastTrafficReset: daysFromNow(-38),
      lastSignedIn: daysFromNow(-11),
    },
  ] as const;

  const ids: number[] = [];
  for (const [index, row] of rows.entries()) {
    ids.push(await insertAndGetId("users", {
      ...row,
      password: hashPassword(row.password),
      emailVerified: true,
      emailVerifiedAt: daysFromNow(-60),
      avatar: randomAvataaarsValue(`dev-user-${row.username}`),
      createdAt: daysFromNow(-120 + index * 16),
      updatedAt: nowDate(),
    }));
  }

  return {
    adminId,
    activeUserId: ids[0],
    pausedUserId: ids[1],
    expiredUserId: ids[2],
  };
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
      name: "HK entry 01",
      hostType: "master",
      ip: "103.88.45.21",
      ipv4: "103.88.45.21",
      entryIp: "hk-entry.dev.forwardx.local",
      tunnelEntryIp: "10.10.1.10",
      osInfo: "Ubuntu 24.04 LTS",
      cpuInfo: "Intel Xeon Gold 6148",
      memoryTotal: 8 * 1024 ** 3,
      agentVersion: "2.2.129",
      isOnline: true,
      lastHeartbeat: now,
      purchasedAt: daysFromNow(-28),
      stoppedAt: daysFromNow(58),
      trafficLimit: Math.round(720 * 1024 ** 3),
      portRangeStart: 10000,
      portRangeEnd: 19999,
      ddnsEnabled: true,
      ddnsDomain: "hk-entry.dev.forwardx.local",
      ddnsRecordType: "A",
      ddnsIpVersion: "ipv4",
      lastDdnsValue: "103.88.45.21",
      lastDdnsAt: minutesAgo(20),
      networkInterface: "eth0",
      geoCountryCode: "HK",
      geoCountryName: "Hong Kong",
      geoRegion: "Central",
      geoEmoji: "HK",
      geoLatitudeMicro: 22319000,
      geoLongitudeMicro: 114169000,
      geoUpdatedAt: minutesAgo(15),
      sortOrder: 1,
      ...common,
    },
    {
      name: "JP exit 02",
      ip: "2a0e:97c0:3f4:1::41d",
      ipv6: "2a0e:97c0:3f4:1::41d",
      entryIp: "jp-exit.dev.forwardx.local",
      tunnelEntryIp: "fd00:10:10::20",
      osInfo: "Debian 12",
      cpuInfo: "AMD EPYC 7763",
      memoryTotal: 16 * 1024 ** 3,
      agentVersion: "2.2.125",
      isOnline: true,
      lastHeartbeat: now,
      purchasedAt: daysFromNow(-90),
      stoppedAt: daysFromNow(120),
      trafficLimit: Math.round(1.4 * 1024 ** 4),
      portAllowlist: "21000,22000,23000",
      ddnsEnabled: true,
      ddnsDomain: "jp-exit.dev.forwardx.local",
      ddnsRecordType: "AAAA",
      ddnsIpVersion: "ipv6",
      lastDdnsValue: "2a0e:97c0:3f4:1::41d",
      lastDdnsAt: minutesAgo(25),
      networkInterface: "ens18",
      geoCountryCode: "JP",
      geoCountryName: "Japan",
      geoRegion: "Tokyo",
      geoEmoji: "JP",
      geoLatitudeMicro: 35676000,
      geoLongitudeMicro: 139650000,
      geoUpdatedAt: minutesAgo(25),
      sortOrder: 2,
      ...common,
    },
    {
      name: "SG relay 03",
      ip: "8.219.73.16",
      ipv4: "8.219.73.16",
      entryIp: "sg-relay.dev.forwardx.local",
      tunnelEntryIp: "10.10.3.10",
      osInfo: "AlmaLinux 9",
      cpuInfo: "Ampere Altra",
      memoryTotal: 12 * 1024 ** 3,
      agentVersion: "2.2.129",
      agentUpgradeRequested: true,
      agentUpgradeTargetVersion: "2.2.129",
      agentUpgradeReleaseVersion: "2.3.219",
      agentUpgradeRequestedAt: minutesAgo(2),
      isOnline: true,
      lastHeartbeat: now,
      purchasedAt: daysFromNow(-12),
      stoppedAt: daysFromNow(90),
      trafficLimit: Math.round(860 * 1024 ** 3),
      ddnsEnabled: true,
      ddnsDomain: "sg-relay.dev.forwardx.local",
      ddnsRecordType: "A",
      ddnsIpVersion: "ipv4",
      lastDdnsValue: "8.219.73.16",
      lastDdnsAt: minutesAgo(35),
      networkInterface: "eth0",
      geoCountryCode: "SG",
      geoCountryName: "Singapore",
      geoRegion: "Singapore",
      geoEmoji: "SG",
      geoLatitudeMicro: 1290000,
      geoLongitudeMicro: 103850000,
      geoUpdatedAt: minutesAgo(30),
      sortOrder: 3,
      ...common,
    },
    {
      name: "US backup 04",
      ip: "172.86.92.18",
      ipv4: "172.86.92.18",
      entryIp: "us-backup.dev.forwardx.local",
      osInfo: "Rocky Linux 9",
      cpuInfo: "Intel Xeon E5",
      memoryTotal: 6 * 1024 ** 3,
      agentVersion: "2.2.124",
      agentUpgradeRequested: true,
      agentUpgradeTargetVersion: "2.2.129",
      agentUpgradeReleaseVersion: "2.3.219",
      agentUpgradeRequestedAt: minutesAgo(20),
      isOnline: false,
      lastHeartbeat: minutesAgo(18),
      purchasedAt: daysFromNow(-180),
      stoppedAt: daysFromNow(-1),
      trafficLimit: 0,
      portRangeStart: 30000,
      portRangeEnd: 39999,
      ddnsEnabled: false,
      networkInterface: "eth1",
      geoCountryCode: "US",
      geoCountryName: "United States",
      geoRegion: "Los Angeles",
      geoEmoji: "US",
      geoLatitudeMicro: 34052000,
      geoLongitudeMicro: -118244000,
      geoUpdatedAt: minutesAgo(50),
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

async function seedAgentTokens(adminId: number, hostIds: number[]) {
  const tokens = [
    { token: "dev-token-hk-entry-01", hostId: hostIds[0], description: "Bound to HK entry host", isUsed: true },
    { token: "dev-token-jp-exit-02", hostId: hostIds[1], description: "Bound to JP exit host", isUsed: true },
    { token: "dev-token-sg-relay-03", hostId: hostIds[2], description: "Bound to SG relay host", isUsed: true },
    { token: "dev-token-us-backup-04", hostId: hostIds[3], description: "Bound to US backup host", isUsed: true },
    { token: "dev-token-spare-standby", hostId: null, description: "Unused standby install token", isUsed: false },
  ];

  for (const item of tokens) {
    await insertAndGetId("agent_tokens", {
      token: item.token,
      hostId: item.hostId,
      description: item.description,
      isUsed: item.isUsed,
      userId: adminId,
      createdAt: nowDate(),
    });
    if (item.hostId) {
      await executeRaw(
        `UPDATE ${quoteDbIdentifier("hosts")}
            SET ${quoteDbIdentifier("agentToken")} = ?, ${quoteDbIdentifier("updatedAt")} = ?
          WHERE ${quoteDbIdentifier("id")} = ?`,
        [item.token, nowDate(), item.hostId],
      );
    }
  }
}

async function seedHostMetrics(hostIds: number[]) {
  const metricRows = [
    { cpuUsage: 18, memoryUsage: 42, memoryUsed: 3.4 * 1024 ** 3, swapUsage: 6, swapUsed: 180 * 1024 ** 2, swapTotal: 3 * 1024 ** 3, diskUsage: 36, diskUsed: 72 * 1024 ** 3, diskTotal: 200 * 1024 ** 3, uptime: 16 * 86400 + 5 * 3600, inSpeed: 8.42 * 1024 ** 2, outSpeed: 11.6 * 1024 ** 2 },
    { cpuUsage: 72, memoryUsage: 68, memoryUsed: 10.8 * 1024 ** 3, swapUsage: 18, swapUsed: 720 * 1024 ** 2, swapTotal: 4 * 1024 ** 3, diskUsage: 51, diskUsed: 122 * 1024 ** 3, diskTotal: 240 * 1024 ** 3, uptime: 42 * 86400 + 11 * 3600, inSpeed: 3.18 * 1024 ** 2, outSpeed: 24.9 * 1024 ** 2 },
    { cpuUsage: 34, memoryUsage: 56, memoryUsed: 6.8 * 1024 ** 3, swapUsage: 3, swapUsed: 96 * 1024 ** 2, swapTotal: 2 * 1024 ** 3, diskUsage: 29, diskUsed: 58 * 1024 ** 3, diskTotal: 200 * 1024 ** 3, uptime: 5 * 86400 + 4 * 3600, inSpeed: 912 * 1024, outSpeed: 1.74 * 1024 ** 2 },
    { cpuUsage: 0, memoryUsage: 0, memoryUsed: 0, swapUsage: 0, swapUsed: 0, swapTotal: 2 * 1024 ** 3, diskUsage: 47, diskUsed: 94 * 1024 ** 3, diskTotal: 200 * 1024 ** 3, uptime: 0, inSpeed: 0, outSpeed: 0 },
  ];
  const counters = [
    { bytesIn: 469.56 * 1024 ** 3, bytesOut: 471.24 * 1024 ** 3 },
    { bytesIn: 1.02 * 1024 ** 4, bytesOut: 1.14 * 1024 ** 4 },
    { bytesIn: 227.1 * 1024 ** 3, bytesOut: 248.8 * 1024 ** 3 },
    { bytesIn: 88.2 * 1024 ** 3, bytesOut: 96.3 * 1024 ** 3 },
  ];

  for (const [index, hostId] of hostIds.entries()) {
    const item = metricRows[index];
    const baseIn = (index + 5) * 1024 ** 4;
    const baseOut = (index + 6) * 1024 ** 4;
    await insertAndGetId("host_metrics", {
      hostId,
      cpuUsage: Math.max(0, item.cpuUsage - 3),
      memoryUsage: Math.max(0, item.memoryUsage - 2),
      memoryUsed: Math.max(0, Math.round(item.memoryUsed - 180 * 1024 ** 2)),
      swapUsage: item.swapUsage,
      swapUsed: Math.round(item.swapUsed),
      swapTotal: Math.round(item.swapTotal),
      networkIn: Math.round(baseIn),
      networkOut: Math.round(baseOut),
      diskUsage: item.diskUsage,
      diskUsed: Math.round(item.diskUsed),
      diskTotal: Math.round(item.diskTotal),
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

async function seedHostGroups(adminId: number, hostIds: number[]) {
  const groupRows = [
    { name: "Entry nodes", isEnabled: true, sortOrder: 1, hostIds: [hostIds[0], hostIds[1]] },
    { name: "Exit nodes", isEnabled: true, sortOrder: 2, hostIds: [hostIds[2], hostIds[3]] },
    { name: "Game relay pool", isEnabled: true, sortOrder: 3, hostIds: [hostIds[0], hostIds[2], hostIds[3]] },
    { name: "Disabled sample", isEnabled: false, sortOrder: 4, hostIds: [hostIds[1]] },
  ];
  for (const group of groupRows) {
    const id = await insertAndGetId("host_groups", {
      name: group.name,
      isEnabled: group.isEnabled,
      sortOrder: group.sortOrder,
      userId: adminId,
      createdAt: nowDate(),
      updatedAt: nowDate(),
    });
    for (const [index, hostId] of group.hostIds.entries()) {
      await insertAndGetId("host_group_members", {
        groupId: id,
        hostId,
        sortOrder: index,
        createdAt: nowDate(),
      });
    }
  }
}

async function seedTunnelsAndGroups(adminId: number, hostIds: number[]): Promise<DevResources> {
  const primaryTunnelId = await insertAndGetId("tunnels", {
    userId: adminId,
    name: "HK -> JP TLS tunnel",
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
    lastTestMessage: "Primary dev tunnel healthy",
    lastTestAt: nowDate(),
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });
  await insertAndGetId("tunnel_latency_stats", {
    tunnelId: primaryTunnelId,
    seriesKey: "total",
    seriesLabel: "Total latency",
    latencyMs: 46,
    isTimeout: false,
    recordedAt: nowDate(),
  });
  await insertAndGetId("tunnel_latency_stats", {
    tunnelId: primaryTunnelId,
    seriesKey: "entry-1",
    seriesLabel: "HK entry -> JP exit",
    latencyMs: 42,
    isTimeout: false,
    recordedAt: nowDate(),
  });

  const entryGroupId = await insertAndGetId("forward_groups", {
    userId: adminId,
    name: "Asia entry group",
    remark: "Used to verify multi-entry failover and entry-domain UI.",
    groupType: "host",
    groupMode: "entry",
    forwardType: "iptables",
    domain: "entry.dev.forwardx.local",
    recordType: "A",
    sourcePort: 10001,
    protocol: "both",
    targetIp: "198.51.100.10",
    targetPort: 443,
    lastDdnsValue: "103.88.45.21, 8.219.73.16",
    lastStatus: "healthy",
    lastMessage: "HK entry active, SG entry standby",
    isEnabled: true,
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });
  const entryPrimaryMemberId = await insertAndGetId("forward_group_members", {
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
    name: "Game failover group",
    remark: "Auto-switch alert and health-check coverage for local dev.",
    groupType: "host",
    groupMode: "failover",
    entryGroupId,
    forwardType: "nginx_stream",
    sourcePort: 15566,
    protocol: "both",
    targetIp: "10.20.0.88",
    targetPort: 25565,
    chinaHealthCheckEnabled: true,
    chinaHealthCheckTarget: "www.189.cn:80",
    telegramSwitchNotifyEnabled: true,
    activeMemberId: null,
    lastStatus: "healthy",
    lastMessage: "HK path currently active",
    isEnabled: true,
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });
  const activeFailoverMemberId = await insertAndGetId("forward_group_members", {
    groupId: failoverGroupId,
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
    groupId: failoverGroupId,
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
  await executeRaw(
    `UPDATE ${quoteDbIdentifier("forward_groups")}
        SET ${quoteDbIdentifier("activeMemberId")} = ?
      WHERE ${quoteDbIdentifier("id")} = ?`,
    [activeFailoverMemberId, failoverGroupId],
  );
  await insertAndGetId("forward_group_events", {
    groupId: failoverGroupId,
    memberId: entryPrimaryMemberId,
    type: "auto_switch",
    message: "Recovered health-check path switched traffic back to HK entry.",
    createdAt: minutesAgo(12),
  });
  await insertAndGetId("forward_group_latency_stats", {
    groupId: failoverGroupId,
    latencyMs: 36,
    isTimeout: false,
    recordedAt: nowDate(),
  });

  const exitGroupId = await insertAndGetId("forward_groups", {
    userId: adminId,
    name: "Multi-exit group",
    remark: "Multiple exits for tunnel load-balance and status UI.",
    groupType: "host",
    groupMode: "exit",
    forwardType: "nginx_stream",
    sourcePort: 24443,
    protocol: "both",
    targetIp: "10.30.0.44",
    targetPort: 443,
    lastStatus: "healthy",
    lastMessage: "Three exits available",
    isEnabled: true,
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });
  for (const member of [
    { hostId: hostIds[1], connectHost: "fd00:10:10::20", latency: 42, priority: 1, status: "healthy" },
    { hostId: hostIds[2], connectHost: "10.10.3.10", latency: 63, priority: 2, status: "healthy" },
    { hostId: hostIds[3], connectHost: null, latency: null, priority: 3, status: "failed" },
  ]) {
    await insertAndGetId("forward_group_members", {
      groupId: exitGroupId,
      memberType: "host",
      hostId: member.hostId,
      connectHost: member.connectHost,
      priority: member.priority,
      isEnabled: true,
      healthStatus: member.status,
      lastLatencyMs: member.latency,
      chinaHealthStatus: member.status,
      chinaHealthLatencyMs: member.latency ? member.latency + 16 : null,
      failureSince: member.status === "failed" ? minutesAgo(18) : null,
      healthySince: member.status === "failed" ? null : minutesAgo(45),
      lastCheckedAt: nowDate(),
      createdAt: nowDate(),
      updatedAt: nowDate(),
    });
  }

  const chainGroupId = await insertAndGetId("forward_groups", {
    userId: adminId,
    name: "Entry-group chain",
    remark: "Chain mode using the entry group as the front door.",
    groupType: "host",
    groupMode: "chain",
    entryGroupId,
    forwardType: "realm",
    sourcePort: 18080,
    protocol: "tcp",
    targetIp: "10.40.0.80",
    targetPort: 8080,
    lastStatus: "healthy",
    lastMessage: "Multi-entry chain ready",
    isEnabled: true,
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });
  for (const member of [
    { hostId: hostIds[1], connectHost: "fd00:10:10::20", priority: 1 },
    { hostId: hostIds[3], connectHost: "172.86.92.18", priority: 2 },
  ]) {
    await insertAndGetId("forward_group_members", {
      groupId: chainGroupId,
      memberType: "host",
      hostId: member.hostId,
      connectHost: member.connectHost,
      priority: member.priority,
      isEnabled: true,
      healthStatus: "healthy",
      lastLatencyMs: 28 + member.priority * 11,
      chinaHealthStatus: "healthy",
      chinaHealthLatencyMs: 45 + member.priority * 12,
      healthySince: minutesAgo(50),
      lastCheckedAt: nowDate(),
      createdAt: nowDate(),
      updatedAt: nowDate(),
    });
  }

  const multiEntryMultiExitTunnelId = await insertAndGetId("tunnels", {
    userId: adminId,
    name: "Multi-entry / multi-exit TLS",
    entryGroupId,
    entryHostId: hostIds[0],
    exitHostId: hostIds[1],
    mode: "tls",
    certDomain: "multi.dev.forwardx.local",
    secret: "dev-multi-secret",
    listenPort: 24443,
    rateLimitMbps: 800,
    portRangeStart: 24400,
    portRangeEnd: 24999,
    networkType: "private",
    connectHost: "fd00:10:10::20",
    loadBalanceEnabled: true,
    loadBalanceStrategy: "random",
    isEnabled: true,
    isRunning: true,
    lastLatencyMs: 68,
    lastTestStatus: "success",
    lastTestMessage: "Dev multi-entry/multi-exit probe succeeded",
    lastTestAt: nowDate(),
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });
  await insertAndGetId("tunnel_hops", {
    tunnelId: multiEntryMultiExitTunnelId,
    seq: 0,
    hostId: hostIds[0],
    listenPort: 24443,
    connectHost: null,
  });
  await insertAndGetId("tunnel_hops", {
    tunnelId: multiEntryMultiExitTunnelId,
    seq: 1,
    hostId: hostIds[1],
    listenPort: 24443,
    connectHost: "fd00:10:10::20",
  });
  await insertAndGetId("tunnel_exit_nodes", {
    tunnelId: multiEntryMultiExitTunnelId,
    seq: 1,
    hostId: hostIds[2],
    listenPort: 24445,
    connectHost: "10.10.3.10",
    isEnabled: true,
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });
  await insertAndGetId("tunnel_exit_nodes", {
    tunnelId: multiEntryMultiExitTunnelId,
    seq: 2,
    hostId: hostIds[3],
    listenPort: 24446,
    connectHost: "172.86.92.18",
    isEnabled: true,
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });
  for (const [seriesKey, seriesLabel, latencyMs] of [
    ["total", "Total", 68],
    ["entry-hk", "HK entry -> JP exit", 42],
    ["entry-sg", "SG entry -> JP exit", 63],
    ["exit-jp", "Entry -> JP exit", 46],
    ["exit-sg", "Entry -> SG exit", 71],
    ["exit-us", "Entry -> US backup exit", 138],
  ] as const) {
    await insertAndGetId("tunnel_latency_stats", {
      tunnelId: multiEntryMultiExitTunnelId,
      seriesKey,
      seriesLabel,
      latencyMs,
      isTimeout: false,
      recordedAt: nowDate(),
    });
  }

  return {
    tunnels: {
      primaryTunnelId,
      multiEntryMultiExitTunnelId,
    },
    groups: {
      entryGroupId,
      exitGroupId,
      failoverGroupId,
      chainGroupId,
    },
  };
}

async function seedRules(hostIds: number[], resources: DevResources, usersSeed: DevUsers): Promise<DevRules> {
  const rules = [
    { userId: usersSeed.adminId, hostId: hostIds[0], name: "Website TCP forward", forwardType: "iptables", protocol: "tcp", sourcePort: 15201, targetIp: "2a0e:97c0:3f4:1::41d", targetPort: 5201, isRunning: true },
    { userId: usersSeed.adminId, hostId: hostIds[1], name: "Game TCP+UDP forward", forwardType: "realm", protocol: "both", sourcePort: 21001, targetIp: "10.10.3.88", targetPort: 25565, isRunning: true, proxyProtocolSend: true, proxyProtocolExitReceive: true, proxyProtocolExitSend: true },
    { userId: usersSeed.adminId, hostId: hostIds[2], name: "UDP over TCP sample", forwardType: "gost", protocol: "both", sourcePort: 32000, targetIp: "172.16.8.30", targetPort: 19132, udpOverTcp: true, udpOverTcpPort: 32001, isRunning: true },
    { userId: usersSeed.adminId, hostId: hostIds[3], name: "Offline backup rule", forwardType: "socat", protocol: "tcp", sourcePort: 30080, targetIp: "192.168.9.20", targetPort: 80, isRunning: false, disabledByUser: true },
    { userId: usersSeed.adminId, hostId: hostIds[0], name: "Dev multi-entry/multi-exit tunnel", forwardType: "gost", protocol: "both", sourcePort: 24443, targetIp: "10.30.0.44", targetPort: 443, tunnelId: resources.tunnels.multiEntryMultiExitTunnelId, tunnelExitPort: 24444, isRunning: true, proxyProtocolSend: true, proxyProtocolExitReceive: true },
    { userId: usersSeed.adminId, hostId: hostIds[0], name: "Dev group template", forwardType: "nginx_stream", protocol: "both", sourcePort: 15566, targetIp: "10.20.0.88", targetPort: 25565, forwardGroupId: resources.groups.failoverGroupId, isForwardGroupTemplate: true, telegramErrorNotifyEnabled: true, isRunning: false },
    { userId: usersSeed.adminId, hostId: hostIds[0], name: "Dev chain template", forwardType: "realm", protocol: "tcp", sourcePort: 18080, targetIp: "10.40.0.80", targetPort: 8080, forwardGroupId: resources.groups.chainGroupId, isForwardGroupTemplate: true, telegramErrorNotifyEnabled: true, isRunning: false },
    { userId: usersSeed.activeUserId, hostId: hostIds[1], name: "User tunnel demo", forwardType: "gost", protocol: "tcp", sourcePort: 26001, targetIp: "203.0.113.10", targetPort: 443, tunnelId: resources.tunnels.primaryTunnelId, tunnelExitPort: 26002, isRunning: true, failoverEnabled: true, failoverTargets: JSON.stringify([{ targetIp: "203.0.113.11", targetPort: 443 }]) },
    { userId: usersSeed.pausedUserId, hostId: hostIds[2], name: "Traffic billing pause demo", forwardType: "realm", protocol: "both", sourcePort: 27500, targetIp: "198.18.1.25", targetPort: 27015, isRunning: false, disabledByUser: true },
    { userId: usersSeed.expiredUserId, hostId: hostIds[3], name: "Expired account demo", forwardType: "socat", protocol: "tcp", sourcePort: 29500, targetIp: "192.0.2.81", targetPort: 8443, isRunning: false, disabledByUser: true },
  ] as const;

  const allRuleIds: number[] = [];
  for (const rule of rules) {
    allRuleIds.push(await insertAndGetId("forward_rules", {
      ...rule,
      tunnelId: (rule as any).tunnelId ?? null,
      tunnelExitPort: (rule as any).tunnelExitPort ?? null,
      forwardGroupId: (rule as any).forwardGroupId ?? null,
      forwardGroupRuleId: null,
      forwardGroupMemberId: null,
      isForwardGroupTemplate: !!(rule as any).isForwardGroupTemplate,
      isEnabled: !(rule as any).disabledByUser,
      createdAt: nowDate(),
      updatedAt: nowDate(),
    }));
  }

  const multiExitRuleId = allRuleIds[4];
  await reconcileForwardRuleTunnelExits(
    { id: multiExitRuleId, tunnelId: resources.tunnels.multiEntryMultiExitTunnelId },
    { id: resources.tunnels.multiEntryMultiExitTunnelId, mode: "tls", loadBalanceEnabled: true },
  );
  await syncForwardGroupRules(resources.groups.failoverGroupId, { preserveRuntime: true });
  await syncForwardGroupRules(resources.groups.chainGroupId, { preserveRuntime: true, validatePorts: false });

  for (const [index, ruleId] of allRuleIds.entries()) {
    const rule = rules[index];
    for (let i = 24; i >= 0; i -= 1) {
      await insertAndGetId("traffic_stats", {
        ruleId,
        hostId: rule.hostId,
        bytesIn: Math.round((40 + i * 3 + ruleId) * 1024 ** 2),
        bytesOut: Math.round((55 + i * 4 + ruleId) * 1024 ** 2),
        connections: 20 + i + ruleId,
        recordedAt: minutesAgo(i * 30),
      });
    }
    await insertAndGetId("tcping_stats", {
      ruleId,
      hostId: rule.hostId,
      latencyMs: 8 + ruleId * 11,
      isTimeout: false,
      recordedAt: nowDate(),
    });
    await insertAndGetId("forward_rule_traffic_counters", {
      ruleId,
      hostId: rule.hostId,
      userId: rule.userId,
      bytesIn: Math.round((ruleId + 18) * 1024 ** 3),
      bytesOut: Math.round((ruleId + 21) * 1024 ** 3),
      connections: 120 + ruleId * 3,
      createdAt: nowDate(),
      updatedAt: nowDate(),
    });
  }

  return {
    allRuleIds,
    adminRuleIds: allRuleIds.slice(0, 7),
    userRuleIds: {
      activeUserRuleId: allRuleIds[7],
      pausedUserRuleId: allRuleIds[8],
      expiredUserRuleId: allRuleIds[9],
    },
  };
}

async function seedProbeServices(adminId: number, hostIds: number[]) {
  const services = [
    { name: "Guangdong Unicom", targetIp: "probe-cu.dev.forwardx.local", targetPort: 443, base: 7, jitter: 4 },
    { name: "Guangdong Mobile", targetIp: "probe-cm.dev.forwardx.local", targetPort: 443, base: 24, jitter: 9 },
    { name: "Guangdong Telecom", targetIp: "probe-ct.dev.forwardx.local", targetPort: 443, base: 12, jitter: 6 },
    { name: "Yunnan Unicom", targetIp: "probe-yn-cu.dev.forwardx.local", targetPort: 443, base: 47, jitter: 14 },
    { name: "Yunnan Mobile", targetIp: "probe-yn-cm.dev.forwardx.local", targetPort: 443, base: 58, jitter: 18 },
    { name: "Yunnan Telecom", targetIp: "probe-yn-ct.dev.forwardx.local", targetPort: 443, base: 50, jitter: 12 },
    { name: "Cloudflare", targetIp: "probe-cf.dev.forwardx.local", targetPort: 443, base: 2, jitter: 2 },
    { name: "Google", targetIp: "probe-google.dev.forwardx.local", targetPort: 443, base: 3, jitter: 3 },
  ];
  const now = Date.now();
  const hostBias = [0, 14, 33, 86];

  for (const [serviceIndex, service] of services.entries()) {
    const serviceId = await insertAndGetId("host_probe_services", {
      userId: adminId,
      name: service.name,
      method: "tcping",
      targetIp: service.targetIp,
      targetPort: service.targetPort,
      hostScope: "all",
      intervalSeconds: 30,
      isEnabled: true,
      createdAt: nowDate(),
      updatedAt: nowDate(),
    });

    for (const [hostIndex, hostId] of hostIds.entries()) {
      for (let step = 47; step >= 0; step -= 1) {
        const recordedAt = new Date(now - step * 15 * 60 * 1000);
        const wave = Math.sin((step + serviceIndex * 7 + hostIndex * 3) / 5) * service.jitter;
        const smallJitter = ((step * (serviceIndex + 3) + hostIndex * 11) % 7) - 3;
        const spike = ((step + serviceIndex * 11 + hostIndex * 5) % 29 === 0) ? 80 + serviceIndex * 24 : 0;
        const timeout = (serviceIndex === 4 && hostIndex === 3 && step % 19 === 0) || (serviceIndex === 7 && step % 37 === 0);
        const latencyMs = timeout
          ? null
          : Math.max(1, Math.round(service.base + (hostBias[hostIndex] || 0) + wave + smallJitter + spike));
        await insertAndGetId("host_probe_service_stats", {
          serviceId,
          hostId,
          latencyMs,
          isTimeout: timeout,
          recordedAt,
        });
      }
    }
  }
}

async function seedCatalog(adminId: number, resources: DevResources, hostIds: number[]): Promise<DevCatalog> {
  const starterPlan = {
    name: "Dev starter",
    description: "A compact monthly plan used to exercise store, subscription, and entitlement UI.",
    priceCents: 1900,
    durationDays: 30,
    portCount: 20,
    trafficLimit: Math.round(500 * 1024 ** 3),
    rateLimitMbps: 200,
    maxRules: 20,
    maxConnections: 2000,
    maxIPs: 10,
    isActive: true,
    isStoreVisible: true,
    sortOrder: 1,
  };
  const proPlan = {
    name: "Dev flagship",
    description: "A yearly plan with broader host, tunnel, and forwarding-group access for local development.",
    priceCents: 9900,
    durationDays: 365,
    portCount: 200,
    trafficLimit: Math.round(5 * 1024 ** 4),
    rateLimitMbps: 1000,
    maxRules: 200,
    maxConnections: 20000,
    maxIPs: 100,
    isActive: true,
    isStoreVisible: true,
    sortOrder: 2,
  };

  const starterPlanId = await insertAndGetId("subscription_plans", {
    ...starterPlan,
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });
  const proPlanId = await insertAndGetId("subscription_plans", {
    ...proPlan,
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });

  for (const hostId of [hostIds[0], hostIds[1]]) {
    await insertAndGetId("subscription_plan_hosts", {
      planId: starterPlanId,
      hostId,
      createdAt: nowDate(),
    });
  }
  for (const hostId of hostIds) {
    await insertAndGetId("subscription_plan_hosts", {
      planId: proPlanId,
      hostId,
      createdAt: nowDate(),
    });
  }
  await insertAndGetId("subscription_plan_tunnels", {
    planId: starterPlanId,
    tunnelId: resources.tunnels.primaryTunnelId,
    createdAt: nowDate(),
  });
  for (const tunnelId of [resources.tunnels.primaryTunnelId, resources.tunnels.multiEntryMultiExitTunnelId]) {
    await insertAndGetId("subscription_plan_tunnels", {
      planId: proPlanId,
      tunnelId,
      createdAt: nowDate(),
    });
  }
  for (const planId of [starterPlanId, proPlanId]) {
    await insertAndGetId("subscription_plan_forward_groups", {
      planId,
      forwardGroupId: resources.groups.failoverGroupId,
      createdAt: nowDate(),
    });
  }
  await insertAndGetId("subscription_plan_forward_groups", {
    planId: proPlanId,
    forwardGroupId: resources.groups.chainGroupId,
    createdAt: nowDate(),
  });

  const burstAddonId = await insertAndGetId("subscription_plan_traffic_addons", {
    planId: starterPlanId,
    trafficBytes: Math.round(120 * 1024 ** 3),
    priceCents: 2000,
    isActive: true,
    sortOrder: 1,
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });
  const monthlyAddonId = await insertAndGetId("subscription_plan_traffic_addons", {
    planId: proPlanId,
    trafficBytes: Math.round(1024 ** 4),
    priceCents: 6600,
    isActive: true,
    sortOrder: 2,
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });

  const normalAnnouncementId = await insertAndGetId("announcements", {
    title: "Dev environment announcement",
    content: "Seeded for local development. Use this to verify list layout, badges, and read state.",
    type: "normal",
    isActive: true,
    createdByUserId: adminId,
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });
  const popupAnnouncementId = await insertAndGetId("announcements", {
    title: "Dev popup announcement",
    content: "This popup announcement is intentionally active so dashboard overlays and popup dismiss state can be tested locally.",
    type: "popup",
    isActive: true,
    startsAt: minutesAgo(30),
    expiresAt: daysFromNow(7),
    createdByUserId: adminId,
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });

  return {
    starterPlanId,
    proPlanId,
    addonIds: {
      burstAddonId,
      monthlyAddonId,
    },
    announcementIds: {
      normalAnnouncementId,
      popupAnnouncementId,
    },
  };
}

async function seedUserState(
  usersSeed: DevUsers,
  hostIds: number[],
  resources: DevResources,
  rules: DevRules,
  catalog: DevCatalog,
) {
  const starterSnapshot = buildPlanSnapshot({
    name: "Dev starter",
    portCount: 20,
    trafficLimit: Math.round(500 * 1024 ** 3),
    rateLimitMbps: 200,
    maxRules: 20,
    maxConnections: 2000,
    maxIPs: 10,
    hostIds: [hostIds[0], hostIds[1]],
    tunnelIds: [resources.tunnels.primaryTunnelId],
    forwardGroupIds: [resources.groups.failoverGroupId],
  });
  const proSnapshot = buildPlanSnapshot({
    name: "Dev flagship",
    portCount: 200,
    trafficLimit: Math.round(5 * 1024 ** 4),
    rateLimitMbps: 1000,
    maxRules: 200,
    maxConnections: 20000,
    maxIPs: 100,
    hostIds,
    tunnelIds: [resources.tunnels.primaryTunnelId, resources.tunnels.multiEntryMultiExitTunnelId],
    forwardGroupIds: [resources.groups.failoverGroupId, resources.groups.chainGroupId],
  });

  for (const counter of [
    { userId: usersSeed.activeUserId, bytesIn: 96, bytesOut: 92, connections: 1820 },
    { userId: usersSeed.pausedUserId, bytesIn: 74, bytesOut: 75, connections: 940 },
    { userId: usersSeed.expiredUserId, bytesIn: 41, bytesOut: 43, connections: 260 },
  ]) {
    await insertAndGetId("user_traffic_counters", {
      userId: counter.userId,
      bytesIn: Math.round(counter.bytesIn * 1024 ** 3),
      bytesOut: Math.round(counter.bytesOut * 1024 ** 3),
      connections: counter.connections,
      createdAt: nowDate(),
      updatedAt: nowDate(),
    });
  }

  for (const hostId of [hostIds[0], hostIds[1], hostIds[2]]) {
    await insertAndGetId("user_host_permissions", {
      userId: usersSeed.activeUserId,
      hostId,
      createdAt: nowDate(),
    });
  }
  for (const hostId of [hostIds[1], hostIds[2]]) {
    await insertAndGetId("user_host_permissions", {
      userId: usersSeed.pausedUserId,
      hostId,
      createdAt: nowDate(),
    });
  }
  await insertAndGetId("user_host_permissions", {
    userId: usersSeed.expiredUserId,
    hostId: hostIds[3],
    createdAt: nowDate(),
  });

  for (const tunnelId of [resources.tunnels.primaryTunnelId, resources.tunnels.multiEntryMultiExitTunnelId]) {
    await insertAndGetId("user_tunnel_permissions", {
      userId: usersSeed.activeUserId,
      tunnelId,
      createdAt: nowDate(),
    });
  }
  await insertAndGetId("user_tunnel_permissions", {
    userId: usersSeed.pausedUserId,
    tunnelId: resources.tunnels.primaryTunnelId,
    createdAt: nowDate(),
  });

  const activeSubscriptionId = await insertAndGetId("user_subscriptions", {
    userId: usersSeed.activeUserId,
    planId: catalog.starterPlanId,
    status: "active",
    source: "payment",
    paymentOrderNo: "DEV-ORDER-1001",
    planSnapshot: starterSnapshot,
    portRangeStart: 12000,
    portRangeEnd: 12019,
    nextTrafficResetAt: daysFromNow(10),
    lastTrafficResetAt: daysFromNow(-20),
    startedAt: daysFromNow(-20),
    expiresAt: daysFromNow(10),
    createdAt: daysFromNow(-20),
    updatedAt: nowDate(),
  });
  const pausedSubscriptionId = await insertAndGetId("user_subscriptions", {
    userId: usersSeed.pausedUserId,
    planId: catalog.proPlanId,
    status: "active",
    source: "admin",
    paymentOrderNo: "DEV-ORDER-1002",
    planSnapshot: proSnapshot,
    portRangeStart: 24450,
    portRangeEnd: 24649,
    nextTrafficResetAt: daysFromNow(12),
    lastTrafficResetAt: daysFromNow(-18),
    startedAt: daysFromNow(-80),
    expiresAt: daysFromNow(285),
    createdAt: daysFromNow(-80),
    updatedAt: nowDate(),
  });
  await insertAndGetId("user_subscriptions", {
    userId: usersSeed.expiredUserId,
    planId: catalog.starterPlanId,
    status: "expired",
    source: "redeem",
    paymentOrderNo: "DEV-ORDER-1003",
    planSnapshot: starterSnapshot,
    portRangeStart: 18000,
    portRangeEnd: 18019,
    nextTrafficResetAt: null,
    lastTrafficResetAt: daysFromNow(-45),
    startedAt: daysFromNow(-65),
    expiresAt: daysFromNow(-5),
    createdAt: daysFromNow(-65),
    updatedAt: daysFromNow(-5),
  });

  await insertAndGetId("user_traffic_addons", {
    userId: usersSeed.activeUserId,
    subscriptionId: activeSubscriptionId,
    planId: catalog.starterPlanId,
    addonId: catalog.addonIds.burstAddonId,
    trafficBytes: Math.round(120 * 1024 ** 3),
    priceCents: 2000,
    source: "user",
    status: "active",
    operatorUserId: usersSeed.adminId,
    description: "Burst add-on for local development",
    cycleResetAt: daysFromNow(10),
    expiresAt: daysFromNow(10),
    createdAt: daysFromNow(-4),
    updatedAt: nowDate(),
  });
  await insertAndGetId("user_traffic_addons", {
    userId: usersSeed.pausedUserId,
    subscriptionId: pausedSubscriptionId,
    planId: catalog.proPlanId,
    addonId: catalog.addonIds.monthlyAddonId,
    trafficBytes: Math.round(1024 ** 4),
    priceCents: 6600,
    source: "admin",
    status: "expired",
    operatorUserId: usersSeed.adminId,
    description: "Expired monthly traffic package",
    cycleResetAt: daysFromNow(-15),
    expiresAt: daysFromNow(-15),
    expiredAt: daysFromNow(-15),
    createdAt: daysFromNow(-48),
    updatedAt: daysFromNow(-15),
  });

  await insertAndGetId("payment_orders", {
    outTradeNo: "DEV-ORDER-1001",
    userId: usersSeed.activeUserId,
    provider: "easypay",
    paymentType: "alipay",
    status: "paid",
    subject: "Starter plan purchase",
    amountCents: 3900,
    currency: "CNY",
    tradeNo: "ALI-DEV-1001",
    payUrl: "https://pay.dev.forwardx.local/order/1001",
    qrCode: "https://pay.dev.forwardx.local/qr/1001",
    orderType: "plan",
    planId: catalog.starterPlanId,
    subscriptionId: activeSubscriptionId,
    discountAmountCents: 1000,
    clientIp: "203.0.113.40",
    paidAt: daysFromNow(-20),
    createdAt: daysFromNow(-20),
    updatedAt: daysFromNow(-20),
  });
  await insertAndGetId("payment_orders", {
    outTradeNo: "DEV-ORDER-1002",
    userId: usersSeed.pausedUserId,
    provider: "easypay",
    paymentType: "wxpay",
    status: "completed",
    subject: "Pro plan renewal",
    amountCents: 9900,
    currency: "CNY",
    tradeNo: "WX-DEV-1002",
    orderType: "plan",
    planId: catalog.proPlanId,
    subscriptionId: pausedSubscriptionId,
    clientIp: "198.51.100.76",
    paidAt: daysFromNow(-80),
    createdAt: daysFromNow(-80),
    updatedAt: daysFromNow(-80),
  });
  await insertAndGetId("payment_orders", {
    outTradeNo: "DEV-ORDER-1004",
    userId: usersSeed.activeUserId,
    provider: "easypay",
    paymentType: "wxpay",
    status: "pending",
    subject: "Wallet top-up",
    amountCents: 5000,
    currency: "CNY",
    orderType: "balance",
    payUrl: "https://pay.dev.forwardx.local/order/1004",
    qrCode: "https://pay.dev.forwardx.local/qr/1004",
    clientIp: "203.0.113.55",
    expiresAt: daysFromNow(1),
    createdAt: minutesAgo(15),
    updatedAt: minutesAgo(5),
  });

  await insertAndGetId("balance_transactions", {
    userId: usersSeed.activeUserId,
    type: "payment",
    amountCents: 20_000,
    balanceAfterCents: 20_000,
    description: "Wallet top-up from EasyPay",
    operatorUserId: usersSeed.adminId,
    paymentOrderNo: "DEV-ORDER-1001",
    createdAt: daysFromNow(-20),
  });
  await insertAndGetId("balance_transactions", {
    userId: usersSeed.activeUserId,
    type: "purchase",
    amountCents: -3_900,
    balanceAfterCents: 16_100,
    description: "Starter plan purchase",
    operatorUserId: usersSeed.adminId,
    paymentOrderNo: "DEV-ORDER-1001",
    createdAt: daysFromNow(-20),
  });
  await insertAndGetId("balance_transactions", {
    userId: usersSeed.activeUserId,
    type: "traffic_addon_purchase",
    amountCents: -2_000,
    balanceAfterCents: 14_100,
    description: "Burst traffic add-on",
    operatorUserId: usersSeed.adminId,
    createdAt: daysFromNow(-4),
  });
  await insertAndGetId("balance_transactions", {
    userId: usersSeed.activeUserId,
    type: "traffic_billing",
    amountCents: -1_300,
    balanceAfterCents: 12_800,
    description: "Traffic billing settlement",
    operatorUserId: usersSeed.adminId,
    createdAt: daysFromNow(-1),
  });
  await insertAndGetId("balance_transactions", {
    userId: usersSeed.pausedUserId,
    type: "admin_recharge",
    amountCents: 3_000,
    balanceAfterCents: 3_000,
    description: "Manual top-up for billing demo",
    operatorUserId: usersSeed.adminId,
    createdAt: daysFromNow(-90),
  });
  await insertAndGetId("balance_transactions", {
    userId: usersSeed.pausedUserId,
    type: "purchase",
    amountCents: -2_600,
    balanceAfterCents: 400,
    description: "Pro plan deduction",
    operatorUserId: usersSeed.adminId,
    paymentOrderNo: "DEV-ORDER-1002",
    createdAt: daysFromNow(-80),
  });
  await insertAndGetId("balance_transactions", {
    userId: usersSeed.pausedUserId,
    type: "traffic_billing",
    amountCents: -400,
    balanceAfterCents: 0,
    description: "Traffic billing paused due to low balance",
    operatorUserId: usersSeed.adminId,
    createdAt: daysFromNow(-2),
  });

  await insertAndGetId("traffic_billing_configs", {
    resourceType: "tunnel",
    resourceId: resources.tunnels.primaryTunnelId,
    enabled: true,
    requiresPermission: true,
    description: "Bill tunnel traffic in the dev panel",
    pricePerGbCents: 280,
    pricePerGbMilliCents: 280_000,
    multiplier: 100,
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });
  await insertAndGetId("traffic_billing_configs", {
    resourceType: "host",
    resourceId: hostIds[1],
    enabled: true,
    requiresPermission: true,
    description: "Bill premium host traffic in the dev panel",
    pricePerGbCents: 180,
    pricePerGbMilliCents: 180_000,
    multiplier: 100,
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });
  for (const permission of [
    { userId: usersSeed.activeUserId, resourceType: "tunnel", resourceId: resources.tunnels.primaryTunnelId },
    { userId: usersSeed.activeUserId, resourceType: "host", resourceId: hostIds[1] },
    { userId: usersSeed.pausedUserId, resourceType: "tunnel", resourceId: resources.tunnels.primaryTunnelId },
  ]) {
    await insertAndGetId("user_traffic_billing_permissions", {
      ...permission,
      createdAt: nowDate(),
    });
  }

  await insertAndGetId("traffic_billing_usage", {
    userId: usersSeed.activeUserId,
    resourceType: "tunnel",
    resourceId: resources.tunnels.primaryTunnelId,
    totalBytes: Math.round(18 * 1024 ** 3),
    billedGb: 18,
    pendingMilliCents: 0,
    updatedAt: nowDate(),
  });
  await insertAndGetId("traffic_billing_usage", {
    userId: usersSeed.activeUserId,
    resourceType: "host",
    resourceId: hostIds[1],
    totalBytes: Math.round(7 * 1024 ** 3),
    billedGb: 7,
    pendingMilliCents: 0,
    updatedAt: nowDate(),
  });
  await insertAndGetId("traffic_billing_usage", {
    userId: usersSeed.pausedUserId,
    resourceType: "tunnel",
    resourceId: resources.tunnels.primaryTunnelId,
    totalBytes: Math.round(4 * 1024 ** 3),
    billedGb: 4,
    pendingMilliCents: 0,
    updatedAt: nowDate(),
  });

  await insertAndGetId("traffic_billing_rule_usage", {
    userId: usersSeed.activeUserId,
    ruleId: rules.userRuleIds.activeUserRuleId,
    resourceType: "tunnel",
    resourceId: resources.tunnels.primaryTunnelId,
    totalBytes: Math.round(18 * 1024 ** 3),
    billedGb: 18,
    pendingMilliCents: 0,
    settled: true,
    updatedAt: nowDate(),
  });
  await insertAndGetId("traffic_billing_rule_usage", {
    userId: usersSeed.pausedUserId,
    ruleId: rules.userRuleIds.pausedUserRuleId,
    resourceType: "tunnel",
    resourceId: resources.tunnels.primaryTunnelId,
    totalBytes: Math.round(4 * 1024 ** 3),
    billedGb: 4,
    pendingMilliCents: 0,
    settled: true,
    updatedAt: nowDate(),
  });

  await insertAndGetId("traffic_billing_records", {
    userId: usersSeed.activeUserId,
    ruleId: rules.userRuleIds.activeUserRuleId,
    resourceType: "tunnel",
    resourceId: resources.tunnels.primaryTunnelId,
    bytes: Math.round(18 * 1024 ** 3),
    billedGb: 18,
    pricePerGbCents: 280,
    pricePerGbMilliCents: 280_000,
    multiplier: 100,
    amountCents: 5_040,
    balanceAfterCents: 12_800,
    createdAt: daysFromNow(-1),
  });
  await insertAndGetId("traffic_billing_records", {
    userId: usersSeed.pausedUserId,
    ruleId: rules.userRuleIds.pausedUserRuleId,
    resourceType: "tunnel",
    resourceId: resources.tunnels.primaryTunnelId,
    bytes: Math.round(4 * 1024 ** 3),
    billedGb: 4,
    pricePerGbCents: 100,
    pricePerGbMilliCents: 100_000,
    multiplier: 100,
    amountCents: 400,
    balanceAfterCents: 0,
    createdAt: daysFromNow(-2),
  });

  await insertAndGetId("redemption_codes", {
    code: "DEV-PLAN-2026",
    type: "plan",
    planId: catalog.starterPlanId,
    durationDays: 30,
    amountCents: 0,
    startsAt: daysFromNow(-5),
    expiresAt: daysFromNow(30),
    isActive: true,
    createdByUserId: usersSeed.adminId,
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });
  const redeemedCodeId = await insertAndGetId("redemption_codes", {
    code: "DEV-BALANCE-USED",
    type: "balance",
    amountCents: 5000,
    startsAt: daysFromNow(-90),
    expiresAt: daysFromNow(30),
    isActive: true,
    usedByUserId: usersSeed.expiredUserId,
    usedAt: daysFromNow(-40),
    createdByUserId: usersSeed.adminId,
    createdAt: daysFromNow(-90),
    updatedAt: daysFromNow(-40),
  });
  await insertAndGetId("balance_transactions", {
    userId: usersSeed.expiredUserId,
    type: "redeem",
    amountCents: 5000,
    balanceAfterCents: 5000,
    description: "Redeemed DEV-BALANCE-USED",
    operatorUserId: usersSeed.adminId,
    redemptionCodeId: redeemedCodeId,
    createdAt: daysFromNow(-40),
  });

  const starterDiscountId = await insertAndGetId("discount_codes", {
    code: "DEVSTART25",
    discountType: "percent",
    discountValue: 25,
    maxUses: 50,
    usedCount: 6,
    startsAt: daysFromNow(-15),
    expiresAt: daysFromNow(15),
    isActive: true,
    createdByUserId: usersSeed.adminId,
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });
  const proDiscountId = await insertAndGetId("discount_codes", {
    code: "DEVPRO500",
    discountType: "amount",
    discountValue: 500,
    maxUses: 10,
    usedCount: 2,
    startsAt: daysFromNow(-30),
    expiresAt: daysFromNow(60),
    isActive: true,
    createdByUserId: usersSeed.adminId,
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });
  for (const row of [
    { discountCodeId: starterDiscountId, planId: catalog.starterPlanId },
    { discountCodeId: proDiscountId, planId: catalog.proPlanId },
  ]) {
    await insertAndGetId("discount_code_plans", {
      ...row,
      createdAt: nowDate(),
    });
  }

  await insertAndGetId("announcement_reads", {
    announcementId: catalog.announcementIds.normalAnnouncementId,
    userId: usersSeed.activeUserId,
    dismissedAt: minutesAgo(40),
  });
  await insertAndGetId("announcement_reads", {
    announcementId: catalog.announcementIds.normalAnnouncementId,
    userId: usersSeed.pausedUserId,
    dismissedAt: minutesAgo(20),
  });
}

async function seedForwardTests(usersSeed: DevUsers, rules: DevRules, hostIds: number[]) {
  for (const test of [
    {
      ruleId: rules.adminRuleIds[0],
      hostId: hostIds[0],
      userId: usersSeed.adminId,
      status: "success",
      listenOk: true,
      targetReachable: true,
      forwardOk: true,
      latencyMs: 28,
      message: "Forward test succeeded on the primary path.",
      createdAt: minutesAgo(12),
      updatedAt: minutesAgo(12),
    },
    {
      ruleId: rules.userRuleIds.activeUserRuleId,
      hostId: hostIds[1],
      userId: usersSeed.activeUserId,
      status: "failed",
      listenOk: true,
      targetReachable: false,
      forwardOk: false,
      latencyMs: null,
      message: "Target endpoint rejected the last probe from the dev seed.",
      createdAt: minutesAgo(45),
      updatedAt: minutesAgo(44),
    },
    {
      ruleId: rules.userRuleIds.pausedUserRuleId,
      hostId: hostIds[2],
      userId: usersSeed.pausedUserId,
      status: "timeout",
      listenOk: false,
      targetReachable: false,
      forwardOk: false,
      latencyMs: null,
      message: "Traffic billing pause demo intentionally times out.",
      createdAt: minutesAgo(80),
      updatedAt: minutesAgo(78),
    },
    {
      ruleId: rules.userRuleIds.expiredUserRuleId,
      hostId: hostIds[3],
      userId: usersSeed.expiredUserId,
      status: "pending",
      listenOk: false,
      targetReachable: false,
      forwardOk: false,
      latencyMs: null,
      message: "Pending check for an expired account sample.",
      createdAt: minutesAgo(4),
      updatedAt: minutesAgo(4),
    },
  ]) {
    await insertAndGetId("forward_tests", test);
  }
}

async function seedSettings() {
  await setSettings({
    setupDataChoice: "new-panel",
    siteTitle: "ForwardX Dev",
    registrationEnabled: "true",
    storeEnabled: "true",
    trafficBillingEnabled: "true",
    redemptionEnabled: "true",
    discountEnabled: "true",
    lookingGlassUserEnabled: "true",
    publicHostMonitorEnabled: "true",
    publicHostMonitorPath: "dev",
    publicHostMonitorTitle: "ForwardX Dev Host Monitor",
    latestAgentVersion: "2.2.129",
    agentVersion: "2.2.129",
    telegramBotEnabled: "false",
    systemAnnouncementEnabled: "true",
    allowMultiDeviceLogin: "true",
  });
}

export async function seedDevPanelData() {
  if (!isDevPanelMode()) return;
  const db = await getDb();
  if (!db) return;

  const adminId = await ensureDevAdmin();
  await clearDevData();

  const usersSeed = await seedUsers(adminId);
  const hostIds = await seedHosts(adminId);
  await seedAgentTokens(adminId, hostIds);
  await seedHostGroups(adminId, hostIds);
  await seedHostMetrics(hostIds);
  const resources = await seedTunnelsAndGroups(adminId, hostIds);
  const rules = await seedRules(hostIds, resources, usersSeed);
  await seedProbeServices(adminId, hostIds);
  const catalog = await seedCatalog(adminId, resources, hostIds);
  await seedUserState(usersSeed, hostIds, resources, rules, catalog);
  await seedForwardTests(usersSeed, rules, hostIds);
  await seedSettings();
  await setSetting("devPanelSeededAt", new Date().toISOString());

  console.log(`[DevPanel] Seeded local development data as ${DEV_ADMIN_USERNAME}`);
}
