import { Router, Request, Response } from "express";
import * as db from "./db";
import { AGENT_VERSION } from "./_core/systemRouter";
import { isHostMetricsWatching } from "./agentEvents";
import { isAgentVersionAtLeast, parseSelfTestMeta, tunnelSecretSeed } from "./agentRouteUtils";
import { resolvePanelUrl } from "./agentPanelUrl";
import * as hopRepo from "./repositories/tunnelRepository";
import crypto from "crypto";
import {
  getForwardProtocolSettings,
  isRuleProtocolEnabled,
  isTunnelProtocolEnabled,
} from "./forwardProtocolSettings";
import { isTunnelRuntimeHostReady } from "./tunnelRuntimeStatus";
import { appendPanelLog } from "./_core/panelLogger";
import { isIP } from "net";
import { resolve4 } from "dns/promises";
import { takeLookingGlassAgentTasks } from "./lookingGlassAgentTasks";
import { takeIperf3AgentTasks } from "./iperf3AgentTasks";
import { getAgentHostFromRequest, getResolvedAgentToken } from "./agentAuth";
import { normalizeAgentText, normalizeNetworkInterface } from "./agentInputValidation";

// DNS 解析缓存：ruleId → 主目标上次解析到的 IPv4 地址。
// 备用出站策略里的域名由 Agent 的 TCP 拨号和健康检查动态解析。
const resolvedIpCache = new Map<number, string>();
const tunnelRouteLogCache = new Map<string, string>();

function parseFailoverTargets(raw: unknown) {
  if (!raw || typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((target) => ({ targetIp: String(target?.targetIp || "").trim(), targetPort: Number(target?.targetPort) }))
      .filter((target) => target.targetIp && target.targetPort >= 1 && target.targetPort <= 65535)
      .slice(0, 10);
  } catch {
    return [];
  }
}

async function resolveTargetIp(raw: string): Promise<string> {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return trimmed;
  if (isIP(trimmed)) return trimmed;
  try {
    const ips = await resolve4(trimmed);
    if (ips.length > 0) return ips[0];
  } catch { /* fall through */ }
  return trimmed; // 解析失败返回原值
}

export function registerAgentHeartbeatRoute(agentRouter: Router) {
agentRouter.post("/api/agent/heartbeat", async (req: Request, res: Response) => {
  try {
    const token = getResolvedAgentToken(req);
    const host = await getAgentHostFromRequest(req);
    if (!host) {
      const migratedTo = await db.getSetting("migratedToPanelUrl");
      if (migratedTo) {
        res.status(410).json({
          success: false,
          agentUpgrade: { targetVersion: "9999.0.0", panelUrl: migratedTo },
          error: "Panel migrated",
        });
        return;
      }
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    const { cpuUsage, cpuInfo, memoryUsage, memoryUsed, networkIn, networkOut, diskUsage, diskUsed, diskTotal, uptime, agentVersion } = req.body;
    const nextCpuInfo = normalizeAgentText(cpuInfo, 256);
    const nextAgentVersion = normalizeAgentText(agentVersion, 64);

    await db.updateHostHeartbeat(host.id, {
      agentVersion: nextAgentVersion || (host as any).agentVersion || null,
      cpuInfo: nextCpuInfo || (host as any).cpuInfo || null,
    } as any);

    await db.insertHostMetric({
      hostId: host.id,
      cpuUsage: cpuUsage ?? null,
      memoryUsage: memoryUsage ?? null,
      memoryUsed: memoryUsed ?? null,
      networkIn: networkIn ?? null,
      networkOut: networkOut ?? null,
      diskUsage: diskUsage ?? null,
      diskUsed: diskUsed ?? null,
      diskTotal: diskTotal ?? null,
      uptime: uptime ?? null,
    });

    // 获取该主机的转发规则
    const rules = await db.getForwardRulesForAgent(host.id);
    const hostTunnels = await db.getTunnelsByHost(host.id);
    const forwardProtocolSettings = await getForwardProtocolSettings();
    const actions: any[] = [];
    const responseIssuedAt = Date.now();

    // 获取主机配置的网卡名称（用于 realm --interface）
    const hostInterface = normalizeNetworkInterface((host as any).networkInterface);

    /** 包装一条只追加一次的 iptables 规则：先 -C 检查是否存在，不存在才 -A */
    const ipIfMissing = (rule: string) => `iptables -C ${rule} 2>/dev/null || iptables -A ${rule}`;
    const ipIfMissingT = (table: string, rule: string) =>
      `iptables -t ${table} -C ${rule} 2>/dev/null || iptables -t ${table} -A ${rule}`;

    /**
     * 为转发规则创建一对 mangle 计数链以跨转发方式采集准确流量。
     * - FWX_IN_<port>：匹配 dport=<port> 的入站包（客户端→Agent）
     * - FWX_OUT_<port>：匹配 sport=<port> 的出站包（Agent→客户端响应）
     * 不设 RETURN，所以只作计数不影响路由。三种转发方式都会经过 mangle 表，覆盖 100% 路径。
     */
    const buildCountingChainCmds = (port: number, targetIp?: string, targetPort?: number, protocol?: string): string[] => {
      const protos = protocol === "tcp" || protocol === "udp" ? [protocol] : ["tcp", "udp"];
      const inMarker = `fwx-stat-${port}:in`;
      const outMarker = `fwx-stat-${port}:out`;
      const addStatRule = (chain: string, rule: string, marker: string) =>
        `iptables -t mangle -C ${chain} ${rule} -m comment --comment "${marker}" 2>/dev/null || iptables -t mangle -A ${chain} ${rule} -m comment --comment "${marker}"`;
      const cmds: string[] = [...buildCountingCleanupCmds(port, targetIp, targetPort, protocol)];
      for (const proto of protos) {
        cmds.push(addStatRule("PREROUTING", `-p ${proto} --dport ${port}`, inMarker));
        cmds.push(addStatRule("INPUT", `-p ${proto} --dport ${port}`, inMarker));
        cmds.push(addStatRule("POSTROUTING", `-p ${proto} --sport ${port}`, outMarker));
        cmds.push(addStatRule("OUTPUT", `-p ${proto} --sport ${port}`, outMarker));
        if (targetIp && Number(targetPort) > 0) {
          cmds.push(addStatRule("FORWARD", `-p ${proto} -d ${targetIp} --dport ${targetPort}`, inMarker));
          cmds.push(addStatRule("FORWARD", `-p ${proto} -s ${targetIp} --sport ${targetPort}`, outMarker));
        }
      }
      return cmds;
    };
    const buildCountingCleanupCmds = (port: number, targetIp?: string, targetPort?: number, protocol?: string): string[] => {
      const protos = protocol === "tcp" || protocol === "udp" ? [protocol] : ["tcp", "udp"];
      const inMarker = `fwx-stat-${port}:in`;
      const outMarker = `fwx-stat-${port}:out`;
      const cmds = [
        `iptables -t mangle -D PREROUTING -p tcp --dport ${port} -j FWX_IN_${port} 2>/dev/null || true`,
        `iptables -t mangle -D PREROUTING -p udp --dport ${port} -j FWX_IN_${port} 2>/dev/null || true`,
        `iptables -t mangle -D POSTROUTING -p tcp --sport ${port} -j FWX_OUT_${port} 2>/dev/null || true`,
        `iptables -t mangle -D POSTROUTING -p udp --sport ${port} -j FWX_OUT_${port} 2>/dev/null || true`,
        `iptables -t mangle -D INPUT -p tcp --dport ${port} -j FWX_IN_${port} 2>/dev/null || true`,
        `iptables -t mangle -D INPUT -p udp --dport ${port} -j FWX_IN_${port} 2>/dev/null || true`,
        `iptables -t mangle -D OUTPUT -p tcp --sport ${port} -j FWX_OUT_${port} 2>/dev/null || true`,
        `iptables -t mangle -D OUTPUT -p udp --sport ${port} -j FWX_OUT_${port} 2>/dev/null || true`,
        `iptables -t mangle -D FORWARD -p tcp -j FWX_IN_${port} 2>/dev/null || true`,
        `iptables -t mangle -D FORWARD -p udp -j FWX_IN_${port} 2>/dev/null || true`,
        `iptables -t mangle -D FORWARD -p tcp -j FWX_OUT_${port} 2>/dev/null || true`,
        `iptables -t mangle -D FORWARD -p udp -j FWX_OUT_${port} 2>/dev/null || true`,
        `iptables -t mangle -F FWX_IN_${port} 2>/dev/null || true`,
        `iptables -t mangle -X FWX_IN_${port} 2>/dev/null || true`,
        `iptables -t mangle -F FWX_OUT_${port} 2>/dev/null || true`,
        `iptables -t mangle -X FWX_OUT_${port} 2>/dev/null || true`,
      ];
      for (const proto of protos) {
        cmds.unshift(`iptables -t mangle -D PREROUTING -p ${proto} --dport ${port} -m comment --comment "${inMarker}" 2>/dev/null || true`);
        cmds.unshift(`iptables -t mangle -D INPUT -p ${proto} --dport ${port} -m comment --comment "${inMarker}" 2>/dev/null || true`);
        cmds.unshift(`iptables -t mangle -D POSTROUTING -p ${proto} --sport ${port} -m comment --comment "${outMarker}" 2>/dev/null || true`);
        cmds.unshift(`iptables -t mangle -D OUTPUT -p ${proto} --sport ${port} -m comment --comment "${outMarker}" 2>/dev/null || true`);
        if (targetIp && Number(targetPort) > 0) {
          cmds.unshift(`iptables -t mangle -D FORWARD -p ${proto} -d ${targetIp} --dport ${targetPort} -m comment --comment "${inMarker}" 2>/dev/null || true`);
          cmds.unshift(`iptables -t mangle -D FORWARD -p ${proto} -s ${targetIp} --sport ${targetPort} -m comment --comment "${outMarker}" 2>/dev/null || true`);
          cmds.unshift(`iptables -t mangle -D FORWARD -p ${proto} -d ${targetIp} --dport ${targetPort} -j FWX_IN_${port} 2>/dev/null || true`);
          cmds.unshift(`iptables -t mangle -D FORWARD -p ${proto} -s ${targetIp} --sport ${targetPort} -j FWX_OUT_${port} 2>/dev/null || true`);
          cmds.unshift(`iptables -t mangle -D OUTPUT -p ${proto} -d ${targetIp} --dport ${targetPort} -j FWX_IN_${port} 2>/dev/null || true`);
          cmds.unshift(`iptables -t mangle -D POSTROUTING -p ${proto} -d ${targetIp} --dport ${targetPort} -j FWX_IN_${port} 2>/dev/null || true`);
          cmds.unshift(`iptables -t mangle -D PREROUTING -p ${proto} -s ${targetIp} --sport ${targetPort} -j FWX_OUT_${port} 2>/dev/null || true`);
          cmds.unshift(`iptables -t mangle -D INPUT -p ${proto} -s ${targetIp} --sport ${targetPort} -j FWX_OUT_${port} 2>/dev/null || true`);
        }
      }
      return cmds;
    };
    const nftTable = "forwardx";
    const nftChain = (prefix: string, id: number) => `${prefix}_${id}`;
    const nftComment = (rule: any) => `fwx-rule-${Number(rule.id) || 0}`;
    const nftTrafficPreroutingChain = "traffic_prerouting";
    const nftTrafficPostroutingChain = "traffic_postrouting";
    const buildNftCleanupCmds = (rule: any): string[] => {
      const ruleId = Number(rule.id) || 0;
      const comment = nftComment(rule);
      return [
        `nft list table inet ${nftTable} >/dev/null 2>&1 || exit 0; for h in $(nft -a list chain inet ${nftTable} prerouting 2>/dev/null | awk -v c='"${comment}"' '$0 ~ c {print $NF}'); do nft delete rule inet ${nftTable} prerouting handle "$h" 2>/dev/null || true; done`,
        `nft list table inet ${nftTable} >/dev/null 2>&1 || exit 0; for h in $(nft -a list chain inet ${nftTable} postrouting 2>/dev/null | awk -v c='"${comment}"' '$0 ~ c {print $NF}'); do nft delete rule inet ${nftTable} postrouting handle "$h" 2>/dev/null || true; done`,
        `nft list table inet ${nftTable} >/dev/null 2>&1 || exit 0; for h in $(nft -a list chain inet ${nftTable} forward 2>/dev/null | awk -v c='"${comment}"' '$0 ~ c {print $NF}'); do nft delete rule inet ${nftTable} forward handle "$h" 2>/dev/null || true; done`,
        `nft list table inet ${nftTable} >/dev/null 2>&1 || exit 0; for h in $(nft -a list chain inet ${nftTable} ${nftTrafficPreroutingChain} 2>/dev/null | awk -v c='"${comment}"' '$0 ~ c {print $NF}'); do nft delete rule inet ${nftTable} ${nftTrafficPreroutingChain} handle "$h" 2>/dev/null || true; done`,
        `nft list table inet ${nftTable} >/dev/null 2>&1 || exit 0; for h in $(nft -a list chain inet ${nftTable} ${nftTrafficPostroutingChain} 2>/dev/null | awk -v c='"${comment}"' '$0 ~ c {print $NF}'); do nft delete rule inet ${nftTable} ${nftTrafficPostroutingChain} handle "$h" 2>/dev/null || true; done`,
        `nft flush chain inet ${nftTable} ${nftChain("in", ruleId)} 2>/dev/null || true`,
        `nft delete chain inet ${nftTable} ${nftChain("in", ruleId)} 2>/dev/null || true`,
        `nft flush chain inet ${nftTable} ${nftChain("out", ruleId)} 2>/dev/null || true`,
        `nft delete chain inet ${nftTable} ${nftChain("out", ruleId)} 2>/dev/null || true`,
        `rm -f /var/lib/forwardx-agent/traffic_${rule.sourcePort}.prev /var/lib/forwardx-agent/port_${rule.sourcePort}.rule /var/lib/forwardx-agent/port_${rule.sourcePort}.fwtype /var/lib/forwardx-agent/target_${rule.sourcePort}.info 2>/dev/null || true`,
      ];
    };
    const buildNftForwardCmds = (rule: any): string[] => {
      const protos = rule.protocol === "both" ? ["tcp", "udp"] : [rule.protocol === "udp" ? "udp" : "tcp"];
      const ruleId = Number(rule.id) || 0;
      const comment = nftComment(rule);
      const cmds = [
        `command -v nft >/dev/null 2>&1`,
        `sysctl -w net.ipv4.ip_forward=1 >/dev/null`,
        `nft add table inet ${nftTable} 2>/dev/null || true`,
        `nft add chain inet ${nftTable} prerouting '{ type nat hook prerouting priority dstnat; policy accept; }' 2>/dev/null || true`,
        `nft add chain inet ${nftTable} postrouting '{ type nat hook postrouting priority srcnat; policy accept; }' 2>/dev/null || true`,
        `nft add chain inet ${nftTable} forward '{ type filter hook forward priority filter; policy accept; }' 2>/dev/null || true`,
        `nft add chain inet ${nftTable} ${nftTrafficPreroutingChain} '{ type filter hook prerouting priority -150; policy accept; }' 2>/dev/null || true`,
        `nft add chain inet ${nftTable} ${nftTrafficPostroutingChain} '{ type filter hook postrouting priority -150; policy accept; }' 2>/dev/null || true`,
        ...buildNftCleanupCmds(rule),
        `nft add table inet ${nftTable} 2>/dev/null || true`,
        `nft add chain inet ${nftTable} prerouting '{ type nat hook prerouting priority dstnat; policy accept; }' 2>/dev/null || true`,
        `nft add chain inet ${nftTable} postrouting '{ type nat hook postrouting priority srcnat; policy accept; }' 2>/dev/null || true`,
        `nft add chain inet ${nftTable} forward '{ type filter hook forward priority filter; policy accept; }' 2>/dev/null || true`,
        `nft add chain inet ${nftTable} ${nftTrafficPreroutingChain} '{ type filter hook prerouting priority -150; policy accept; }' 2>/dev/null || true`,
        `nft add chain inet ${nftTable} ${nftTrafficPostroutingChain} '{ type filter hook postrouting priority -150; policy accept; }' 2>/dev/null || true`,
      ];
      for (const proto of protos) {
        cmds.push(`nft add rule inet ${nftTable} ${nftTrafficPreroutingChain} ip protocol ${proto} ${proto} dport ${rule.sourcePort} counter comment "${comment}:in"`);
        cmds.push(`nft add rule inet ${nftTable} ${nftTrafficPostroutingChain} ip protocol ${proto} ip saddr ${rule.targetIp} ${proto} sport ${rule.targetPort} counter comment "${comment}:out"`);
        cmds.push(`nft add rule inet ${nftTable} prerouting ${proto} dport ${rule.sourcePort} dnat ip to ${rule.targetIp}:${rule.targetPort} comment "${comment}"`);
        cmds.push(`nft add rule inet ${nftTable} postrouting ip protocol ${proto} ip daddr ${rule.targetIp} ${proto} dport ${rule.targetPort} masquerade comment "${comment}"`);
        cmds.push(`nft add rule inet ${nftTable} forward ip protocol ${proto} ip daddr ${rule.targetIp} ${proto} dport ${rule.targetPort} accept comment "${comment}"`);
        cmds.push(`nft add rule inet ${nftTable} forward ip protocol ${proto} ip saddr ${rule.targetIp} ${proto} sport ${rule.targetPort} ct state established,related accept comment "${comment}"`);
      }
      return cmds;
    };
    const buildManagedPortCleanupCmds = (port: number, targetIp?: string, targetPort?: number, protocol?: string): string[] => [
      `systemctl stop forwardx-socat-${port}.service forwardx-socat-tcp-${port}.service forwardx-socat-udp-${port}.service forwardx-realm-${port}.service 2>/dev/null || true`,
      `systemctl disable forwardx-socat-${port}.service forwardx-socat-tcp-${port}.service forwardx-socat-udp-${port}.service forwardx-realm-${port}.service 2>/dev/null || true`,
      `rm -f /etc/systemd/system/forwardx-socat-${port}.service /etc/systemd/system/forwardx-socat-tcp-${port}.service /etc/systemd/system/forwardx-socat-udp-${port}.service /etc/systemd/system/forwardx-realm-${port}.service`,
      `systemctl daemon-reload`,
      `rm -f /var/lib/forwardx-agent/traffic_${port}.prev /var/lib/forwardx-agent/port_${port}.rule /var/lib/forwardx-agent/port_${port}.fwtype /var/lib/forwardx-agent/target_${port}.info 2>/dev/null || true`,
      ...buildCountingCleanupCmds(port, targetIp, targetPort, protocol),
    ];
    const killByPatternCmd = (pattern: string) =>
      `for pid in $(pgrep -f '${pattern}' 2>/dev/null || true); do if [ "$pid" = "$$" ] || [ "$pid" = "$PPID" ]; then continue; fi; kill "$pid" 2>/dev/null || true; done`;
    const writeUnitCmd = (svcName: string, unit: string) =>
      `printf '%s' '${Buffer.from(unit, "utf8").toString("base64")}' | base64 -d > /etc/systemd/system/${svcName}.service`;
    const gostServiceName = "forwardx-gost";
    const gostServiceUnit = [
      "[Unit]",
      "Description=ForwardX unified gost forwarder",
      "After=network.target",
      "",
      "[Service]",
      "Type=simple",
      "ExecStart=/usr/local/bin/gost -C /etc/forwardx-gost/config.json",
      "Restart=always",
      "RestartSec=5",
      "LimitNOFILE=65535",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "",
    ].join("\n");
    const agentHostRules = await db.getForwardRulesForAgent(host.id);
    // DNS 预解析：将域名转换为 IP，缓存中比较检测变更
    const dnsChangedRuleIds = new Set<number>();
    const dnsPreviousIpByRuleId = new Map<number, string>();
    for (const rule of agentHostRules as any[]) {
      if (!rule.targetIp) continue;
      const resolved = await resolveTargetIp(rule.targetIp);
      const cachedIp = resolvedIpCache.get(rule.id);
      if (cachedIp && cachedIp !== resolved) {
        // IP 变更：标记为需要重新下发
        dnsChangedRuleIds.add(rule.id);
        dnsPreviousIpByRuleId.set(rule.id, cachedIp);
      }
      resolvedIpCache.set(rule.id, resolved);
      // 保存原始值（域名），将 rule.targetIp 替换为解析后的 IP
      (rule as any)._originalTargetIp = rule.targetIp;
      rule.targetIp = resolved;
    }

    // DNS 变更的规则：生成清理旧 IP 规则的动作
    const buildDnsChangeCleanup = (rule: any, oldIp: string): string[] => {
      const port = rule.sourcePort;
      const proto = rule.protocol === "both" ? "tcp" : (rule.protocol || "tcp");
      const cmds: string[] = [];
      if (rule.forwardType === "iptables") {
        cmds.push(`iptables -t nat -D PREROUTING -p ${proto} --dport ${port} -j DNAT --to-destination ${oldIp}:${rule.targetPort} 2>/dev/null || true`);
        cmds.push(`iptables -t nat -D POSTROUTING -p ${proto} -d ${oldIp} --dport ${rule.targetPort} -j MASQUERADE 2>/dev/null || true`);
        if (rule.protocol === "both") {
          cmds.push(`iptables -t nat -D PREROUTING -p udp --dport ${port} -j DNAT --to-destination ${oldIp}:${rule.targetPort} 2>/dev/null || true`);
          cmds.push(`iptables -t nat -D POSTROUTING -p udp -d ${oldIp} --dport ${rule.targetPort} -j MASQUERADE 2>/dev/null || true`);
        }
        cmds.push(`iptables -D FORWARD -p ${proto} -d ${oldIp} --dport ${rule.targetPort} -j ACCEPT 2>/dev/null || true`);
        cmds.push(`iptables -D FORWARD -p ${proto} -s ${oldIp} --sport ${rule.targetPort} -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true`);
        // 清理旧 IP 对应的 mangle FORWARD 计数规则
        cmds.push(`iptables -t mangle -D FORWARD -p tcp -d ${oldIp} --dport ${rule.targetPort} -j FWX_IN_${port} 2>/dev/null || true`);
        cmds.push(`iptables -t mangle -D FORWARD -p udp -d ${oldIp} --dport ${rule.targetPort} -j FWX_IN_${port} 2>/dev/null || true`);
        cmds.push(`iptables -t mangle -D FORWARD -p tcp -s ${oldIp} --sport ${rule.targetPort} -j FWX_OUT_${port} 2>/dev/null || true`);
        cmds.push(`iptables -t mangle -D FORWARD -p udp -s ${oldIp} --sport ${rule.targetPort} -j FWX_OUT_${port} 2>/dev/null || true`);
      } else if (rule.forwardType === "nftables") {
        cmds.push(`nft list table inet forwardx >/dev/null 2>&1 || exit 0; for h in $(nft -a list chain inet forwardx prerouting 2>/dev/null | awk '/fwx-rule-${rule.id}/ {print $NF}'); do nft delete rule inet forwardx prerouting handle "$h" 2>/dev/null || true; done`);
        cmds.push(`nft list table inet forwardx >/dev/null 2>&1 || exit 0; for h in $(nft -a list chain inet forwardx postrouting 2>/dev/null | awk '/fwx-rule-${rule.id}/ {print $NF}'); do nft delete rule inet forwardx postrouting handle "$h" 2>/dev/null || true; done`);
        cmds.push(`nft list table inet forwardx >/dev/null 2>&1 || exit 0; for h in $(nft -a list chain inet forwardx forward 2>/dev/null | awk '/fwx-rule-${rule.id}/ {print $NF}'); do nft delete rule inet forwardx forward handle "$h" 2>/dev/null || true; done`);
      }
      // 刷新计数链（apply 时会重建）
      cmds.push(`iptables -t mangle -F FWX_IN_${port} 2>/dev/null || true`);
      cmds.push(`iptables -t mangle -F FWX_OUT_${port} 2>/dev/null || true`);
      return cmds;
    };
    const failoverProxyHandlesTargetDns = (rule: any) => (
      !!rule?.failoverEnabled
      && rule.forwardType === "gost"
      && rule.protocol === "tcp"
      && parseFailoverTargets(rule.failoverTargets).length > 0
    );

    // 对 DNS 变更且正在运行的规则，先生成清理动作，再通过 isRunning=false 触发重新下发
    for (const rule of agentHostRules as any[]) {
      if (!dnsChangedRuleIds.has(rule.id)) continue;
      if (!rule.isEnabled || !rule.isRunning) continue;
      if (failoverProxyHandlesTargetDns(rule)) {
        console.log(`[DNS] rule=${rule.id} target changed; failover proxy will resolve ${rule._originalTargetIp || rule.targetIp} without service reload`);
        continue;
      }
      const oldIp = dnsPreviousIpByRuleId.get(rule.id) || rule._originalTargetIp || rule.targetIp;
      const ruleResolvedIp = rule.targetIp; // 已经是新解析的 IP
      const cleanupCmds = buildDnsChangeCleanup(rule, oldIp);
      if (cleanupCmds.length > 0) {
        actions.push({
          ruleId: rule.id,
          op: "remove",
          forwardType: rule.forwardType,
          sourcePort: rule.sourcePort,
          targetIp: ruleResolvedIp,
          targetPort: rule.targetPort,
          protocol: rule.protocol,
          networkInterface: hostInterface,
          commands: cleanupCmds,
        } as any);
      }
      // 重置 isRunning 让主循环生成 apply 动作
      rule.isRunning = false;
      console.log(`[DNS] rule=${rule.id} target changed: ${oldIp} → ${ruleResolvedIp}, re-applying`);
    }

    const agentAllRules = await db.getForwardRulesForAgent(undefined);
    const tunnelById = new Map((hostTunnels as any[]).map((t: any) => [t.id, t]));
    const tunnelHopsByTunnelId = new Map<number, any[]>();
    await Promise.all((hostTunnels as any[]).map(async (tunnel: any) => {
      const hops = await hopRepo.getTunnelHops(Number(tunnel.id));
      if (Array.isArray(hops) && hops.length >= 2) {
        tunnelHopsByTunnelId.set(Number(tunnel.id), hops);
      }
    }));

    // realm/socat/gost 进程命令使用原始 targetIp（域名形式），以便工具自身解析 DNS，
    // iptables/nftables/计数链使用已解析的 IP（rule.targetIp 已被替换为解析后的值）。
    const processTarget = (rule: any) => (rule as any)._originalTargetIp || rule.targetIp;

    const gostRules = agentHostRules
      .filter((r: any) => {
        if (r.pendingDelete || !r.isEnabled || r.forwardType !== "gost") return false;
        const tunnel = (r as any).tunnelId ? tunnelById.get((r as any).tunnelId) as any : null;
        return isRuleProtocolEnabled(forwardProtocolSettings, r, tunnel);
      });
    const gostRuleUserIds = Array.from(new Set(agentHostRules.map((r: any) => Number(r.userId)).filter((id: number) => Number.isFinite(id) && id > 0))) as number[];
    const gostUsers = await Promise.all(gostRuleUserIds.map((id) => db.getUserById(id)));
    const gostUserById = new Map(gostUsers.filter(Boolean).map((u: any) => [u.id, u]));
    const gostRateLimiters = gostUsers
      .filter((u: any) => u && (Number(u.gostRateLimitIn) > 0 || Number(u.gostRateLimitOut) > 0))
      .map((u: any) => ({
        name: `fwx-user-${u.id}`,
        limits: [`$ ${Math.max(0, Number(u.gostRateLimitIn) || 0)}B ${Math.max(0, Number(u.gostRateLimitOut) || 0)}B`],
      }));
    const applyGostLimiter = (service: any, userId: number) => {
      const user = gostUserById.get(userId) as any;
      if (user && (Number(user.gostRateLimitIn) > 0 || Number(user.gostRateLimitOut) > 0)) {
        service.limiter = `fwx-user-${user.id}`;
      }
      return service;
    };
    const userRateLimits = (userId: number) => {
      const user = gostUserById.get(userId) as any;
      return {
        limitIn: Math.max(0, Number(user?.gostRateLimitIn) || 0),
        limitOut: Math.max(0, Number(user?.gostRateLimitOut) || 0),
      };
    };
    const userAccessLimits = (userId: number) => {
      const user = gostUserById.get(userId) as any;
      return {
        maxConnections: Math.max(0, Number(user?.maxConnections) || 0),
        maxIPs: Math.max(0, Number(user?.maxIPs) || 0),
      };
    };
    const accessScopeName = (scope: string) => `FWX_LIMIT_${scope.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40)}`;
    const buildAccessLimitCleanupCmds = (port: number, scope: string): string[] => {
      const chain = accessScopeName(scope);
      return [
        `iptables -D INPUT -p tcp --dport ${port} -j ${chain} 2>/dev/null || true`,
        `iptables -D FORWARD -p tcp --dport ${port} -j ${chain} 2>/dev/null || true`,
      ];
    };
    const buildAccessLimitCmds = (port: number, scope: string, limits: { maxConnections?: number; maxIPs?: number }): string[] => {
      const maxConnections = Math.max(0, Number(limits.maxConnections || 0));
      const maxIPs = Math.max(0, Number(limits.maxIPs || 0));
      if (maxConnections <= 0 && maxIPs <= 0) return buildAccessLimitCleanupCmds(port, scope);
      const chain = accessScopeName(scope);
      const cmds = [
        `iptables -N ${chain} 2>/dev/null || true`,
        `iptables -F ${chain} 2>/dev/null || true`,
      ];
      if (maxConnections > 0) {
        cmds.push(`iptables -A ${chain} -p tcp -m connlimit --connlimit-above ${maxConnections} --connlimit-mask 0 -j REJECT --reject-with tcp-reset`);
      }
      if (maxIPs > 0) {
        cmds.push(`iptables -A ${chain} -p tcp -m connlimit --connlimit-above ${maxIPs} --connlimit-mask 32 -j REJECT --reject-with tcp-reset`);
      }
      cmds.push(`iptables -A ${chain} -j RETURN`);
      cmds.push(`iptables -C INPUT -p tcp --dport ${port} -j ${chain} 2>/dev/null || iptables -I INPUT -p tcp --dport ${port} -j ${chain}`);
      cmds.push(`iptables -C FORWARD -p tcp --dport ${port} -j ${chain} 2>/dev/null || iptables -I FORWARD -p tcp --dport ${port} -j ${chain}`);
      return cmds;
    };
    const accessScopeForRule = (rule: any) => (
      rule.tunnelId
        ? `u${Number(rule.userId) || 0}_t${Number(rule.tunnelId) || 0}`
        : `u${Number(rule.userId) || 0}_h${host.id}`
    );
    const buildRuleAccessLimitCmds = (rule: any): string[] => (
      rule.tunnelId
        ? buildAccessLimitCmds(rule.sourcePort, accessScopeForRule(rule), userAccessLimits(Number(rule.userId)))
        : buildAccessLimitCleanupCmds(rule.sourcePort, accessScopeForRule(rule))
    );
    const failoverProxyPort = (rule: any) => 41000 + (Number(rule?.id) % 20000);
    const actionFailover = (rule: any, options?: { listenPort?: number; bindAddress?: string }) => {
      if (!rule || !rule.failoverEnabled) return undefined;
      if (rule.forwardType !== "gost") return undefined;
      if (!rule.tunnelId) {
        const owner = gostUserById.get(Number(rule.userId)) as any;
        if (owner?.role !== "admin") return undefined;
      }
      if (rule.protocol !== "tcp") return undefined;
      const backupTargets = parseFailoverTargets(rule.failoverTargets);
      if (backupTargets.length === 0) return undefined;
      return {
        enabled: true,
        listenPort: Number(options?.listenPort || rule.sourcePort || 0),
        bindAddress: options?.bindAddress || "127.0.0.1",
        protocol: rule.protocol || "tcp",
        strategy: ["round_robin", "random", "ip_hash", "fallback"].includes(String(rule.failoverStrategy || ""))
          ? String(rule.failoverStrategy)
          : "fallback",
        targets: [
          { targetIp: processTarget(rule), targetPort: Number(rule.targetPort) },
          ...backupTargets,
        ],
        failoverSeconds: Number(rule.failoverSeconds || 60),
        recoverSeconds: Number(rule.recoverSeconds || 120),
        autoFailback: rule.autoFailback !== false,
      };
    };
    const failoverTargetAddr = (rule: any) => {
      const failover = actionFailover(rule, { listenPort: failoverProxyPort(rule), bindAddress: "127.0.0.1" });
      return failover ? `127.0.0.1:${failover.listenPort}` : `${processTarget(rule)}:${rule.targetPort}`;
    };
    const failoverTargetEndpoint = (rule: any) => {
      const failover = actionFailover(rule, { listenPort: failoverProxyPort(rule), bindAddress: "127.0.0.1" });
      return failover
        ? { targetIp: "127.0.0.1", targetPort: Number(failover.listenPort) }
        : { targetIp: processTarget(rule), targetPort: Number(rule.targetPort) };
    };
    const failoverForCurrentHost = (rule: any, tunnel?: any | null, options?: { listenPort?: number }) => {
      if (!rule?.failoverEnabled) return undefined;
      const listenPort = Number(options?.listenPort || failoverProxyPort(rule));
      if (!tunnel) return actionFailover(rule, { listenPort, bindAddress: "127.0.0.1" });
      if (isForwardXTunnel(tunnel) && Number(tunnel.entryHostId) === Number(host.id)) {
        return actionFailover(rule, { listenPort, bindAddress: "127.0.0.1" });
      }
      if (!isForwardXTunnel(tunnel) && Number(tunnel.exitHostId) === Number(host.id)) {
        return actionFailover(rule, { listenPort, bindAddress: "127.0.0.1" });
      }
      return undefined;
    };
    const tunnelProtocolType = (mode: string) => {
      if (mode === "wss" || mode === "mwss") return "ws";
      if (mode === "tcp" || mode === "mtcp") return "tcp";
      return "tls";
    };
    const tunnelProtocolMetadata = (mode: string) => (
      mode === "mtls" || mode === "mwss" || mode === "mtcp"
        ? { mux: "true" }
        : undefined
    );
    const isForwardXTunnel = (tunnel: any) => String(tunnel?.mode || "").toLowerCase() === "forwardx";
    const tunnelForwardProtos = (protocol: string) => protocol === "udp" ? ["udp"] : (protocol === "both" ? ["tcp", "udp"] : ["tcp"]);
    const hostTunnelAddress = (hostLike: any) =>
      String(hostLike?.tunnelEntryIp || hostLike?.entryIp || hostLike?.ipv4 || hostLike?.ipv6 || hostLike?.ip || "").trim();
    const tunnelExitHostAddress = async (tunnel: any) => {
      const connectHost = String(tunnel?.connectHost || "").trim();
      if (connectHost) return connectHost;
      const exit = await db.getHostById(tunnel.exitHostId);
      if (!exit) return "";
      return hostTunnelAddress(exit);
    };
    const tunnelExitEndpointById = new Map<number, { host: string; port: number }>();
    const hostIngressAddressById = new Map<number, string>();
    const getHostIngressAddress = async (hostId: number) => {
      const id = Number(hostId);
      if (!Number.isFinite(id) || id <= 0) return "";
      const cached = hostIngressAddressById.get(id);
      if (cached !== undefined) return cached;
      const hopHost = await db.getHostById(id) as any;
      const addr = hopHost ? hostTunnelAddress(hopHost) : "";
      hostIngressAddressById.set(id, addr);
      return addr;
    };
    const getHopDialAddress = async (hop: any) => {
      const configured = String((hop as any)?.connectHost || "").trim();
      if (configured) return configured;
      return getHostIngressAddress(Number((hop as any)?.hostId));
    };
    for (const tunnel of hostTunnels as any[]) {
      if (tunnel.entryHostId === host.id && tunnel.isEnabled && isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)) {
        const hops = tunnelHopsByTunnelId.get(Number(tunnel.id));
        const nextHop = Array.isArray(hops) && hops.length >= 2 ? (hops[1] as any) : null;
        tunnelExitEndpointById.set(tunnel.id, {
          host: nextHop ? await getHopDialAddress(nextHop) : await tunnelExitHostAddress(tunnel),
          port: nextHop ? Number(nextHop.listenPort) : Number(tunnel.listenPort),
        });
      }
    }
    const tunnelProbes = (await Promise.all((hostTunnels as any[])
      .filter((tunnel: any) => tunnel.isEnabled && isTunnelProtocolEnabled(forwardProtocolSettings, tunnel))
      .map(async (tunnel: any) => {
        const hops = tunnelHopsByTunnelId.get(Number(tunnel.id));
        if (Array.isArray(hops) && hops.length >= 3) {
          const hostIdx = hops.findIndex((hop: any) => Number(hop.hostId) === Number(host.id));
          if (hostIdx < 0 || hostIdx >= hops.length - 1) return null;
          const nextHop = hops[hostIdx + 1] as any;
          const targetIp = await getHopDialAddress(nextHop);
          const targetPort = Number(nextHop.listenPort) || 0;
          return targetIp && targetPort > 0 ? {
            tunnelId: tunnel.id,
            targetIp,
            targetPort,
            protocol: "tcp",
            hopIndex: hostIdx,
            hopCount: hops.length - 1,
          } : null;
        }
        if (tunnel.entryHostId !== host.id) return null;
        return {
          tunnelId: tunnel.id,
          targetIp: tunnelExitEndpointById.get(tunnel.id)?.host || "",
          targetPort: Number(tunnelExitEndpointById.get(tunnel.id)?.port) || 0,
          protocol: "tcp",
        };
      }))).filter((probe: any) => probe && probe.targetIp && probe.targetPort > 0);
    const tunnelProtocolPolicy = (tunnel: any) => ({
      blockHttp: !!(tunnel as any)?.blockHttp,
      blockSocks: !!(tunnel as any)?.blockSocks,
      blockTls: !!(tunnel as any)?.blockTls,
    });
    const hasProtocolPolicy = (tunnel: any) => {
      const policy = tunnelProtocolPolicy(tunnel);
      return policy.blockHttp || policy.blockSocks || policy.blockTls;
    };
    const guardListenPort = (rule: any) => 39000 + (Number(rule.id) % 20000);
    const tunnelExitRules = agentAllRules
      .filter((r: any) => {
        if (r.pendingDelete || !r.isEnabled || r.forwardType !== "gost" || !r.tunnelId) return false;
        const tunnel = tunnelById.get(r.tunnelId) as any;
        return !!tunnel
          && tunnel.isEnabled
          && isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)
          && isRuleProtocolEnabled(forwardProtocolSettings, r, tunnel)
          && tunnel.exitHostId === host.id;
      });

    const gostTunnelNode = (name: string, addr: string, dialerType: string, tunnel: any) => ({
      name,
      addr,
      connector: { type: "relay", metadata: { nodelay: true } },
      dialer: {
        type: dialerType,
        ...(dialerType !== "tcp" && tunnelProtocolMetadata(tunnel.mode) ? { metadata: tunnelProtocolMetadata(tunnel.mode) } : {}),
      },
    });
    const gostRelayHandler = () => ({ type: "relay", metadata: { nodelay: true } });
    const gostServiceConfig = (await Promise.all(gostRules
      .map(async (r: any) => {
        const tunnel = (r as any).tunnelId ? tunnelById.get((r as any).tunnelId) as any : null;
        if (tunnel && isForwardXTunnel(tunnel)) return [];
        const protos = tunnel ? tunnelForwardProtos(r.protocol) : (r.protocol === "both" ? ["tcp", "udp"] : [r.protocol === "udp" ? "udp" : "tcp"]);
        return Promise.all(protos.map(async (proto) => {
          const tunnelHops = tunnel ? tunnelHopsByTunnelId.get(Number(tunnel.id)) : null;
          const firstHop = Array.isArray(tunnelHops) && tunnelHops.length >= 2 ? (tunnelHops[0] as any) : null;
          const isMultiHopTunnel = Array.isArray(tunnelHops) && tunnelHops.length >= 3;
          const useMultiHopEntry =
            isMultiHopTunnel
            && !!firstHop
            && Number(firstHop.hostId) === Number(host.id);
          const tunnelExitHost = tunnel ? tunnelExitEndpointById.get(tunnel.id)?.host : "";
          const service: any = {
            name: `fwx-${r.id}-${proto}`,
            addr: `:${r.sourcePort}`,
            handler: tunnel ? { type: proto, chain: `chain-tunnel-${r.id}` } : { type: proto },
            listener: { type: proto },
          };
          if (!tunnel) {
            service.forwarder = {
              nodes: [{
                name: `target-${r.id}`,
                addr: failoverTargetAddr(r),
                connector: { type: proto },
                dialer: { type: proto },
              }],
            };
          } else if (useMultiHopEntry) {
            service.forwarder = {
              nodes: [{
                name: `target-${r.id}`,
                addr: failoverTargetAddr(r),
                connector: { type: proto },
                dialer: { type: proto },
              }],
            };
          } else if (!tunnelExitHost || !(r as any).tunnelExitPort) {
            return null;
          }
          return applyGostLimiter(service, Number(r.userId));
        }));
      })))
      .flat()
      .filter(Boolean);
    const tunnelGostChains = (await Promise.all(gostRules
      .filter((r: any) => r.isEnabled && r.forwardType === "gost" && r.tunnelId)
      .map(async (r: any) => {
        const tunnel = tunnelById.get((r as any).tunnelId) as any;
        if (isForwardXTunnel(tunnel)) return null;
        const tunnelExitHost = tunnel ? tunnelExitEndpointById.get(tunnel.id)?.host : "";
        if (!tunnel || !tunnelExitHost || !(r as any).tunnelExitPort) return null;
        const tunnelHops = tunnelHopsByTunnelId.get(Number(tunnel.id));
        const firstHop = Array.isArray(tunnelHops) && tunnelHops.length >= 2 ? (tunnelHops[0] as any) : null;
        const isMultiHopTunnel = Array.isArray(tunnelHops) && tunnelHops.length >= 3;
        const useMultiHopEntry =
          isMultiHopTunnel
          && !!firstHop
          && Number(firstHop.hostId) === Number(host.id);
        // Multi-hop rules on the entry host must build an explicit B->...->exit chain.
        // Dialing the local first-hop listener only proves the generic probe path and bypasses
        // the rule-specific tunnelExitPort.
        if (isMultiHopTunnel && !useMultiHopEntry) {
          console.warn(`[TunnelRoute] skip direct fallback for multi-hop tunnel=${tunnel.id} rule=${r.id}; entry host mismatch host=${host.id} firstHop=${Number(firstHop?.hostId) || 0}`);
          return null;
        }
        if (isMultiHopTunnel && useMultiHopEntry) {
          const chainHops: any[] = [];
          const routeParts: string[] = [`entry#${Number(firstHop.hostId)}:${Number((r as any).sourcePort)}`];
          for (let i = 1; i < tunnelHops.length - 1; i++) {
            const hop = tunnelHops[i] as any;
            const hopDialHost = await getHopDialAddress(hop);
            const hopAddr = `${hopDialHost}:${Number(hop.listenPort)}`;
            if (!hopAddr || hopAddr.startsWith(":") || !Number(hop.listenPort)) return null;
            routeParts.push(`hop#${Number(hop.hostId)}@${hopAddr}`);
            chainHops.push({
              name: `hop-tunnel-${r.id}-${Number(hop.seq)}`,
              nodes: [gostTunnelNode(
                `mhop-${r.id}-${Number(hop.seq)}`,
                hopAddr,
                tunnelProtocolType(tunnel.mode),
                tunnel,
              )],
            });
          }
          const exitHop = tunnelHops[tunnelHops.length - 1] as any;
          const exitHost = await getHopDialAddress(exitHop);
          const exitAddr = `${exitHost}:${Number((r as any).tunnelExitPort)}`;
          if (!exitHost || !Number((r as any).tunnelExitPort)) return null;
          chainHops.push({
            name: `hop-tunnel-${r.id}-exit`,
            nodes: [gostTunnelNode(
              `exit-${r.id}`,
              exitAddr,
              tunnelProtocolType(tunnel.mode),
              tunnel,
            )],
          });
          if (chainHops.length === 0) return null;
          routeParts.push(`exit#${Number(exitHop.hostId)}@${exitAddr}`);
          const route = routeParts.join(" -> ");
          const routeKey = `${tunnel.id}:${r.id}:${host.id}`;
          tunnelRouteLogCache.set(routeKey, route);
          appendPanelLog("info", `[TunnelRoute] gost multi-hop tunnel=${tunnel.id} rule=${r.id} host=${host.id} route=${route}`);
          return { name: `chain-tunnel-${r.id}`, hops: chainHops };
        }
        const chainTargetAddr = useMultiHopEntry
          ? `127.0.0.1:${Number(firstHop.listenPort)}`
          : `${tunnelExitHost}:${(r as any).tunnelExitPort}`;
        const chainNodeName = useMultiHopEntry ? `mhop-entry-${r.id}` : `exit-${r.id}`;
        return {
          name: `chain-tunnel-${r.id}`,
          hops: [{
            name: `hop-tunnel-${r.id}`,
            nodes: [gostTunnelNode(
              chainNodeName,
              chainTargetAddr,
              useMultiHopEntry ? "tcp" : tunnelProtocolType(tunnel.mode),
              tunnel,
            )],
          }],
        };
      }))).filter(Boolean);
    const gostChains = [...tunnelGostChains];
    const buildGostReloadCmds = () => {
      const encodedConfig = Buffer.from(JSON.stringify({ services: gostServiceConfig, chains: gostChains, limiters: gostRateLimiters }, null, 2), "utf8").toString("base64");
      const cmds = [
        `mkdir -p /etc/forwardx-gost`,
        `printf '%s' '${encodedConfig}' | base64 -d > /etc/forwardx-gost/config.json`,
        `echo "[gost-config] forwardx-gost services=${gostServiceConfig.length} chains=${gostChains.length}"`,
        writeUnitCmd(gostServiceName, gostServiceUnit),
        `systemctl daemon-reload`,
      ];
      if (gostServiceConfig.length > 0) {
        cmds.unshift(`command -v /usr/local/bin/gost >/dev/null 2>&1 || command -v gost >/dev/null 2>&1`);
        cmds.push(
          `systemctl enable ${gostServiceName}.service 2>/dev/null || true`,
          `systemctl restart ${gostServiceName}.service || { systemctl status ${gostServiceName}.service --no-pager -l; journalctl -u ${gostServiceName}.service -n 80 --no-pager; exit 1; }`,
        );
      } else {
        cmds.push(`systemctl disable ${gostServiceName}.service 2>/dev/null || true`);
        cmds.push(`systemctl stop ${gostServiceName}.service 2>/dev/null || true`);
      }
      return cmds;
    };
    const buildTunnelReloadCmds = async () => {
      const tunnelProbeServices = hostTunnels
        .filter((tunnel: any) => tunnel.exitHostId === host.id && tunnel.isEnabled && !isForwardXTunnel(tunnel) && isTunnelProtocolEnabled(forwardProtocolSettings, tunnel))
        .map((tunnel: any) => ({
          name: `fwx-tunnel-probe-${tunnel.id}`,
          addr: `:${tunnel.listenPort}`,
          handler: { type: "tcp" },
          listener: {
            type: tunnelProtocolType(tunnel.mode),
            ...(tunnelProtocolMetadata(tunnel.mode) ? { metadata: tunnelProtocolMetadata(tunnel.mode) } : {}),
          },
          forwarder: {
            nodes: [{
              name: `probe-${tunnel.id}`,
              addr: "127.0.0.1:9",
              connector: { type: "tcp" },
              dialer: { type: "tcp" },
            }],
          },
        }));
      const ruleServices = tunnelExitRules.flatMap((rule: any) => {
        const tunnel = tunnelById.get(rule.tunnelId) as any;
        if (!tunnel || isForwardXTunnel(tunnel) || !rule.tunnelExitPort) return [];
        const targetAddr = hasProtocolPolicy(tunnel) ? `127.0.0.1:${guardListenPort(rule)}` : failoverTargetAddr(rule);
        return [{
          name: `fwx-tunnel-exit-${tunnel.id}-${rule.id}`,
          addr: `:${rule.tunnelExitPort}`,
          handler: gostRelayHandler(),
          listener: {
            type: tunnelProtocolType(tunnel.mode),
            ...(tunnelProtocolMetadata(tunnel.mode) ? { metadata: tunnelProtocolMetadata(tunnel.mode) } : {}),
          },
          forwarder: {
            nodes: [{
              name: `target-${rule.id}`,
              addr: targetAddr,
              connector: { type: "tcp" },
              dialer: { type: "tcp" },
            }],
          },
        }];
      });
      const multiHopRelayServices = await Promise.all((hostTunnels as any[]).map(async (tunnel: any) => {
        if (!tunnel || !tunnel.isEnabled || isForwardXTunnel(tunnel) || !isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)) return null;
        const hops = tunnelHopsByTunnelId.get(Number(tunnel.id));
        if (!hops || hops.length < 2) return null;
        const hostIdx = hops.findIndex((hop: any) => Number(hop.hostId) === Number(host.id));
        if (hostIdx < 0 || hostIdx >= hops.length - 1) return null; // not in chain or exit hop
        const currentHop = hops[hostIdx] as any;
        return {
          name: `fwx-mhop-${tunnel.id}-${Number(currentHop.seq)}`,
          addr: `:${Number(currentHop.listenPort)}`,
          handler: gostRelayHandler(),
          listener: {
            // Entry hop receives local plain TCP traffic; relays receive tunneled traffic.
            type: Number(currentHop.seq) === 0 ? "tcp" : tunnelProtocolType(tunnel.mode),
            ...(Number(currentHop.seq) === 0 ? {} : (tunnelProtocolMetadata(tunnel.mode) ? { metadata: tunnelProtocolMetadata(tunnel.mode) } : {})),
          },
        };
      }));
      const services = [...tunnelProbeServices, ...ruleServices, ...multiHopRelayServices.filter(Boolean)];
      const countingCmds = tunnelExitRules.flatMap((rule: any) => {
        const tunnel = tunnelById.get(rule.tunnelId) as any;
        if (!tunnel || isForwardXTunnel(tunnel) || !rule.tunnelExitPort) return [];
        return buildCountingChainCmds(Number(rule.tunnelExitPort), rule.targetIp, rule.targetPort, rule.protocol);
      });
      const encodedConfig = Buffer.from(JSON.stringify({ services }, null, 2), "utf8").toString("base64");
      const cmds = [
        `mkdir -p /etc/forwardx-tunnels`,
        `printf '%s' '${encodedConfig}' | base64 -d > /etc/forwardx-tunnels/config.json`,
        `echo "[gost-config] forwardx-tunnels services=${services.length}"`,
        writeUnitCmd("forwardx-tunnels", [
          "[Unit]",
          "Description=ForwardX managed gost tunnels",
          "After=network.target",
          "",
          "[Service]",
          "Type=simple",
          "ExecStart=/usr/local/bin/gost -C /etc/forwardx-tunnels/config.json",
          "Restart=always",
          "RestartSec=5",
          "LimitNOFILE=65535",
          "",
          "[Install]",
          "WantedBy=multi-user.target",
          "",
        ].join("\n")),
        `systemctl daemon-reload`,
      ];
      if (services.length > 0) {
        cmds.unshift(`command -v /usr/local/bin/gost >/dev/null 2>&1 || command -v gost >/dev/null 2>&1`);
        cmds.push(
          `systemctl enable forwardx-tunnels.service 2>/dev/null || true`,
          `systemctl restart forwardx-tunnels.service || { systemctl status forwardx-tunnels.service --no-pager -l; journalctl -u forwardx-tunnels.service -n 80 --no-pager; exit 1; }`,
        );
      } else {
        cmds.push(`systemctl disable forwardx-tunnels.service 2>/dev/null || true`);
        cmds.push(`systemctl stop forwardx-tunnels.service 2>/dev/null || true`);
      }
      cmds.push(...countingCmds);
      return cmds;
    };

    // 收集所有正在运行的规则的 port→ruleId 映射，用于 agent 重建映射文件
    const ruleTrafficPort = (rule: any) => {
      const tunnel = rule.tunnelId ? tunnelById.get(rule.tunnelId) as any : null;
      if (tunnel && !isForwardXTunnel(tunnel) && tunnel.exitHostId === host.id && rule.tunnelExitPort) {
        return Number(rule.tunnelExitPort);
      }
      if (tunnel && !isForwardXTunnel(tunnel)) return 0;
      return Number(rule.sourcePort) || 0;
    };
    const runningRules: { ruleId: number; sourcePort: number; targetIp: string; targetPort: number; protocol: string; forwardType: string; failover?: any }[] = [];
    const guardRules: any[] = [];
    const addRunningRule = (rule: { ruleId: number; sourcePort: number; targetIp: string; targetPort: number; protocol: string; forwardType: string; failover?: any }) => {
      if (!rule.ruleId || !rule.sourcePort) return;
      const exists = runningRules.some((item) =>
        Number(item.ruleId) === Number(rule.ruleId) && Number(item.sourcePort) === Number(rule.sourcePort)
      );
      if (!exists) runningRules.push(rule);
    };

    const buildDisabledRuleRemovalAction = (rule: any) => {
      const tunnel = (rule as any).tunnelId ? tunnelById.get((rule as any).tunnelId) as any : null;
      if (rule.forwardType === "iptables") {
        const proto = rule.protocol === "both" ? "tcp" : rule.protocol;
        const cmds: string[] = [];
        cmds.push(`iptables -t nat -D PREROUTING -p ${proto} --dport ${rule.sourcePort} -j DNAT --to-destination ${rule.targetIp}:${rule.targetPort} 2>/dev/null || true`);
        cmds.push(`iptables -t nat -D POSTROUTING -p ${proto} -d ${rule.targetIp} --dport ${rule.targetPort} -j MASQUERADE 2>/dev/null || true`);
        if (rule.protocol === "both") {
          cmds.push(`iptables -t nat -D PREROUTING -p udp --dport ${rule.sourcePort} -j DNAT --to-destination ${rule.targetIp}:${rule.targetPort} 2>/dev/null || true`);
          cmds.push(`iptables -t nat -D POSTROUTING -p udp -d ${rule.targetIp} --dport ${rule.targetPort} -j MASQUERADE 2>/dev/null || true`);
        }
        cmds.push(`iptables -D FORWARD -p ${proto} -d ${rule.targetIp} --dport ${rule.targetPort} -j ACCEPT 2>/dev/null || true`);
        cmds.push(`iptables -D FORWARD -p ${proto} -s ${rule.targetIp} --sport ${rule.targetPort} -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true`);
        cmds.push(`rm -f /var/lib/forwardx-agent/traffic_${rule.sourcePort}.prev 2>/dev/null || true`);
        cmds.push(`rm -f /var/lib/forwardx-agent/port_${rule.sourcePort}.rule 2>/dev/null || true`);
        cmds.push(...buildCountingCleanupCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol));
        cmds.push(...buildAccessLimitCleanupCmds(rule.sourcePort, accessScopeForRule(rule)));
        return {
          ruleId: rule.id,
          op: "remove",
          forwardType: rule.forwardType,
          sourcePort: rule.sourcePort,
          targetIp: rule.targetIp,
          targetPort: rule.targetPort,
          protocol: rule.protocol,
          commands: cmds,
        };
      }
      if (rule.forwardType === "nftables") {
        const cmds = buildNftCleanupCmds(rule);
        cmds.push(...buildAccessLimitCleanupCmds(rule.sourcePort, accessScopeForRule(rule)));
        return {
          ruleId: rule.id,
          op: "remove",
          forwardType: rule.forwardType,
          sourcePort: rule.sourcePort,
          targetIp: rule.targetIp,
          targetPort: rule.targetPort,
          protocol: rule.protocol,
          commands: cmds,
        };
      }
      if (rule.forwardType === "realm") {
        const svcName = `forwardx-realm-${rule.sourcePort}`;
        return {
          ruleId: rule.id,
          op: "remove",
          forwardType: rule.forwardType,
          sourcePort: rule.sourcePort,
          targetIp: rule.targetIp,
          targetPort: rule.targetPort,
          protocol: rule.protocol,
          svcName,
          commands: [
            `systemctl stop ${svcName}.service 2>/dev/null || true`,
            `systemctl disable ${svcName}.service 2>/dev/null || true`,
            `rm -f /etc/systemd/system/${svcName}.service`,
            `systemctl daemon-reload`,
            killByPatternCmd(`[r]ealm .*:${rule.sourcePort}`),
            `rm -f /var/lib/forwardx-agent/traffic_${rule.sourcePort}.prev 2>/dev/null || true`,
            `rm -f /var/lib/forwardx-agent/port_${rule.sourcePort}.rule 2>/dev/null || true`,
            ...buildCountingCleanupCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
            ...buildAccessLimitCleanupCmds(rule.sourcePort, accessScopeForRule(rule)),
          ],
        };
      }
      if (rule.forwardType === "socat") {
        const removeCmds: string[] = [];
        if (rule.protocol === "both") {
          const svcTcp = `forwardx-socat-tcp-${rule.sourcePort}`;
          const svcUdp = `forwardx-socat-udp-${rule.sourcePort}`;
          removeCmds.push(`systemctl stop ${svcTcp}.service 2>/dev/null || true`);
          removeCmds.push(`systemctl disable ${svcTcp}.service 2>/dev/null || true`);
          removeCmds.push(`rm -f /etc/systemd/system/${svcTcp}.service`);
          removeCmds.push(`systemctl stop ${svcUdp}.service 2>/dev/null || true`);
          removeCmds.push(`systemctl disable ${svcUdp}.service 2>/dev/null || true`);
          removeCmds.push(`rm -f /etc/systemd/system/${svcUdp}.service`);
        } else {
          const svcName = `forwardx-socat-${rule.sourcePort}`;
          removeCmds.push(`systemctl stop ${svcName}.service 2>/dev/null || true`);
          removeCmds.push(`systemctl disable ${svcName}.service 2>/dev/null || true`);
          removeCmds.push(`rm -f /etc/systemd/system/${svcName}.service`);
        }
        removeCmds.push(`systemctl daemon-reload`);
        removeCmds.push(killByPatternCmd(`[s]ocat.*LISTEN:${rule.sourcePort}`));
        removeCmds.push(`rm -f /var/lib/forwardx-agent/traffic_${rule.sourcePort}.prev 2>/dev/null || true`);
        removeCmds.push(`rm -f /var/lib/forwardx-agent/port_${rule.sourcePort}.rule 2>/dev/null || true`);
        removeCmds.push(...buildCountingCleanupCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol));
        removeCmds.push(...buildAccessLimitCleanupCmds(rule.sourcePort, accessScopeForRule(rule)));
        return {
          ruleId: rule.id,
          op: "remove",
          forwardType: rule.forwardType,
          sourcePort: rule.sourcePort,
          targetIp: rule.targetIp,
          targetPort: rule.targetPort,
          protocol: rule.protocol,
          commands: removeCmds,
        };
      }
      if (rule.forwardType === "gost") {
        return {
          ruleId: rule.id,
          op: "remove",
          forwardType: rule.forwardType,
          sourcePort: rule.sourcePort,
          targetIp: rule.targetIp,
          targetPort: rule.targetPort,
          protocol: rule.protocol,
          commands: [
            ...buildGostReloadCmds(),
            ...buildManagedPortCleanupCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
          ],
          fxp: tunnel && isForwardXTunnel(tunnel) ? {
            role: "entry",
            tunnelId: tunnel.id,
            ruleId: rule.id,
            listenPort: rule.sourcePort,
            protocol: rule.protocol,
            key: tunnelSecretSeed(tunnel),
          } : undefined,
        };
      }
      return null;
    };

    const pendingTunnelExitRuleIds = new Set(
      tunnelExitRules
        .filter((rule: any) => !rule.isRunning)
        .map((rule: any) => Number(rule.tunnelId))
    );
    for (const tunnel of hostTunnels as any[]) {
      if (tunnel.exitHostId !== host.id) continue;
      const existingHops = tunnelHopsByTunnelId.get(Number(tunnel.id));
      if (Array.isArray(existingHops) && existingHops.length >= 3) continue;
      const fxpTunnel = isForwardXTunnel(tunnel);
      const shouldRefreshExit = fxpTunnel
        ? !tunnel.isRunning
        : (!tunnel.isRunning || pendingTunnelExitRuleIds.has(Number(tunnel.id)));
      const tunnelProtocolEnabled = isTunnelProtocolEnabled(forwardProtocolSettings, tunnel);
      if (tunnel.isEnabled && tunnelProtocolEnabled && shouldRefreshExit) {
        actions.push({
          tunnelId: tunnel.id,
          statusType: "tunnel",
          ruleId: 0,
          op: "apply",
          forwardType: fxpTunnel ? "forwardx-tunnel" : "gost-tunnel",
          sourcePort: tunnel.listenPort,
          targetIp: host.ip,
          targetPort: tunnel.listenPort,
          protocol: "tcp",
          commands: fxpTunnel ? [] : await buildTunnelReloadCmds(),
          fxp: fxpTunnel ? {
            role: "exit",
            tunnelId: tunnel.id,
            ruleId: 0,
            listenPort: tunnel.listenPort,
            protocol: "both",
            key: tunnelSecretSeed(tunnel),
          } : undefined,
        });
      } else if ((!tunnel.isEnabled || !tunnelProtocolEnabled) && tunnel.isRunning) {
        actions.push({
          tunnelId: tunnel.id,
          statusType: "tunnel",
          ruleId: 0,
          op: "remove",
          forwardType: fxpTunnel ? "forwardx-tunnel" : "gost-tunnel",
          sourcePort: tunnel.listenPort,
          targetIp: host.ip,
          targetPort: tunnel.listenPort,
          protocol: "tcp",
          commands: fxpTunnel ? [] : await buildTunnelReloadCmds(),
          fxp: fxpTunnel ? {
            role: "exit",
            tunnelId: tunnel.id,
            ruleId: 0,
            listenPort: tunnel.listenPort,
            protocol: "both",
            key: tunnelSecretSeed(tunnel),
          } : undefined,
        });
      }
    }

    // ============ Multi-hop tunnel actions ============
    const hopKey = (secret: string, idx: number) =>
      crypto.createHash("sha256").update(`${secret}|hop|${idx}`).digest("hex");

    // Find multi-hop tunnels involving this host
    if (hostTunnels && hostTunnels.length > 0) {
      for (const tunnel of hostTunnels as any[]) {
        const hops = await hopRepo.getTunnelHops(Number(tunnel.id));
        if (!hops || hops.length < 2) continue; // Not a multi-hop tunnel

        const hostIdx = hops.findIndex((h: any) => Number(h.hostId) === host.id);
        if (hostIdx < 0) continue; // This host is not a hop in this tunnel

        const isFXP = isForwardXTunnel(tunnel);
        const tunnelKey = tunnelSecretSeed(tunnel);
        const multiHopRuntimeReady = isTunnelRuntimeHostReady(Number(tunnel.id), Number(host.id));
        const shouldApply = tunnel.isEnabled && !multiHopRuntimeReady;
        const shouldRemove = isFXP ? !tunnel.isEnabled : !tunnel.isEnabled && (tunnel.isRunning || multiHopRuntimeReady);

        if (!shouldApply && !shouldRemove) continue;

        const op = shouldApply ? "apply" : "remove";
        const { seq, listenPort } = hops[hostIdx] as any;
        const isFirst = seq === 0;
        const isLast = seq === hops.length - 1;

        if (isFXP) {
          // ForwardX multi-hop
          if (isFirst) {
            actions.push({
              tunnelId: tunnel.id,
              statusType: "tunnel",
              ruleId: 0,
              op,
              forwardType: "forwardx-tunnel",
              sourcePort: Number(listenPort),
              targetIp: host.ip,
              targetPort: Number(listenPort),
              protocol: "tcp",
              commands: [],
            } as any);
            continue;
          }
          const fxpSpec: any = {
            role: isLast ? "exit" : "relay",
            tunnelId: tunnel.id,
            ruleId: 0,
            listenPort: Number(listenPort),
            protocol: "both",
            key: hopKey(tunnelKey, seq),
          };
          if (!isLast) {
            // Relay: receive from upstream, forward to downstream
            const nextHop = hops[seq + 1];
            const nextIp = await getHopDialAddress(nextHop);
            fxpSpec.relayExitHost = String(nextIp).trim();
            fxpSpec.relayExitPort = Number(nextHop.listenPort);
            fxpSpec.relayKey = hopKey(tunnelKey, seq + 1);
          }
          // Exit (isLast): just listens, target from helloFrame via rules

          actions.push({
            tunnelId: tunnel.id,
            statusType: "tunnel",
            ruleId: 0,
            op,
            forwardType: "forwardx-tunnel",
            sourcePort: Number(listenPort),
            targetIp: host.ip,
            targetPort: Number(listenPort),
            protocol: "tcp",
            commands: [],
            fxp: fxpSpec,
          } as any);
        } else {
          // GOST multi-hop: each hop creates a GOST relay entry
          // Entry listens and forwards to next hop; intermediate relays forward onward
          if (shouldApply) {
            // Use buildTunnelReloadCmds for GOST config updates
            actions.push({
              tunnelId: tunnel.id,
              statusType: "tunnel",
              ruleId: 0,
              op: "apply",
              forwardType: "gost-tunnel",
              sourcePort: Number(listenPort),
              targetIp: host.ip,
              targetPort: Number(listenPort),
              protocol: "tcp",
              commands: await buildTunnelReloadCmds(),
            } as any);
          } else {
            actions.push({
              tunnelId: tunnel.id,
              statusType: "tunnel",
              ruleId: 0,
              op: "remove",
              forwardType: "gost-tunnel",
              sourcePort: Number(listenPort),
              targetIp: host.ip,
              targetPort: Number(listenPort),
              protocol: "tcp",
              commands: await buildTunnelReloadCmds(),
            } as any);
          }
        }
      }
    }

    for (const rule of rules) {
      const ruleTunnel = (rule as any).tunnelId ? tunnelById.get((rule as any).tunnelId) as any : null;
      const ruleProtocolEnabled = isRuleProtocolEnabled(forwardProtocolSettings, rule, ruleTunnel);
      if (!ruleProtocolEnabled) {
        if (rule.isRunning) {
          const removeAction = buildDisabledRuleRemovalAction(rule);
          if (removeAction) actions.push(removeAction);
        }
        continue;
      }
      // 收集所有已运行的规则映射（无论是否有 action 下发）
      if (rule.isEnabled && rule.isRunning) {
        const trafficPort = ruleTrafficPort(rule);
        if (!trafficPort) continue;
        const runningForwardType = rule.forwardType === "gost" && ruleTunnel && isForwardXTunnel(ruleTunnel)
          ? "forwardx"
          : rule.forwardType;
        addRunningRule({
          ruleId: rule.id,
          sourcePort: trafficPort,
          targetIp: rule.targetIp,
          targetPort: rule.targetPort,
          protocol: rule.protocol,
          forwardType: runningForwardType,
          failover: failoverForCurrentHost(rule, ruleTunnel, { listenPort: failoverProxyPort(rule) }),
        });
      }

      const ruleTunnelHops = ruleTunnel ? tunnelHopsByTunnelId.get(Number(ruleTunnel.id)) : null;
      const isForwardXMultiHopRule = !!ruleTunnel
        && isForwardXTunnel(ruleTunnel)
        && Array.isArray(ruleTunnelHops)
        && ruleTunnelHops.length >= 3
        && ruleTunnelHops.some((hop: any) => Number(hop.hostId) === Number(host.id));
      const shouldRefreshForwardXMultiHopRule = isForwardXMultiHopRule
        && !isTunnelRuntimeHostReady(Number(ruleTunnel.id), Number(host.id));
      if (rule.isEnabled && (!rule.isRunning || shouldRefreshForwardXMultiHopRule)) {
        const cmds: string[] = [];
        if (rule.forwardType === "iptables") {
          const proto = rule.protocol === "both" ? "tcp" : rule.protocol;
          // 必须先启用内核转发，否则 DNAT 后数据包不会被路由到目标主机
          cmds.push(`sysctl -w net.ipv4.ip_forward=1 >/dev/null`);
          // 避免重复添加：先反向清理同 sourcePort 老规则
          cmds.push(`while iptables -t nat -C PREROUTING -p tcp --dport ${rule.sourcePort} -j DNAT --to-destination ${rule.targetIp}:${rule.targetPort} 2>/dev/null; do iptables -t nat -D PREROUTING -p tcp --dport ${rule.sourcePort} -j DNAT --to-destination ${rule.targetIp}:${rule.targetPort}; done`);
          cmds.push(`while iptables -t nat -C PREROUTING -p udp --dport ${rule.sourcePort} -j DNAT --to-destination ${rule.targetIp}:${rule.targetPort} 2>/dev/null; do iptables -t nat -D PREROUTING -p udp --dport ${rule.sourcePort} -j DNAT --to-destination ${rule.targetIp}:${rule.targetPort}; done`);

          cmds.push(ipIfMissingT("nat", `PREROUTING -p ${proto} --dport ${rule.sourcePort} -j DNAT --to-destination ${rule.targetIp}:${rule.targetPort}`));
          cmds.push(ipIfMissingT("nat", `POSTROUTING -p ${proto} -d ${rule.targetIp} --dport ${rule.targetPort} -j MASQUERADE`));
          if (rule.protocol === "both") {
            cmds.push(ipIfMissingT("nat", `PREROUTING -p udp --dport ${rule.sourcePort} -j DNAT --to-destination ${rule.targetIp}:${rule.targetPort}`));
            cmds.push(ipIfMissingT("nat", `POSTROUTING -p udp -d ${rule.targetIp} --dport ${rule.targetPort} -j MASQUERADE`));
          }
          // FORWARD 默认 DROP 的发行版（如 Debian/Docker host）需要显式放行
          cmds.push(ipIfMissing(`FORWARD -p ${proto} -d ${rule.targetIp} --dport ${rule.targetPort} -j ACCEPT`));
          cmds.push(ipIfMissing(`FORWARD -p ${proto} -s ${rule.targetIp} --sport ${rule.targetPort} -m state --state ESTABLISHED,RELATED -j ACCEPT`));
          if (rule.protocol === "both") {
            cmds.push(ipIfMissing(`FORWARD -p udp -d ${rule.targetIp} --dport ${rule.targetPort} -j ACCEPT`));
            cmds.push(ipIfMissing(`FORWARD -p udp -s ${rule.targetIp} --sport ${rule.targetPort} -j ACCEPT`));
          }
          // 挂入 mangle 计数链，为 Agent 采样提供准确流量计数器
          for (const c of buildCountingChainCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol)) cmds.push(c);
          for (const c of buildRuleAccessLimitCmds(rule)) cmds.push(c);
          actions.push({
            ruleId: rule.id,
            op: "apply",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            networkInterface: hostInterface,
            commands: cmds,
          });
        } else if (rule.forwardType === "nftables") {
          cmds.push(...buildNftForwardCmds(rule));
          for (const c of buildRuleAccessLimitCmds(rule)) cmds.push(c);
          actions.push({
            ruleId: rule.id,
            op: "apply",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            networkInterface: hostInterface,
            commands: cmds,
          });
        } else if (rule.forwardType === "realm") {
          const svcName = `forwardx-realm-${rule.sourcePort}`;
          const udpFlag = rule.protocol === "udp" || rule.protocol === "both" ? "--udp" : "";
          // 如果主机配置了网卡，realm 使用 --interface 绑定
          const ifaceFlag = hostInterface ? `--interface ${hostInterface}` : "";
          const realmCmd = `/usr/local/bin/realm -l 0.0.0.0:${rule.sourcePort} -r ${processTarget(rule)}:${rule.targetPort} ${udpFlag} ${ifaceFlag}`.replace(/\s+/g, ' ').trim();
          const unit = [
            "[Unit]",
            `Description=ForwardX realm forwarder ${rule.sourcePort}->${rule.targetIp}:${rule.targetPort}`,
            "After=network.target",
            "",
            "[Service]",
            "Type=simple",
            `ExecStart=${realmCmd}`,
            "Restart=always",
            "RestartSec=5",
            "LimitNOFILE=65535",
            "",
            "[Install]",
            "WantedBy=multi-user.target",
            "",
          ].join("\n");
          actions.push({
            ruleId: rule.id,
            op: "apply",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            networkInterface: hostInterface,
            svcName,
            unit,
            commands: [
              `systemctl daemon-reload`,
              `systemctl enable ${svcName}.service`,
              `systemctl restart ${svcName}.service`,
              // 同时为该端口挂入 mangle 计数链，保证 realm 转发也能被准确统计
              ...buildCountingChainCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
              ...buildRuleAccessLimitCmds(rule),
            ],
            failover: actionFailover(rule, { listenPort: failoverProxyPort(rule), bindAddress: "127.0.0.1" }),
          });
        } else if (rule.forwardType === "socat") {
          // socat 转发：用户态进程，通过 systemd 管理
          const svcName = `forwardx-socat-${rule.sourcePort}`;
          const socatPreCmds: string[] = [
            ...buildGostReloadCmds(),
            `command -v socat >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq socat || yum install -y -q socat || dnf install -y -q socat || apk add --no-cache socat; } 2>/dev/null`,
          ];
          const socatPostCmds: string[] = [];

          // 根据协议生成 socat 命令
          // TCP: socat TCP-LISTEN:sourcePort,fork,reuseaddr TCP:targetIp:targetPort
          // UDP: socat UDP-LISTEN:sourcePort,fork,reuseaddr UDP:targetIp:targetPort
          // both: 需要两个 socat 进程
          if (rule.protocol === "both") {
            // 两个服务：一个 TCP 一个 UDP
            const svcNameTcp = `forwardx-socat-tcp-${rule.sourcePort}`;
            const svcNameUdp = `forwardx-socat-udp-${rule.sourcePort}`;
            const unitTcp = [
              "[Unit]",
              `Description=ForwardX socat TCP forwarder ${rule.sourcePort}->${rule.targetIp}:${rule.targetPort}`,
              "After=network.target",
              "",
              "[Service]",
              "Type=simple",
              `ExecStart=/usr/bin/socat TCP-LISTEN:${rule.sourcePort},fork,reuseaddr TCP:${processTarget(rule)}:${rule.targetPort}`,
              "Restart=always",
              "RestartSec=5",
              "LimitNOFILE=65535",
              "",
              "[Install]",
              "WantedBy=multi-user.target",
              "",
            ].join("\n");
            const unitUdp = [
              "[Unit]",
              `Description=ForwardX socat UDP forwarder ${rule.sourcePort}->${rule.targetIp}:${rule.targetPort}`,
              "After=network.target",
              "",
              "[Service]",
              "Type=simple",
              `ExecStart=/usr/bin/socat UDP-LISTEN:${rule.sourcePort},fork,reuseaddr UDP:${processTarget(rule)}:${rule.targetPort}`,
              "Restart=always",
              "RestartSec=5",
              "LimitNOFILE=65535",
              "",
              "[Install]",
              "WantedBy=multi-user.target",
              "",
            ].join("\n");
            // socat both 模式下为该端口挂入 mangle 计数链
            for (const c of buildCountingChainCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol)) socatPostCmds.push(c);
            for (const c of buildRuleAccessLimitCmds(rule)) socatPostCmds.push(c);
            actions.push({
              ruleId: rule.id,
              op: "apply",
              forwardType: rule.forwardType,
              sourcePort: rule.sourcePort,
              targetIp: rule.targetIp,
              targetPort: rule.targetPort,
              protocol: rule.protocol,
              networkInterface: hostInterface,
              preCommands: socatPreCmds,
              svcName: svcNameTcp,
              svcNameExtra: svcNameUdp,
              unit: unitTcp,
              unitExtra: unitUdp,
              postCommands: socatPostCmds,
              failover: actionFailover(rule, { listenPort: failoverProxyPort(rule), bindAddress: "127.0.0.1" }),
            });
          } else {
            const protoUpper = rule.protocol === "udp" ? "UDP" : "TCP";
            const socatCmd = `/usr/bin/socat ${protoUpper}-LISTEN:${rule.sourcePort},fork,reuseaddr ${protoUpper}:${processTarget(rule)}:${rule.targetPort}`;
            const unit = [
              "[Unit]",
              `Description=ForwardX socat ${rule.protocol} forwarder ${rule.sourcePort}->${rule.targetIp}:${rule.targetPort}`,
              "After=network.target",
              "",
              "[Service]",
              "Type=simple",
              `ExecStart=${socatCmd}`,
              "Restart=always",
              "RestartSec=5",
              "LimitNOFILE=65535",
              "",
              "[Install]",
              "WantedBy=multi-user.target",
              "",
            ].join("\n");
            // socat 单协议模式下为该端口挂入 mangle 计数链
            for (const c of buildCountingChainCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol)) socatPostCmds.push(c);
            for (const c of buildRuleAccessLimitCmds(rule)) socatPostCmds.push(c);
            actions.push({
              ruleId: rule.id,
              op: "apply",
              forwardType: rule.forwardType,
              sourcePort: rule.sourcePort,
              targetIp: rule.targetIp,
              targetPort: rule.targetPort,
              protocol: rule.protocol,
              networkInterface: hostInterface,
              preCommands: socatPreCmds,
              svcName,
              unit,
              postCommands: socatPostCmds,
              failover: actionFailover(rule, { listenPort: failoverProxyPort(rule), bindAddress: "127.0.0.1" }),
            });
          }
        } else if (rule.forwardType === "gost") {
          const tunnel = (rule as any).tunnelId ? tunnelById.get((rule as any).tunnelId) as any : null;
          if (tunnel && isForwardXTunnel(tunnel)) {
            const tunnelHops = tunnelHopsByTunnelId.get(Number(tunnel.id));
            const nextHop = Array.isArray(tunnelHops) && tunnelHops.length >= 2 ? (tunnelHops[1] as any) : null;
            const tunnelEndpoint = tunnelExitEndpointById.get(tunnel.id);
            const tunnelExitHost = nextHop ? await getHopDialAddress(nextHop) : tunnelEndpoint?.host;
            const tunnelExitPort = nextHop ? Number(nextHop.listenPort) : Number(tunnel.listenPort);
            const tunnelKey = nextHop ? hopKey(tunnelSecretSeed(tunnel), Number(nextHop.seq)) : tunnelSecretSeed(tunnel);
            const rateLimits = userRateLimits(Number(rule.userId));
            const accessLimits = userAccessLimits(Number(rule.userId));
            const mainBackup = failoverForCurrentHost(rule, tunnel, { listenPort: failoverProxyPort(rule) });
            actions.push({
              ruleId: rule.id,
              op: "apply",
              forwardType: "forwardx",
              sourcePort: rule.sourcePort,
              targetIp: rule.targetIp,
              targetPort: rule.targetPort,
              protocol: rule.protocol,
              networkInterface: hostInterface,
              commands: rule.isRunning ? [] : [
                ...buildManagedPortCleanupCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
                ...buildCountingChainCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
              ],
              fxp: {
                role: "entry",
                tunnelId: tunnel.id,
                ruleId: rule.id,
                listenPort: rule.sourcePort,
                protocol: rule.protocol,
                exitHost: tunnelExitHost,
                exitPort: tunnelExitPort,
                targetIp: mainBackup ? "127.0.0.1" : rule.targetIp,
                targetPort: mainBackup ? failoverProxyPort(rule) : rule.targetPort,
                key: tunnelKey,
                ...rateLimits,
                ...accessLimits,
                accessScope: accessScopeForRule(rule),
                ...tunnelProtocolPolicy(tunnel),
              },
              failover: mainBackup,
            });
            continue;
          }
          actions.push({
            tunnelId: tunnel ? tunnel.id : 0,
            statusType: tunnel ? "rule" : undefined,
            ruleId: rule.id,
            op: "apply",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            networkInterface: hostInterface,
            commands: [
              ...buildGostReloadCmds(),
              ...buildCountingChainCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
              ...buildRuleAccessLimitCmds(rule),
            ],
            failover: tunnel ? undefined : actionFailover(rule, { listenPort: failoverProxyPort(rule), bindAddress: "127.0.0.1" }),
          });
        }
      } else if (!rule.isEnabled && rule.isRunning) {
        const cmds: string[] = [];
        if (rule.forwardType === "iptables") {
          const proto = rule.protocol === "both" ? "tcp" : rule.protocol;
          cmds.push(`iptables -t nat -D PREROUTING -p ${proto} --dport ${rule.sourcePort} -j DNAT --to-destination ${rule.targetIp}:${rule.targetPort} 2>/dev/null || true`);
          cmds.push(`iptables -t nat -D POSTROUTING -p ${proto} -d ${rule.targetIp} --dport ${rule.targetPort} -j MASQUERADE 2>/dev/null || true`);
          if (rule.protocol === "both") {
            cmds.push(`iptables -t nat -D PREROUTING -p udp --dport ${rule.sourcePort} -j DNAT --to-destination ${rule.targetIp}:${rule.targetPort} 2>/dev/null || true`);
            cmds.push(`iptables -t nat -D POSTROUTING -p udp -d ${rule.targetIp} --dport ${rule.targetPort} -j MASQUERADE 2>/dev/null || true`);
          }
          cmds.push(`iptables -D FORWARD -p ${proto} -d ${rule.targetIp} --dport ${rule.targetPort} -j ACCEPT 2>/dev/null || true`);
          cmds.push(`iptables -D FORWARD -p ${proto} -s ${rule.targetIp} --sport ${rule.targetPort} -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true`);
          // 清理 conntrack 流量状态文件
          cmds.push(`rm -f /var/lib/forwardx-agent/traffic_${rule.sourcePort}.prev 2>/dev/null || true`);
          cmds.push(`rm -f /var/lib/forwardx-agent/port_${rule.sourcePort}.rule 2>/dev/null || true`);
          // 兼容清理旧版 mangle/filter 表计数链
          cmds.push(`iptables -t mangle -D PREROUTING -p tcp --dport ${rule.sourcePort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -t mangle -D PREROUTING -p udp --dport ${rule.sourcePort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -t mangle -D POSTROUTING -p tcp --sport ${rule.sourcePort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -t mangle -D POSTROUTING -p udp --sport ${rule.sourcePort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -t mangle -F FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -t mangle -X FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -t mangle -F FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -t mangle -X FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -D FORWARD -p tcp -d ${rule.targetIp} --dport ${rule.targetPort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -D FORWARD -p udp -d ${rule.targetIp} --dport ${rule.targetPort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -D FORWARD -p tcp -s ${rule.targetIp} --sport ${rule.targetPort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -D FORWARD -p udp -s ${rule.targetIp} --sport ${rule.targetPort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -F FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -X FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -F FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -X FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          for (const c of buildAccessLimitCleanupCmds(rule.sourcePort, accessScopeForRule(rule))) cmds.push(c);
          actions.push({
            ruleId: rule.id,
            op: "remove",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            commands: cmds,
          });
        } else if (rule.forwardType === "realm") {
          const svcName = `forwardx-realm-${rule.sourcePort}`;
          actions.push({
            ruleId: rule.id,
            op: "remove",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            svcName,
            commands: [
              `systemctl stop ${svcName}.service 2>/dev/null || true`,
              `systemctl disable ${svcName}.service 2>/dev/null || true`,
              `rm -f /etc/systemd/system/${svcName}.service`,
              `systemctl daemon-reload`,
              killByPatternCmd(`[r]ealm .*:${rule.sourcePort}`),
              // 清理 conntrack 流量状态文件
              `rm -f /var/lib/forwardx-agent/traffic_${rule.sourcePort}.prev 2>/dev/null || true`,
              `rm -f /var/lib/forwardx-agent/port_${rule.sourcePort}.rule 2>/dev/null || true`,
              // 兼容清理旧版 mangle/filter 表计数链
              `iptables -t mangle -D PREROUTING -p tcp --dport ${rule.sourcePort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -t mangle -D PREROUTING -p udp --dport ${rule.sourcePort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -t mangle -D POSTROUTING -p tcp --sport ${rule.sourcePort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -t mangle -D POSTROUTING -p udp --sport ${rule.sourcePort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -t mangle -F FWX_IN_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -t mangle -X FWX_IN_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -t mangle -F FWX_OUT_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -t mangle -X FWX_OUT_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -D INPUT -p tcp --dport ${rule.sourcePort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -D INPUT -p udp --dport ${rule.sourcePort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -D OUTPUT -p tcp --sport ${rule.sourcePort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -D OUTPUT -p udp --sport ${rule.sourcePort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -F FWX_IN_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -X FWX_IN_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -F FWX_OUT_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -X FWX_OUT_${rule.sourcePort} 2>/dev/null || true`,
              ...buildAccessLimitCleanupCmds(rule.sourcePort, accessScopeForRule(rule)),
            ],
          });
        } else if (rule.forwardType === "socat") {
          const removeCmds: string[] = [];
          if (rule.protocol === "both") {
            const svcTcp = `forwardx-socat-tcp-${rule.sourcePort}`;
            const svcUdp = `forwardx-socat-udp-${rule.sourcePort}`;
            removeCmds.push(`systemctl stop ${svcTcp}.service 2>/dev/null || true`);
            removeCmds.push(`systemctl disable ${svcTcp}.service 2>/dev/null || true`);
            removeCmds.push(`rm -f /etc/systemd/system/${svcTcp}.service`);
            removeCmds.push(`systemctl stop ${svcUdp}.service 2>/dev/null || true`);
            removeCmds.push(`systemctl disable ${svcUdp}.service 2>/dev/null || true`);
            removeCmds.push(`rm -f /etc/systemd/system/${svcUdp}.service`);
          } else {
            const svcName = `forwardx-socat-${rule.sourcePort}`;
            removeCmds.push(`systemctl stop ${svcName}.service 2>/dev/null || true`);
            removeCmds.push(`systemctl disable ${svcName}.service 2>/dev/null || true`);
            removeCmds.push(`rm -f /etc/systemd/system/${svcName}.service`);
          }
          removeCmds.push(`systemctl daemon-reload`);
          removeCmds.push(killByPatternCmd(`[s]ocat.*LISTEN:${rule.sourcePort}`));
          // 清理 conntrack 流量状态文件
          removeCmds.push(`rm -f /var/lib/forwardx-agent/traffic_${rule.sourcePort}.prev 2>/dev/null || true`);
          removeCmds.push(`rm -f /var/lib/forwardx-agent/port_${rule.sourcePort}.rule 2>/dev/null || true`);
          // 兼容清理旧版 mangle/filter 表计数链
          removeCmds.push(`iptables -t mangle -D PREROUTING -p tcp --dport ${rule.sourcePort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -t mangle -D PREROUTING -p udp --dport ${rule.sourcePort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -t mangle -D POSTROUTING -p tcp --sport ${rule.sourcePort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -t mangle -D POSTROUTING -p udp --sport ${rule.sourcePort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -t mangle -F FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -t mangle -X FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -t mangle -F FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -t mangle -X FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -D INPUT -p tcp --dport ${rule.sourcePort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -D INPUT -p udp --dport ${rule.sourcePort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -D OUTPUT -p tcp --sport ${rule.sourcePort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -D OUTPUT -p udp --sport ${rule.sourcePort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -F FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -X FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -F FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -X FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          for (const c of buildAccessLimitCleanupCmds(rule.sourcePort, accessScopeForRule(rule))) removeCmds.push(c);
          actions.push({
            ruleId: rule.id,
            op: "remove",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            commands: removeCmds,
          });
        } else if (rule.forwardType === "gost") {
          const tunnel = (rule as any).tunnelId ? tunnelById.get((rule as any).tunnelId) as any : null;
          const removeCmds: string[] = [
            ...buildGostReloadCmds(),
            ...buildManagedPortCleanupCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
          ];
          actions.push({
            ruleId: rule.id,
            op: "remove",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            commands: removeCmds,
            fxp: tunnel && isForwardXTunnel(tunnel) ? {
              role: "entry",
              tunnelId: tunnel.id,
              ruleId: rule.id,
              listenPort: rule.sourcePort,
              protocol: rule.protocol,
              key: tunnelSecretSeed(tunnel),
            } : undefined,
          });
        }
      }
    }

    // 取走该主机的 pending 转发自测任务并标为 running
    for (const rule of tunnelExitRules) {
      const tunnel = tunnelById.get((rule as any).tunnelId) as any;
      if (tunnel && hasProtocolPolicy(tunnel)) {
        const target = failoverTargetEndpoint(rule);
        guardRules.push({
          ruleId: rule.id,
          tunnelId: tunnel.id,
          listenPort: guardListenPort(rule),
          targetIp: target.targetIp,
          targetPort: target.targetPort,
          policy: tunnelProtocolPolicy(tunnel),
        });
      }
    }

    for (const rule of tunnelExitRules) {
      if (!rule.isEnabled) continue;
      const trafficPort = Number((rule as any).tunnelExitPort) || 0;
      if (!trafficPort) continue;
      addRunningRule({
        ruleId: rule.id,
        sourcePort: trafficPort,
        targetIp: rule.targetIp,
        targetPort: rule.targetPort,
        protocol: rule.protocol,
        forwardType: "gost-tunnel-exit",
        failover: failoverForCurrentHost(rule, tunnelById.get(Number(rule.tunnelId)) as any, { listenPort: failoverProxyPort(rule) }),
      });
    }

    const gostMultiHopRelayRules = await Promise.all(agentAllRules
      .filter((rule: any) => {
        if (!rule || rule.pendingDelete || !rule.isEnabled || !rule.isRunning) return false;
        if (rule.forwardType !== "gost" || !rule.tunnelId) return false;
        const tunnel = tunnelById.get(Number(rule.tunnelId)) as any;
        if (!tunnel || isForwardXTunnel(tunnel) || !tunnel.isEnabled) return false;
        if (!isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)) return false;
        if (!isRuleProtocolEnabled(forwardProtocolSettings, rule, tunnel)) return false;
        const hops = tunnelHopsByTunnelId.get(Number(tunnel.id));
        return Array.isArray(hops) && hops.length >= 3;
      })
      .map(async (rule: any) => {
        const tunnel = tunnelById.get(Number(rule.tunnelId)) as any;
        const hops = tunnelHopsByTunnelId.get(Number(tunnel.id)) || [];
        const hostIdx = hops.findIndex((hop: any) => Number(hop.hostId) === Number(host.id));
        if (hostIdx <= 0 || hostIdx >= hops.length - 1) return null;
        const currentHop = hops[hostIdx] as any;
        const nextHop = hops[hostIdx + 1] as any;
        const nextHost = await getHopDialAddress(nextHop);
        const sourcePort = Number(currentHop.listenPort) || 0;
        const targetPort = Number(nextHop.listenPort) || 0;
        if (!sourcePort || !targetPort || !nextHost) return null;
        return {
          ruleId: Number(rule.id),
          sourcePort,
          targetIp: nextHost,
          targetPort,
          protocol: "tcp",
          forwardType: "gost-tunnel-hop",
        };
      }));
    for (const runningRule of gostMultiHopRelayRules) {
      if (runningRule) addRunningRule(runningRule);
    }

    const pendingTests = await db.getPendingForwardTestsByHost(host.id);
    const selfTests: any[] = [];
    for (const t of pendingTests) {
      await db.markForwardTestRunning(t.id);
      const meta = parseSelfTestMeta((t as any).message);
      if (meta?.kind === "tunnel") {
        selfTests.push({
          testId: t.id,
          kind: "tunnel",
          tunnelId: meta.tunnelId,
          ruleId: 0,
          forwardType: "gost-tunnel",
          protocol: "tcp",
          sourcePort: 0,
          targetIp: meta.targetIp,
          targetPort: meta.targetPort,
        });
        continue;
      }
      if (meta?.kind === "tunnel-hop") {
        selfTests.push({
          testId: t.id,
          kind: "tunnel-hop",
          tunnelId: meta.tunnelId,
          ruleId: 0,
          forwardType: "gost-tunnel",
          protocol: "tcp",
          sourcePort: 0,
          targetIp: meta.targetIp,
          targetPort: meta.targetPort,
        });
        continue;
      }
      if (meta?.kind === "forward-via-tunnel") {
        selfTests.push({
          testId: t.id,
          kind: "forward-via-tunnel",
          tunnelId: meta.tunnelId,
          ruleId: t.ruleId,
          forwardType: "gost-tunnel",
          protocol: "tcp",
          sourcePort: 0,
          targetIp: meta.targetIp,
          targetPort: meta.targetPort,
        });
        continue;
      }
      if (meta?.kind === "forward-via-tunnel-entry") {
        selfTests.push({
          testId: t.id,
          kind: "forward-via-tunnel-entry",
          tunnelId: meta.tunnelId,
          ruleId: t.ruleId,
          forwardType: "gost-tunnel",
          protocol: "tcp",
          sourcePort: meta.entrySourcePort || 0,
          targetIp: meta.entryIp,
          targetPort: meta.entrySourcePort,
        });
        continue;
      }
      if (meta?.kind === "forward-chain") {
        selfTests.push({
          testId: t.id,
          kind: "forward-chain",
          groupId: meta.groupId,
          ruleId: t.ruleId,
          forwardType: "forward-chain",
          protocol: "tcp",
          sourcePort: meta.entrySourcePort || 0,
          targetIp: meta.entryIp,
          targetPort: meta.entrySourcePort,
        });
        continue;
      }
      const rule = await db.getForwardRuleById(t.ruleId);
      if (!rule) continue;
      selfTests.push({
        testId: t.id,
        ruleId: rule.id,
        forwardType: rule.forwardType,
        protocol: rule.protocol,
        sourcePort: rule.sourcePort,
        targetIp: rule.targetIp,
        targetPort: rule.targetPort,
      });
    }

    const requestedTargetVersion = (host as any).agentUpgradeTargetVersion || AGENT_VERSION;
    const agentUpgradeCompleted = (host as any).agentUpgradeRequested
      && agentVersion
      && isAgentVersionAtLeast(agentVersion, requestedTargetVersion);
    if (agentUpgradeCompleted) {
      await db.clearHostAgentUpgradeRequest(host.id);
    }
    const agentUpgrade = (host as any).agentUpgradeRequested && !agentUpgradeCompleted ? {
      targetVersion: requestedTargetVersion,
      panelUrl: await resolvePanelUrl(req),
    } : null;

    const normalizedActions = actions.map((action: any) => ({
      ...action,
      issuedAt: Number(action.issuedAt) || responseIssuedAt,
      statusType: action.statusType || (Number(action.ruleId) > 0 ? "rule" : (Number(action.tunnelId) > 0 ? "tunnel" : undefined)),
    }));
    const runningRuleKeys = new Set(runningRules.map((rule: any) => `${Number(rule.ruleId)}:${Number(rule.sourcePort)}`));
    for (const action of normalizedActions) {
      if (!action?.failover || action.op !== "apply" || !Number(action.ruleId) || !Number(action.sourcePort)) continue;
      const key = `${Number(action.ruleId)}:${Number(action.sourcePort)}`;
      if (runningRuleKeys.has(key)) continue;
      addRunningRule({
        ruleId: Number(action.ruleId),
        sourcePort: Number(action.sourcePort),
        targetIp: String(action.targetIp || ""),
        targetPort: Number(action.targetPort || 0),
        protocol: action.protocol || "tcp",
        forwardType: action.forwardType || "unknown",
        failover: action.failover,
      });
      runningRuleKeys.add(key);
    }
    const orderedActions = normalizedActions.slice().sort((a: any, b: any) => {
      if (a.op === b.op) return 0;
      return a.op === "remove" ? -1 : 1;
    });

    const agentLogUploadEnabled = (await db.getSetting("agentLogUploadEnabled")) === "true";
    const lookingGlassTests = takeLookingGlassAgentTasks(host.id);
    const iperf3Tasks = takeIperf3AgentTasks(host.id);
    res.json({ success: true, actions: orderedActions, selfTests, runningRules, tunnelProbes, guardRules, lookingGlassTests, iperf3Tasks, agentUpgrade, agentLogUploadEnabled, nextInterval: isHostMetricsWatching(host.id) || lookingGlassTests.length > 0 || iperf3Tasks.length > 0 ? 2 : 30 });
  } catch (error) {
    console.error("[Agent Heartbeat] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Agent 规则状态回调

}
