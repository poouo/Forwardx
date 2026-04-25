import { Router, Request, Response } from "express";
import * as db from "./db";

const agentRouter = Router();

// Agent 注册接口
agentRouter.post("/api/agent/register", async (req: Request, res: Response) => {
  try {
    const { token, ip, osInfo, cpuInfo, memoryTotal } = req.body;
    if (!token) {
      res.status(400).json({ error: "Token is required" });
      return;
    }

    // 验证 token
    const agentToken = await db.getAgentTokenByToken(token);
    if (!agentToken) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    // 检查是否已有主机使用此 token
    const existingHost = await db.getHostByAgentToken(token);
    if (existingHost) {
      await db.updateHost(existingHost.id, {
        ip: ip || existingHost.ip,
        osInfo: osInfo || existingHost.osInfo,
        cpuInfo: cpuInfo || existingHost.cpuInfo,
        memoryTotal: memoryTotal || existingHost.memoryTotal,
        isOnline: true,
        lastHeartbeat: new Date(),
      });
      res.json({ success: true, hostId: existingHost.id, message: "Host updated" });
      return;
    }

    // 创建新主机
    const hostId = await db.createHost({
      name: `Agent-${token.substring(0, 8)}`,
      ip: ip || "unknown",
      port: 0,
      hostType: "slave",
      connectionType: "agent",
      agentToken: token,
      osInfo: osInfo || null,
      cpuInfo: cpuInfo || null,
      memoryTotal: memoryTotal || null,
      isOnline: true,
      lastHeartbeat: new Date(),
      userId: agentToken.userId,
    });

    await db.markAgentTokenUsed(token, hostId);
    res.json({ success: true, hostId, message: "Host registered" });
  } catch (error) {
    console.error("[Agent Register] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Agent 心跳接口
agentRouter.post("/api/agent/heartbeat", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const token = authHeader.substring(7);
    const host = await db.getHostByAgentToken(token);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    const { cpuUsage, memoryUsage, memoryUsed, networkIn, networkOut, diskUsage, uptime } = req.body;

    await db.updateHostHeartbeat(host.id);

    await db.insertHostMetric({
      hostId: host.id,
      cpuUsage: cpuUsage ?? null,
      memoryUsage: memoryUsage ?? null,
      memoryUsed: memoryUsed ?? null,
      networkIn: networkIn ?? null,
      networkOut: networkOut ?? null,
      diskUsage: diskUsage ?? null,
      uptime: uptime ?? null,
    });

    // 获取该主机的转发规则
    const rules = await db.getForwardRules(undefined, host.id);
    const actions: any[] = [];

    // 获取主机配置的网卡名称（用于 tc 限速和 realm --interface）
    const hostInterface = (host as any).networkInterface || "";

    /** 包装一条只追加一次的 iptables 规则：先 -C 检查是否存在，不存在才 -A */
    const ipIfMissing = (rule: string) => `iptables -C ${rule} 2>/dev/null || iptables -A ${rule}`;
    const ipIfMissingT = (table: string, rule: string) =>
      `iptables -t ${table} -C ${rule} 2>/dev/null || iptables -t ${table} -A ${rule}`;

    // 收集所有正在运行的规则的 port→ruleId 映射，用于 agent 重建映射文件
    const runningRules: { ruleId: number; sourcePort: number; targetIp: string; targetPort: number; protocol: string }[] = [];

    for (const rule of rules) {
      // 收集所有已运行的规则映射（无论是否有 action 下发）
      if (rule.isEnabled && rule.isRunning) {
        runningRules.push({
          ruleId: rule.id,
          sourcePort: rule.sourcePort,
          targetIp: rule.targetIp,
          targetPort: rule.targetPort,
          protocol: rule.protocol,
        });
      }

      if (rule.isEnabled && !rule.isRunning) {
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
          // tc 限速：使用主机配置的网卡，如果未配置则由 agent 自动检测
          if (rule.uploadLimit > 0) {
            cmds.push(`TC_DEV=\${NET_IFACE:-eth0}; tc qdisc add dev $TC_DEV root handle 1: htb default 10 2>/dev/null || true`);
            cmds.push(`TC_DEV=\${NET_IFACE:-eth0}; tc class add dev $TC_DEV parent 1: classid 1:${rule.sourcePort % 9999 + 1} htb rate ${rule.uploadLimit}kbit 2>/dev/null || true`);
          }
          if (rule.downloadLimit > 0) {
            cmds.push(`TC_DEV=\${NET_IFACE:-eth0}; tc qdisc add dev $TC_DEV ingress 2>/dev/null || true`);
            cmds.push(`TC_DEV=\${NET_IFACE:-eth0}; tc filter add dev $TC_DEV parent ffff: protocol ip u32 match ip sport ${rule.sourcePort} 0xffff police rate ${rule.downloadLimit}kbit burst 10k drop flowid :1 2>/dev/null || true`);
          }
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
          const realmCmd = `/usr/local/bin/realm -l 0.0.0.0:${rule.sourcePort} -r ${rule.targetIp}:${rule.targetPort} ${udpFlag} ${ifaceFlag}`.replace(/\s+/g, ' ').trim();
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
            ],
          });
        } else if (rule.forwardType === "socat") {
          // socat 转发：用户态进程，通过 systemd 管理
          const svcName = `forwardx-socat-${rule.sourcePort}`;
          const socatCmds: string[] = [];
          // socat 需要安装
          socatCmds.push(`command -v socat >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq socat || yum install -y -q socat || dnf install -y -q socat || apk add --no-cache socat; } 2>/dev/null`);

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
              `ExecStart=/usr/bin/socat TCP-LISTEN:${rule.sourcePort},fork,reuseaddr TCP:${rule.targetIp}:${rule.targetPort}`,
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
              `ExecStart=/usr/bin/socat UDP-LISTEN:${rule.sourcePort},fork,reuseaddr UDP:${rule.targetIp}:${rule.targetPort}`,
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
              svcName: svcNameTcp,
              svcNameExtra: svcNameUdp,
              unit: unitTcp,
              unitExtra: unitUdp,
              commands: socatCmds,
            });
          } else {
            const protoUpper = rule.protocol === "udp" ? "UDP" : "TCP";
            const socatCmd = `/usr/bin/socat ${protoUpper}-LISTEN:${rule.sourcePort},fork,reuseaddr ${protoUpper}:${rule.targetIp}:${rule.targetPort}`;
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
              commands: socatCmds,
            });
          }
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
          // 清理流量计数链（带 -p 协议参数）
          cmds.push(`iptables -D FORWARD -p tcp -d ${rule.targetIp} --dport ${rule.targetPort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -D FORWARD -p udp -d ${rule.targetIp} --dport ${rule.targetPort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -D FORWARD -p tcp -s ${rule.targetIp} --sport ${rule.targetPort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -D FORWARD -p udp -s ${rule.targetIp} --sport ${rule.targetPort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          // 也清理不带 -p 的旧规则（兼容升级）
          cmds.push(`iptables -D FORWARD -d ${rule.targetIp} --dport ${rule.targetPort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -D FORWARD -s ${rule.targetIp} --sport ${rule.targetPort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -F FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -X FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -F FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -X FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          // 清理旧版 INPUT 计数链（兼容升级）
          cmds.push(`iptables -D INPUT -p tcp --dport ${rule.sourcePort} -j FWX_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -D INPUT -p udp --dport ${rule.sourcePort} -j FWX_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -F FWX_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -X FWX_${rule.sourcePort} 2>/dev/null || true`);
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
              `pkill -f "realm .*:${rule.sourcePort}" 2>/dev/null || true`,
              // 清理 realm 的流量计数链
              `iptables -D FORWARD -p tcp -d ${rule.targetIp} --dport ${rule.targetPort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -D FORWARD -p udp -d ${rule.targetIp} --dport ${rule.targetPort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -D FORWARD -p tcp -s ${rule.targetIp} --sport ${rule.targetPort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -D FORWARD -p udp -s ${rule.targetIp} --sport ${rule.targetPort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -D FORWARD -d ${rule.targetIp} --dport ${rule.targetPort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -D FORWARD -s ${rule.targetIp} --sport ${rule.targetPort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -F FWX_IN_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -X FWX_IN_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -F FWX_OUT_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -X FWX_OUT_${rule.sourcePort} 2>/dev/null || true`,
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
          removeCmds.push(`pkill -f "socat.*LISTEN:${rule.sourcePort}" 2>/dev/null || true`);
          // 清理 socat 的流量计数链（INPUT 链）
          removeCmds.push(`iptables -D INPUT -p tcp --dport ${rule.sourcePort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -D INPUT -p udp --dport ${rule.sourcePort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -D OUTPUT -p tcp --sport ${rule.sourcePort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -D OUTPUT -p udp --sport ${rule.sourcePort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -F FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -X FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -F FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -X FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
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
        }
      }
    }

    // 取走该主机的 pending 转发自测任务并标为 running
    const pendingTests = await db.getPendingForwardTestsByHost(host.id);
    const selfTests: any[] = [];
    for (const t of pendingTests) {
      const rule = await db.getForwardRuleById(t.ruleId);
      if (!rule) continue;
      await db.markForwardTestRunning(t.id);
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

    res.json({ success: true, actions, selfTests, runningRules });
  } catch (error) {
    console.error("[Agent Heartbeat] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Agent 规则状态回调
agentRouter.post("/api/agent/rule-status", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const token = authHeader.substring(7);
    const host = await db.getHostByAgentToken(token);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    const { ruleId, isRunning } = req.body;
    if (typeof ruleId !== "number") {
      res.status(400).json({ error: "ruleId is required" });
      return;
    }

    await db.updateRuleRunningStatus(ruleId, !!isRunning);
    res.json({ success: true });
  } catch (error) {
    console.error("[Agent Rule Status] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Agent 上报转发自测结果
agentRouter.post("/api/agent/selftest-result", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const token = authHeader.substring(7);
    const host = await db.getHostByAgentToken(token);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    const { testId, listenOk, targetReachable, forwardOk, latencyMs, message } = req.body || {};
    if (typeof testId !== "number") {
      res.status(400).json({ error: "testId is required" });
      return;
    }
    const t = await db.getForwardTestById(testId);
    if (!t || t.hostId !== host.id) {
      res.status(404).json({ error: "test not found" });
      return;
    }
    // 连通性判定只使用「目标可达」和「本机贯穿」两项，忽略「本地监听检测」
    const success = !!targetReachable && !!forwardOk;
    await db.updateForwardTestResult(testId, {
      status: success ? "success" : "failed",
      listenOk: !!listenOk,
      targetReachable: !!targetReachable,
      forwardOk: !!forwardOk,
      latencyMs: typeof latencyMs === "number" ? latencyMs : null,
      message: typeof message === "string" ? message.slice(0, 4000) : null,
    });
    res.json({ success: true });
  } catch (error) {
    console.error("[Agent SelfTest] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Agent 轻量轮询：仅获取该主机的 pending 转发自测任务并标为 running
agentRouter.post("/api/agent/selftest-pull", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const token = authHeader.substring(7);
    const host = await db.getHostByAgentToken(token);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    const pendingTests = await db.getPendingForwardTestsByHost(host.id);
    const selfTests: any[] = [];
    for (const t of pendingTests) {
      const rule = await db.getForwardRuleById(t.ruleId);
      if (!rule) continue;
      await db.markForwardTestRunning(t.id);
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
    res.json({ success: true, selfTests });
  } catch (error) {
    console.error("[Agent SelfTest Pull] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Agent 流量上报
agentRouter.post("/api/agent/traffic", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const token = authHeader.substring(7);
    const host = await db.getHostByAgentToken(token);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    const { stats } = req.body;
    if (!Array.isArray(stats)) {
      res.status(400).json({ error: "stats array is required" });
      return;
    }

    for (const stat of stats) {
      await db.insertTrafficStat({
        ruleId: stat.ruleId,
        hostId: host.id,
        bytesIn: stat.bytesIn || 0,
        bytesOut: stat.bytesOut || 0,
        connections: stat.connections || 0,
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("[Agent Traffic] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Generate install.sh bootstrap script as a plain string
function generateInstallScript(): string {
  const lines = [
    '#!/bin/bash',
    '# ForwardX Agent 管理脚本',
    '# 安装: curl -sL PANEL_URL/api/agent/install.sh | PANEL_URL="your-panel-url" bash -s -- install YOUR_TOKEN',
    '# 卸载: curl -sL PANEL_URL/api/agent/install.sh | bash -s -- uninstall',
    '',
    'set -e',
    '',
    'ACTION="${1:-}"',
    'TOKEN="${2:-}"',
    'PANEL_URL="${PANEL_URL:-http://localhost:3000}"',
    '',
    'show_help() {',
    '  echo "======================================"',
    '  echo "  ForwardX Agent 管理工具"',
    '  echo "======================================"',
    '  echo ""',
    '  echo "用法:"',
    '  echo "  安装 Agent:"',
    '  echo "    curl -sL PANEL_URL/api/agent/install.sh | PANEL_URL=\\"http://your-panel:3000\\" bash -s -- install YOUR_TOKEN"',
    '  echo ""',
    '  echo "  卸载 Agent:"',
    '  echo "    curl -sL PANEL_URL/api/agent/install.sh | bash -s -- uninstall"',
    '  echo ""',
    '  echo "参数:"',
    '  echo "  install   <TOKEN>  安装 Agent 并注册到面板"',
    '  echo "  uninstall          完全卸载 Agent 及相关组件"',
    '  echo ""',
    '}',
    '',
    'do_uninstall() {',
    '  echo "======================================"',
    '  echo "  ForwardX Agent 卸载程序"',
    '  echo "======================================"',
    '  echo ""',
    '',
    '  if [ "$(id -u)" != "0" ]; then',
    '    echo "[错误] 请使用 root 权限运行此脚本"',
    '    exit 1',
    '  fi',
    '',
    '  SERVICE_NAME="forwardx-agent"',
    '  INSTALL_DIR="/opt/forwardx-agent"',
    '',
    '  echo "[步骤 1/4] 停止 Agent 服务..."',
    '  if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then',
    '    systemctl stop "$SERVICE_NAME"',
    '    echo "[信息] 服务已停止"',
    '  else',
    '    echo "[信息] 服务未在运行"',
    '  fi',
    '',
    '  echo "[步骤 2/4] 禁用并删除服务..."',
    '  if [ -f "/etc/systemd/system/$SERVICE_NAME.service" ]; then',
    '    systemctl disable "$SERVICE_NAME" 2>/dev/null || true',
    '    rm -f "/etc/systemd/system/$SERVICE_NAME.service"',
    '    systemctl daemon-reload',
    '    echo "[信息] 服务文件已删除"',
    '  else',
    '    echo "[信息] 服务文件不存在"',
    '  fi',
    '',
    '  echo "[步骤 3/4] 清理 Agent 文件..."',
    '  if [ -d "$INSTALL_DIR" ]; then',
    '    rm -rf "$INSTALL_DIR"',
    '    echo "[信息] 安装目录已删除: $INSTALL_DIR"',
    '  else',
    '    echo "[信息] 安装目录不存在"',
    '  fi',
    '',
    '  echo "[步骤 4/4] 清理转发规则..."',
    '  iptables -t nat -F PREROUTING 2>/dev/null && echo "[信息] 已清理 iptables PREROUTING 规则" || echo "[信息] 无 iptables PREROUTING 规则需要清理"',
    '  iptables -t nat -F POSTROUTING 2>/dev/null && echo "[信息] 已清理 iptables POSTROUTING 规则" || echo "[信息] 无 iptables POSTROUTING 规则需要清理"',
    '  # 清理所有 PORTFLOW 流量计数链',
    '  for CH in $(iptables -L 2>/dev/null | awk \'/^Chain FWX_/ {print $2}\'); do',
    '    iptables -D FORWARD -j "$CH" 2>/dev/null || true',
    '    iptables -D INPUT -j "$CH" 2>/dev/null || true',
    '    iptables -D OUTPUT -j "$CH" 2>/dev/null || true',
    '    iptables -F "$CH" 2>/dev/null || true',
    '    iptables -X "$CH" 2>/dev/null || true',
    '  done',
    '  # 自动检测默认网卡用于清理 tc',
    '  DEFAULT_DEV=$(ip route show default 2>/dev/null | awk \'{print $5; exit}\')',
    '  DEFAULT_DEV=${DEFAULT_DEV:-eth0}',
    '  tc qdisc del dev "$DEFAULT_DEV" root 2>/dev/null || true',
    '  tc qdisc del dev "$DEFAULT_DEV" ingress 2>/dev/null || true',
    '  pkill -f "realm -l" 2>/dev/null && echo "[信息] 已停止所有 realm 转发进程" || echo "[信息] 无 realm 进程需要停止"',
    '  pkill -f "socat.*LISTEN" 2>/dev/null && echo "[信息] 已停止所有 socat 转发进程" || echo "[信息] 无 socat 进程需要停止"',
    '  # 清理 socat/realm systemd 服务',
    '  for SVC in /etc/systemd/system/forwardx-socat-*.service /etc/systemd/system/forwardx-realm-*.service; do',
    '    [ -f "$SVC" ] && rm -f "$SVC"',
    '  done',
    '  systemctl daemon-reload 2>/dev/null || true',
    '',
    '  echo ""',
    '  echo "======================================"',
    '  echo "  ForwardX Agent 卸载完成!"',
    '  echo "======================================"',
    '  echo ""',
    '  echo "  Agent 服务、文件和转发规则已全部清理"',
    '  echo "  如需重新安装，请使用 install 命令"',
    '  echo "======================================"',
    '}',
    '',
    'do_install() {',
    '  AGENT_TOKEN="$1"',
    '  if [ -z "$AGENT_TOKEN" ]; then',
    '    echo "[错误] 安装模式需要提供 Agent Token"',
    '    echo "用法: curl -sL PANEL_URL/api/agent/install.sh | PANEL_URL=\\"http://your-panel:3000\\" bash -s -- install YOUR_TOKEN"',
    '    exit 1',
    '  fi',
    '',
    '  echo "正在从面板获取完整安装脚本..."',
    '  echo "面板地址: $PANEL_URL"',
    '  echo "Token: $AGENT_TOKEN"',
    '  echo ""',
    '',
    '  curl -s "$PANEL_URL/api/agent/full-install.sh?token=$AGENT_TOKEN" | bash',
    '}',
    '',
    'case "$ACTION" in',
    '  install)',
    '    do_install "$TOKEN"',
    '    ;;',
    '  uninstall|remove|delete)',
    '    do_uninstall',
    '    ;;',
    '  *)',
    '    show_help',
    '    if [ -n "$ACTION" ]; then',
    '      echo "[提示] 未知操作: $ACTION"',
    '      echo ""',
    '    fi',
    '    echo "请选择操作:"',
    '    echo "  1) 安装 Agent"',
    '    echo "  2) 卸载 Agent"',
    '    echo ""',
    '    read -p "请输入选项 [1/2]: " CHOICE',
    '    case "$CHOICE" in',
    '      1)',
    '        read -p "请输入 Agent Token: " INPUT_TOKEN',
    '        read -p "请输入面板地址 [$PANEL_URL]: " INPUT_URL',
    '        if [ -n "$INPUT_URL" ]; then',
    '          PANEL_URL="$INPUT_URL"',
    '        fi',
    '        do_install "$INPUT_TOKEN"',
    '        ;;',
    '      2)',
    '        do_uninstall',
    '        ;;',
    '      *)',
    '        echo "[错误] 无效选项"',
    '        exit 1',
    '        ;;',
    '    esac',
    '    ;;',
    'esac',
  ];
  return lines.join('\n') + '\n';
}

// Generate full install script as a plain string
export function generateFullInstallScript(panelUrl: string, token: string): string {
  const lines = [
    '#!/bin/bash',
    'set -e',
    '',
    'PANEL_URL="' + panelUrl + '"',
    'AGENT_TOKEN="' + token + '"',
    'INSTALL_DIR="/opt/forwardx-agent"',
    'SERVICE_NAME="forwardx-agent"',
    '',
    'echo "======================================"',
    'echo "  ForwardX Agent 一键安装脚本"',
    'echo "======================================"',
    'echo ""',
    '',
    'if [ "$(id -u)" != "0" ]; then',
    '  echo "[错误] 请使用 root 权限运行此脚本"',
    '  exit 1',
    'fi',
    '',
    '# 检查是否已安装',
    'if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then',
    '  echo "[信息] 检测到已安装的 Agent 服务，将进行更新..."',
    '  systemctl stop "$SERVICE_NAME"',
    'fi',
    '',
    'OS_INFO=$(cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d\'"\' -f2 || uname -s)',
    'CPU_INFO=$(grep "model name" /proc/cpuinfo 2>/dev/null | head -1 | cut -d\':\' -f2 | xargs || uname -m)',
    'MEM_TOTAL=$(grep MemTotal /proc/meminfo 2>/dev/null | awk \'{print $2}\' || echo "0")',
    'MEM_TOTAL_BYTES=$((MEM_TOTAL * 1024))',
    'PUBLIC_IP=$(curl -s --max-time 5 ifconfig.me || curl -s --max-time 5 icanhazip.com || echo "unknown")',
    '',
    'echo "[信息] 系统: $OS_INFO"',
    'echo "[信息] CPU: $CPU_INFO"',
    'echo "[信息] 内存: $((MEM_TOTAL / 1024)) MB"',
    'echo "[信息] 公网IP: $PUBLIC_IP"',
    'echo ""',
    '',
    'echo "[步骤 1/5] 安装依赖..."',
    'if [ "$(id -u)" -ne 0 ]; then echo "[错误] 必须以 root 运行"; exit 1; fi',
    'if command -v apt-get >/dev/null 2>&1; then',
    '  export DEBIAN_FRONTEND=noninteractive',
    '  apt-get update -qq && apt-get install -y -qq curl jq socat iptables iproute2 coreutils tar systemd >/dev/null 2>&1 || true',
    'elif command -v dnf >/dev/null 2>&1; then',
    '  dnf install -y -q curl jq socat iptables iproute coreutils tar systemd >/dev/null 2>&1 || true',
    'elif command -v yum >/dev/null 2>&1; then',
    '  yum install -y -q curl jq socat iptables iproute coreutils tar systemd >/dev/null 2>&1 || true',
    'elif command -v zypper >/dev/null 2>&1; then',
    '  zypper -n install curl jq socat iptables iproute2 coreutils tar systemd >/dev/null 2>&1 || true',
    'elif command -v apk >/dev/null 2>&1; then',
    '  apk add --no-cache curl jq socat iptables iproute2 coreutils tar openrc >/dev/null 2>&1 || true',
    'fi',
    'for B in curl jq iptables base64; do',
    '  if ! command -v $B >/dev/null 2>&1; then echo "[错误] 未能安装依赖: $B"; exit 1; fi',
    'done',
    '',
    'echo "[步骤 2/5] 安装 realm 与启用内核转发..."',
    '# 永久化开启 IPv4 转发',
    'sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true',
    'if ! grep -qE "^\\s*net\\.ipv4\\.ip_forward\\s*=\\s*1" /etc/sysctl.conf 2>/dev/null; then',
    '  echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf',
    'fi',
    'sysctl -p >/dev/null 2>&1 || true',
    'if ! command -v realm &>/dev/null; then',
    '  REALM_VERSION="v2.6.0"',
    '  ARCH=$(uname -m)',
    '  case $ARCH in',
    '    x86_64) REALM_ARCH="x86_64-unknown-linux-gnu" ;;',
    '    aarch64) REALM_ARCH="aarch64-unknown-linux-gnu" ;;',
    '    *) echo "[警告] 不支持的架构: $ARCH, 跳过 realm 安装"; REALM_ARCH="" ;;',
    '  esac',
    '  if [ -n "$REALM_ARCH" ]; then',
    '    curl -sL "https://github.com/zhboner/realm/releases/download/$REALM_VERSION/realm-$REALM_ARCH.tar.gz" -o /tmp/realm.tar.gz && \\',
    '    tar -xzf /tmp/realm.tar.gz -C /usr/local/bin/ && \\',
    '    chmod +x /usr/local/bin/realm && \\',
    '    rm -f /tmp/realm.tar.gz && \\',
    '    echo "[信息] realm 安装成功" || echo "[警告] realm 安装失败，将仅使用 iptables/socat"',
    '  fi',
    'else',
    '  echo "[信息] realm 已安装"',
    'fi',
    '',
    'echo "[步骤 3/5] 创建 Agent 程序..."',
    'mkdir -p "$INSTALL_DIR"',
    '',
    "cat > \"$INSTALL_DIR/agent.sh\" << 'AGENT_EOF'",
    '#!/bin/bash',
    'PANEL_URL="__PANEL_URL__"',
    'AGENT_TOKEN="__AGENT_TOKEN__"',
    'HEARTBEAT_INTERVAL=30',
    'SELFTEST_POLL_INTERVAL=3',
    'STATE_DIR="/var/lib/forwardx-agent"',
    'mkdir -p "$STATE_DIR"',
    '',
    '# 自动检测默认出口网卡（用于 tc 限速等）',
    'detect_default_iface() {',
    '  DEV=$(ip route show default 2>/dev/null | awk \'{print $5; exit}\')',
    '  echo "${DEV:-eth0}"',
    '}',
    '',
    '# 上报规则运行状态 isRunning=true|false',
    'report_rule_status() {',
    '  RULE_ID="$1"',
    '  RUNNING="$2"',
    '  curl -s --max-time 10 -X POST "$PANEL_URL/api/agent/rule-status" \\',
    '    -H "Content-Type: application/json" \\',
    '    -H "Authorization: Bearer $AGENT_TOKEN" \\',
    '    -d "{\\"ruleId\\":$RULE_ID,\\"isRunning\\":$RUNNING}" >/dev/null 2>&1',
    '}',
    '',
    '# 检测本机是否在监听指定端口',
    'check_port_listen() {',
    '  PORT="$1"',
    '  PROTO="$2"   # tcp/udp/both',
    '  FORWARD_TYPE="$3"  # iptables/realm/socat',
    '  if [ "$FORWARD_TYPE" = "iptables" ]; then',
    '    if iptables -t nat -S PREROUTING 2>/dev/null | grep -E " --dport ${PORT} " >/dev/null 2>&1; then',
    '      return 0',
    '    fi',
    '    return 1',
    '  fi',
    '  # realm/socat: 用户态监听检测',
    '  if command -v ss >/dev/null 2>&1; then',
    '    if [ "$PROTO" = "udp" ]; then',
    '      ss -lun 2>/dev/null | awk \'{print $5}\' | grep -E "[:.]${PORT}$" >/dev/null 2>&1 && return 0',
    '    elif [ "$PROTO" = "both" ]; then',
    '      ( ss -ltn 2>/dev/null; ss -lun 2>/dev/null ) | awk \'{print $5}\' | grep -E "[:.]${PORT}$" >/dev/null 2>&1 && return 0',
    '    else',
    '      ss -ltn 2>/dev/null | awk \'{print $5}\' | grep -E "[:.]${PORT}$" >/dev/null 2>&1 && return 0',
    '    fi',
    '    return 1',
    '  fi',
    '  if command -v netstat >/dev/null 2>&1; then',
    '    netstat -ln 2>/dev/null | awk \'{print $4}\' | grep -E "[:.]${PORT}$" >/dev/null 2>&1 && return 0',
    '    return 1',
    '  fi',
    '  return 1',
    '}',
    '',
    '# ============ 流量采集 ============',
    '# iptables/realm 转发：数据包走 FORWARD 链（DNAT 后 dst 已变为 targetIp:targetPort）',
    '# socat 转发：数据包走 INPUT 链（用户态进程接收后转发），出站走 OUTPUT 链',
    '',
    '# 为 iptables/realm 转发规则创建计数链（挂在 FORWARD 链上）',
    'ensure_traffic_chain_forward() {',
    '  PORT="$1"',
    '  PROTO="$2"',
    '  TARGET_IP="$3"',
    '  TARGET_PORT="$4"',
    '  CHAIN_IN="FWX_IN_${PORT}"',
    '  CHAIN_OUT="FWX_OUT_${PORT}"',
    '  # 创建计数链',
    '  iptables -N "$CHAIN_IN" 2>/dev/null || true',
    '  iptables -N "$CHAIN_OUT" 2>/dev/null || true',
    '  # 入站计数：匹配转发到目标的数据包（DNAT 后 dst 已变为 targetIp:targetPort）',
    '  if [ "$PROTO" = "udp" ]; then',
    '    if ! iptables -C FORWARD -p udp -d "$TARGET_IP" --dport "$TARGET_PORT" -j "$CHAIN_IN" 2>/dev/null; then',
    '      iptables -I FORWARD -p udp -d "$TARGET_IP" --dport "$TARGET_PORT" -j "$CHAIN_IN" 2>/dev/null || true',
    '    fi',
    '    if ! iptables -C FORWARD -p udp -s "$TARGET_IP" --sport "$TARGET_PORT" -j "$CHAIN_OUT" 2>/dev/null; then',
    '      iptables -I FORWARD -p udp -s "$TARGET_IP" --sport "$TARGET_PORT" -j "$CHAIN_OUT" 2>/dev/null || true',
    '    fi',
    '  elif [ "$PROTO" = "both" ]; then',
    '    for P in tcp udp; do',
    '      if ! iptables -C FORWARD -p $P -d "$TARGET_IP" --dport "$TARGET_PORT" -j "$CHAIN_IN" 2>/dev/null; then',
    '        iptables -I FORWARD -p $P -d "$TARGET_IP" --dport "$TARGET_PORT" -j "$CHAIN_IN" 2>/dev/null || true',
    '      fi',
    '      if ! iptables -C FORWARD -p $P -s "$TARGET_IP" --sport "$TARGET_PORT" -j "$CHAIN_OUT" 2>/dev/null; then',
    '        iptables -I FORWARD -p $P -s "$TARGET_IP" --sport "$TARGET_PORT" -j "$CHAIN_OUT" 2>/dev/null || true',
    '      fi',
    '    done',
    '  else',
    '    if ! iptables -C FORWARD -p tcp -d "$TARGET_IP" --dport "$TARGET_PORT" -j "$CHAIN_IN" 2>/dev/null; then',
    '      iptables -I FORWARD -p tcp -d "$TARGET_IP" --dport "$TARGET_PORT" -j "$CHAIN_IN" 2>/dev/null || true',
    '    fi',
    '    if ! iptables -C FORWARD -p tcp -s "$TARGET_IP" --sport "$TARGET_PORT" -j "$CHAIN_OUT" 2>/dev/null; then',
    '      iptables -I FORWARD -p tcp -s "$TARGET_IP" --sport "$TARGET_PORT" -j "$CHAIN_OUT" 2>/dev/null || true',
    '    fi',
    '  fi',
    '  # 清理旧版不带 -p 的规则（兼容升级）',
    '  iptables -D FORWARD -d "$TARGET_IP" --dport "$TARGET_PORT" -j "$CHAIN_IN" 2>/dev/null || true',
    '  iptables -D FORWARD -s "$TARGET_IP" --sport "$TARGET_PORT" -j "$CHAIN_OUT" 2>/dev/null || true',
    '  # 清理旧版 INPUT 链上的计数规则（兼容升级）',
    '  iptables -D INPUT -p tcp --dport "$PORT" -j "FWX_${PORT}" 2>/dev/null || true',
    '  iptables -D INPUT -p udp --dport "$PORT" -j "FWX_${PORT}" 2>/dev/null || true',
    '  iptables -F "FWX_${PORT}" 2>/dev/null || true',
    '  iptables -X "FWX_${PORT}" 2>/dev/null || true',
    '}',
    '',
    '# 为 socat 转发规则创建计数链（挂在 INPUT/OUTPUT 链上，按 sourcePort 匹配）',
    'ensure_traffic_chain_socat() {',
    '  PORT="$1"',
    '  PROTO="$2"',
    '  CHAIN_IN="FWX_IN_${PORT}"',
    '  CHAIN_OUT="FWX_OUT_${PORT}"',
    '  iptables -N "$CHAIN_IN" 2>/dev/null || true',
    '  iptables -N "$CHAIN_OUT" 2>/dev/null || true',
    '  if [ "$PROTO" = "udp" ]; then',
    '    if ! iptables -C INPUT -p udp --dport "$PORT" -j "$CHAIN_IN" 2>/dev/null; then',
    '      iptables -I INPUT -p udp --dport "$PORT" -j "$CHAIN_IN" 2>/dev/null || true',
    '    fi',
    '    if ! iptables -C OUTPUT -p udp --sport "$PORT" -j "$CHAIN_OUT" 2>/dev/null; then',
    '      iptables -I OUTPUT -p udp --sport "$PORT" -j "$CHAIN_OUT" 2>/dev/null || true',
    '    fi',
    '  elif [ "$PROTO" = "both" ]; then',
    '    for P in tcp udp; do',
    '      if ! iptables -C INPUT -p $P --dport "$PORT" -j "$CHAIN_IN" 2>/dev/null; then',
    '        iptables -I INPUT -p $P --dport "$PORT" -j "$CHAIN_IN" 2>/dev/null || true',
    '      fi',
    '      if ! iptables -C OUTPUT -p $P --sport "$PORT" -j "$CHAIN_OUT" 2>/dev/null; then',
    '        iptables -I OUTPUT -p $P --sport "$PORT" -j "$CHAIN_OUT" 2>/dev/null || true',
    '      fi',
    '    done',
    '  else',
    '    if ! iptables -C INPUT -p tcp --dport "$PORT" -j "$CHAIN_IN" 2>/dev/null; then',
    '      iptables -I INPUT -p tcp --dport "$PORT" -j "$CHAIN_IN" 2>/dev/null || true',
    '    fi',
    '    if ! iptables -C OUTPUT -p tcp --sport "$PORT" -j "$CHAIN_OUT" 2>/dev/null; then',
    '      iptables -I OUTPUT -p tcp --sport "$PORT" -j "$CHAIN_OUT" 2>/dev/null || true',
    '    fi',
    '  fi',
    '}',
    '',
    'sample_traffic_in() {',
    '  PORT="$1"',
    '  CHAIN="FWX_IN_${PORT}"',
    '  STATS=$(iptables -L "$CHAIN" -v -x -n 2>/dev/null | awk \'NR>2 {pkts+=$1; bytes+=$2} END {print pkts+0" "bytes+0}\')',
    '  if [ -z "$STATS" ]; then echo "0 0"; return; fi',
    '  echo "$STATS"',
    '  iptables -Z "$CHAIN" 2>/dev/null || true',
    '}',
    '',
    'sample_traffic_out() {',
    '  PORT="$1"',
    '  CHAIN="FWX_OUT_${PORT}"',
    '  STATS=$(iptables -L "$CHAIN" -v -x -n 2>/dev/null | awk \'NR>2 {pkts+=$1; bytes+=$2} END {print pkts+0" "bytes+0}\')',
    '  if [ -z "$STATS" ]; then echo "0 0"; return; fi',
    '  echo "$STATS"',
    '  iptables -Z "$CHAIN" 2>/dev/null || true',
    '}',
    '',
    '# 确保 realm 已安装',
    'ensure_realm() {',
    '  if [ -x /usr/local/bin/realm ]; then return 0; fi',
    '  echo "[$(date)] [agent] realm 未安装，开始下载..."',
    '  ARCH=$(uname -m)',
    '  case "$ARCH" in',
    '    x86_64|amd64) RARCH="x86_64-unknown-linux-gnu";;',
    '    aarch64|arm64) RARCH="aarch64-unknown-linux-gnu";;',
    '    *) echo "[agent] 不支持的架构: $ARCH"; return 1;;',
    '  esac',
    '  TMP=$(mktemp -d)',
    '  URL="https://github.com/zhboner/realm/releases/latest/download/realm-${RARCH}.tar.gz"',
    '  if curl -fsSL --max-time 60 "$URL" -o "$TMP/realm.tgz"; then',
    '    tar -xzf "$TMP/realm.tgz" -C "$TMP" 2>/dev/null || true',
    '    REALM_BIN=$(find "$TMP" -type f -name realm | head -n1)',
    '    if [ -n "$REALM_BIN" ]; then',
    '      install -m 0755 "$REALM_BIN" /usr/local/bin/realm',
    '      rm -rf "$TMP"',
    '      echo "[$(date)] [agent] realm 安装完成"',
    '      return 0',
    '    fi',
    '  fi',
    '  rm -rf "$TMP"',
    '  echo "[$(date)] [agent] realm 下载失败"',
    '  return 1',
    '}',
    '',
    '# 转发自测',
    'check_target_reachable() {',
    '  IP="$1"; PORT="$2"; PROTO="$3"',
    '  if command -v nc >/dev/null 2>&1; then',
    '    if [ "$PROTO" = "udp" ]; then',
    '      echo | nc -u -n -w 1 "$IP" "$PORT" >/dev/null 2>&1 && return 0 || return 1',
    '    fi',
    '    nc -z -n -w 1 "$IP" "$PORT" >/dev/null 2>&1 && return 0',
    '    return 1',
    '  fi',
    '  if command -v bash >/dev/null 2>&1; then',
    '    timeout 1 bash -c "</dev/tcp/$IP/$PORT" >/dev/null 2>&1 && return 0',
    '  fi',
    '  return 2',
    '}',
    '',
    'check_loopback_forward() {',
    '  PORT="$1"; PROTO="$2"',
    '  if command -v nc >/dev/null 2>&1; then',
    '    if [ "$PROTO" = "udp" ]; then',
    '      echo | nc -u -n -w 1 127.0.0.1 "$PORT" >/dev/null 2>&1 && return 0 || return 1',
    '    fi',
    '    nc -z -n -w 1 127.0.0.1 "$PORT" >/dev/null 2>&1 && return 0',
    '    return 1',
    '  fi',
    '  timeout 1 bash -c "</dev/tcp/127.0.0.1/$PORT" >/dev/null 2>&1 && return 0',
    '  return 1',
    '}',
    '',
    'report_selftest() {',
    '  TID="$1"; LOK="$2"; TR="$3"; FOK="$4"; LAT="$5"; MSG="$6"',
    '  PAYLOAD=$(jq -n --argjson tid "$TID" --argjson l "$LOK" --argjson t "$TR" --argjson f "$FOK" --argjson lat "${LAT:-0}" --arg msg "$MSG" \'{testId:$tid,listenOk:($l==1),targetReachable:($t==1),forwardOk:($f==1),latencyMs:$lat,message:$msg}\')',
    '  curl -s --max-time 10 -X POST "$PANEL_URL/api/agent/selftest-result" -H "Content-Type: application/json" -H "Authorization: Bearer $AGENT_TOKEN" -d "$PAYLOAD" >/dev/null 2>&1',
    '}',
    '',
    'run_selftests() {',
    '  RESPONSE="$1"',
    '  TC=$(echo "$RESPONSE" | jq \'(.selfTests // []) | length\' 2>/dev/null || echo 0)',
    '  if [ "$TC" -le 0 ] 2>/dev/null; then return; fi',
    '  for i in $(seq 0 $((TC - 1))); do',
    '    TID=$(echo "$RESPONSE" | jq -r ".selfTests[$i].testId")',
    '    FT=$(echo "$RESPONSE" | jq -r ".selfTests[$i].forwardType")',
    '    PR=$(echo "$RESPONSE" | jq -r ".selfTests[$i].protocol")',
    '    SP=$(echo "$RESPONSE" | jq -r ".selfTests[$i].sourcePort")',
    '    TIP=$(echo "$RESPONSE" | jq -r ".selfTests[$i].targetIp")',
    '    TPT=$(echo "$RESPONSE" | jq -r ".selfTests[$i].targetPort")',
    '    LOG=""',
    '    LOK=0; TR=0; FOK=0',
    '    START_TS=$(date +%s%3N 2>/dev/null || echo 0)',
    '    if check_port_listen "$SP" "$PR" "$FT"; then LOK=1; LOG="$LOG\u672c地监听检测通过;"; else LOG="$LOG\u672c地监听检测未通过;"; fi',
    '    PROBE_PR=$PR; if [ "$PR" = "both" ]; then PROBE_PR="tcp"; fi',
    '    if check_target_reachable "$TIP" "$TPT" "$PROBE_PR"; then TR=1; LOG="$LOG目标 $TIP:$TPT 可达;"; else LOG="$LOG目标 $TIP:$TPT 不可达;"; fi',
    '    if check_loopback_forward "$SP" "$PROBE_PR"; then FOK=1; LOG="$LOG本机 127.0.0.1:$SP 贯穿成功;"; else LOG="$LOG本机 127.0.0.1:$SP 贯穿失败;"; fi',
    '    END_TS=$(date +%s%3N 2>/dev/null || echo 0)',
    '    LAT=$((END_TS - START_TS))',
    '    echo "[$(date)] [selftest test=$TID rule_port=$SP] LOK=$LOK TR=$TR FOK=$FOK $LOG"',
    '    report_selftest "$TID" "$LOK" "$TR" "$FOK" "$LAT" "$LOG"',
    '  done',
    '}',
    '',
    '# 将 systemd unit 全文写入 /etc/systemd/system/<name>.service',
    'write_systemd_unit() {',
    '  NAME="$1"',
    '  CONTENT_B64="$2"',
    '  if [ -z "$NAME" ] || [ -z "$CONTENT_B64" ]; then return 1; fi',
    '  echo "$CONTENT_B64" | base64 -d > "/etc/systemd/system/$NAME.service"',
    '}',
    '',
    'apply_actions() {',
    '  RESPONSE="$1"',
    '  ACTION_COUNT=$(echo "$RESPONSE" | jq \'(.actions // []) | length\' 2>/dev/null || echo 0)',
    '  if [ "$ACTION_COUNT" -le 0 ] 2>/dev/null; then return; fi',
    '  for i in $(seq 0 $((ACTION_COUNT - 1))); do',
    '    RID=$(echo "$RESPONSE" | jq -r ".actions[$i].ruleId")',
    '    OP=$(echo "$RESPONSE" | jq -r ".actions[$i].op")',
    '    FT=$(echo "$RESPONSE" | jq -r ".actions[$i].forwardType")',
    '    SP=$(echo "$RESPONSE" | jq -r ".actions[$i].sourcePort")',
    '    PR=$(echo "$RESPONSE" | jq -r ".actions[$i].protocol")',
    '    TIP=$(echo "$RESPONSE" | jq -r ".actions[$i].targetIp // empty")',
    '    TPT=$(echo "$RESPONSE" | jq -r ".actions[$i].targetPort // empty")',
    '    SVC=$(echo "$RESPONSE" | jq -r ".actions[$i].svcName // empty")',
    '    SVC_EXTRA=$(echo "$RESPONSE" | jq -r ".actions[$i].svcNameExtra // empty")',
    '    UNIT_TXT=$(echo "$RESPONSE" | jq -r ".actions[$i].unit // empty")',
    '    UNIT_EXTRA_TXT=$(echo "$RESPONSE" | jq -r ".actions[$i].unitExtra // empty")',
    '    # 从面板下发的网卡名称，为空则自动检测',
    '    IFACE=$(echo "$RESPONSE" | jq -r ".actions[$i].networkInterface // empty")',
    '    if [ -z "$IFACE" ]; then IFACE=$(detect_default_iface); fi',
    '    export NET_IFACE="$IFACE"',
    '    ALL_OK=1',
    '',
    '    # 1) realm apply: 先确保 realm 二进制 + 写入 systemd unit',
    '    if [ "$OP" = "apply" ] && [ "$FT" = "realm" ]; then',
    '      ensure_realm || ALL_OK=0',
    '      if [ -n "$SVC" ] && [ -n "$UNIT_TXT" ]; then',
    '        UNIT_B64=$(printf "%s" "$UNIT_TXT" | base64 -w 0)',
    '        if ! write_systemd_unit "$SVC" "$UNIT_B64"; then ALL_OK=0; fi',
    '      fi',
    '    fi',
    '',
    '    # 1b) socat apply: 写入 systemd unit(s)',
    '    if [ "$OP" = "apply" ] && [ "$FT" = "socat" ]; then',
    '      if [ -n "$SVC" ] && [ -n "$UNIT_TXT" ]; then',
    '        UNIT_B64=$(printf "%s" "$UNIT_TXT" | base64 -w 0)',
    '        if ! write_systemd_unit "$SVC" "$UNIT_B64"; then ALL_OK=0; fi',
    '      fi',
    '      # TCP+UDP 模式有第二个服务',
    '      if [ -n "$SVC_EXTRA" ] && [ -n "$UNIT_EXTRA_TXT" ]; then',
    '        UNIT_B64=$(printf "%s" "$UNIT_EXTRA_TXT" | base64 -w 0)',
    '        if ! write_systemd_unit "$SVC_EXTRA" "$UNIT_B64"; then ALL_OK=0; fi',
    '      fi',
    '      # socat 服务需要 daemon-reload + enable + restart',
    '      systemctl daemon-reload',
    '      if [ -n "$SVC" ]; then',
    '        systemctl enable "$SVC.service" 2>/dev/null || true',
    '        systemctl restart "$SVC.service" 2>/dev/null || ALL_OK=0',
    '      fi',
    '      if [ -n "$SVC_EXTRA" ]; then',
    '        systemctl enable "$SVC_EXTRA.service" 2>/dev/null || true',
    '        systemctl restart "$SVC_EXTRA.service" 2>/dev/null || ALL_OK=0',
    '      fi',
    '    fi',
    '',
    '    # 2) 逐条执行单行 command',
    '    CMD_COUNT=$(echo "$RESPONSE" | jq "(.actions[$i].commands // []) | length" 2>/dev/null || echo 0)',
    '    if [ "$CMD_COUNT" -gt 0 ] 2>/dev/null; then',
    '      for j in $(seq 0 $((CMD_COUNT - 1))); do',
    '        CMD=$(echo "$RESPONSE" | jq -r ".actions[$i].commands[$j]")',
    '        if [ -z "$CMD" ] || [ "$CMD" = "null" ]; then continue; fi',
    '        echo "[$(date)] [rule=$RID op=$OP] 执行: $CMD"',
    '        OUTPUT=$(bash -c "$CMD" 2>&1)',
    '        RC=$?',
    '        if [ -n "$OUTPUT" ]; then echo "$OUTPUT" | head -20; fi',
    '        if [ $RC -ne 0 ]; then',
    '          echo "[$(date)] [rule=$RID] 命令失败 rc=$RC"',
    '          ALL_OK=0',
    '        fi',
    '      done',
    '    fi',
    '',
    '    if [ "$OP" = "apply" ]; then',
    '      sleep 1',
    '      if [ "$ALL_OK" -eq 1 ] && check_port_listen "$SP" "$PR" "$FT"; then',
    '        # 建立流量计数链',
    '        if [ "$FT" = "socat" ]; then',
    '          # socat 是用户态转发，流量走 INPUT/OUTPUT',
    '          ensure_traffic_chain_socat "$SP" "$PR"',
    '        else',
    '          # iptables/realm 走 FORWARD 链',
    '          if [ -n "$TIP" ] && [ -n "$TPT" ]; then',
    '            ensure_traffic_chain_forward "$SP" "$PR" "$TIP" "$TPT"',
    '          fi',
    '        fi',
    '        report_rule_status "$RID" true',
    '        echo "[$(date)] [rule=$RID] apply 成功，已上报 isRunning=true"',
    '      else',
    '        if [ "$FT" = "realm" ] && [ -n "$SVC" ]; then',
    '          systemctl status "$SVC.service" --no-pager 2>&1 | head -20 || true',
    '          journalctl -u "$SVC.service" --no-pager -n 20 2>&1 || true',
    '        fi',
    '        if [ "$FT" = "socat" ] && [ -n "$SVC" ]; then',
    '          systemctl status "$SVC.service" --no-pager 2>&1 | head -20 || true',
    '        fi',
    '        if [ "$FT" = "iptables" ]; then',
    '          iptables -t nat -S PREROUTING 2>/dev/null | grep "--dport $SP" || true',
    '        fi',
    '        echo "[$(date)] [rule=$RID] apply 失败，不上报 isRunning=true"',
    '      fi',
    '    else',
    '      report_rule_status "$RID" false',
    '      echo "[$(date)] [rule=$RID] remove 完成，已上报 isRunning=false"',
    '    fi',
    '  done',
    '}',
    '',
    'collect_traffic() {',
    '  # 遍历所有 FWX_IN_* 计数链，采样入站和出站后上报到面板',
    '  CHAINS=$(iptables -L 2>/dev/null | awk \'/^Chain FWX_IN_/ {print $2}\')',
    '  STATS_JSON="[]"',
    '  for CH in $CHAINS; do',
    '    PORT=${CH#FWX_IN_}',
    '    # 入站采样',
    '    SAMPLE_IN=$(sample_traffic_in "$PORT")',
    '    PKTS_IN=$(echo "$SAMPLE_IN" | awk \'{print $1}\')',
    '    BYTES_IN=$(echo "$SAMPLE_IN" | awk \'{print $2}\')',
    '    # 出站采样',
    '    SAMPLE_OUT=$(sample_traffic_out "$PORT")',
    '    PKTS_OUT=$(echo "$SAMPLE_OUT" | awk \'{print $1}\')',
    '    BYTES_OUT=$(echo "$SAMPLE_OUT" | awk \'{print $2}\')',
    '    CONNS=$((PKTS_IN + PKTS_OUT))',
    '    # 需要 ruleId：从状态文件反查',
    '    RID_FILE="$STATE_DIR/port_${PORT}.rule"',
    '    if [ -f "$RID_FILE" ]; then',
    '      RID=$(cat "$RID_FILE")',
    '      STATS_JSON=$(echo "$STATS_JSON" | jq --argjson rid "$RID" --argjson bi "${BYTES_IN:-0}" --argjson bo "${BYTES_OUT:-0}" --argjson c "${CONNS:-0}" \'. + [{ruleId:$rid,bytesIn:$bi,bytesOut:$bo,connections:$c}]\')',
    '    fi',
    '  done',
    '  if [ "$STATS_JSON" != "[]" ]; then',
    '    curl -s --max-time 10 -X POST "$PANEL_URL/api/agent/traffic" \\',
    '      -H "Content-Type: application/json" \\',
    '      -H "Authorization: Bearer $AGENT_TOKEN" \\',
    '      -d "{\\"stats\\":$STATS_JSON}" >/dev/null 2>&1 || true',
    '  fi',
    '}',
    '',
    'report_status() {',
    '  CPU_USAGE=$(top -bn1 | grep "Cpu(s)" | awk \'{print int($2)}\' 2>/dev/null || echo "0")',
    '  MEM_INFO=$(free | grep Mem)',
    '  MEM_TOTAL=$(echo $MEM_INFO | awk \'{print $2}\')',
    '  MEM_USED=$(echo $MEM_INFO | awk \'{print $3}\')',
    '  MEM_USAGE=$((MEM_USED * 100 / MEM_TOTAL))',
    '  NET_RX=$(cat /proc/net/dev | grep -v lo | tail -n+3 | awk \'{rx+=$2} END {print rx}\' 2>/dev/null || echo "0")',
    '  NET_TX=$(cat /proc/net/dev | grep -v lo | tail -n+3 | awk \'{tx+=$10} END {print tx}\' 2>/dev/null || echo "0")',
    '  DISK_USAGE=$(df / | tail -1 | awk \'{print int($5)}\' 2>/dev/null || echo "0")',
    '  SYS_UPTIME=$(cat /proc/uptime | awk \'{print int($1)}\' 2>/dev/null || echo "0")',
    '',
    '  PAYLOAD=$(jq -n \\',
    '    --arg cpu "$CPU_USAGE" \\',
    '    --arg memUsage "$MEM_USAGE" \\',
    '    --arg memUsed "$((MEM_USED * 1024))" \\',
    '    --arg netIn "$NET_RX" \\',
    '    --arg netOut "$NET_TX" \\',
    '    --arg disk "$DISK_USAGE" \\',
    '    --arg uptime "$SYS_UPTIME" \\',
    "    '{cpuUsage: ($cpu|tonumber), memoryUsage: ($memUsage|tonumber), memoryUsed: ($memUsed|tonumber), networkIn: ($netIn|tonumber), networkOut: ($netOut|tonumber), diskUsage: ($disk|tonumber), uptime: ($uptime|tonumber)}')",
    '',
    '  RESPONSE=$(curl -s --max-time 10 -X POST "$PANEL_URL/api/agent/heartbeat" \\',
    '    -H "Content-Type: application/json" \\',
    '    -H "Authorization: Bearer $AGENT_TOKEN" \\',
    '    -d "$PAYLOAD" 2>/dev/null)',
    '',
    '  if [ -n "$RESPONSE" ]; then',
    '    apply_actions "$RESPONSE"',
    '',
    '    # 从 actions 中更新 port -> ruleId 映射',
    '    AC=$(echo "$RESPONSE" | jq \'(.actions // []) | length\' 2>/dev/null || echo 0)',
    '    if [ "$AC" -gt 0 ] 2>/dev/null; then',
    '      for i in $(seq 0 $((AC - 1))); do',
    '        RID=$(echo "$RESPONSE" | jq -r ".actions[$i].ruleId")',
    '        SP=$(echo "$RESPONSE" | jq -r ".actions[$i].sourcePort")',
    '        OP=$(echo "$RESPONSE" | jq -r ".actions[$i].op")',
    '        if [ "$OP" = "apply" ]; then',
    '          echo "$RID" > "$STATE_DIR/port_${SP}.rule"',
    '        else',
    '          rm -f "$STATE_DIR/port_${SP}.rule"',
    '        fi',
    '      done',
    '    fi',
    '',
    '    # 从 runningRules 中重建所有映射（确保 agent 重启后映射文件不丢失）',
    '    RC=$(echo "$RESPONSE" | jq \'(.runningRules // []) | length\' 2>/dev/null || echo 0)',
    '    if [ "$RC" -gt 0 ] 2>/dev/null; then',
    '      for i in $(seq 0 $((RC - 1))); do',
    '        RID=$(echo "$RESPONSE" | jq -r ".runningRules[$i].ruleId")',
    '        SP=$(echo "$RESPONSE" | jq -r ".runningRules[$i].sourcePort")',
    '        TIP=$(echo "$RESPONSE" | jq -r ".runningRules[$i].targetIp // empty")',
    '        TPT=$(echo "$RESPONSE" | jq -r ".runningRules[$i].targetPort // empty")',
    '        PR=$(echo "$RESPONSE" | jq -r ".runningRules[$i].protocol // empty")',
    '        echo "$RID" > "$STATE_DIR/port_${SP}.rule"',
    '        # 同时确保流量计数链存在（agent 重启后 iptables 规则可能丢失）',
    '        if [ -n "$TIP" ] && [ -n "$TPT" ]; then',
    '          # 检查是否有 FORWARD 链上的计数规则，如果没有则重建',
    '          if ! iptables -L "FWX_IN_${SP}" -n 2>/dev/null | grep -q "Chain"; then',
    '            ensure_traffic_chain_forward "$SP" "$PR" "$TIP" "$TPT"',
    '          fi',
    '        fi',
    '      done',
    '    fi',
    '',
    '    # 执行转发自测',
    '    run_selftests "$RESPONSE"',
    '  fi',
    '  collect_traffic',
    '}',
    '',
    'echo "[Agent] ForwardX Agent 已启动"',
    'echo "[Agent] 面板地址: $PANEL_URL"',
    'echo "[Agent] 心跳间隔: ${HEARTBEAT_INTERVAL}s"',
    '',
    '# 主循环：心跳 30s，期间每 3s 轮询一次软任务下发（转发自测等）',
    'pull_selftests_once() {',
    '  RESPONSE=$(curl -s --max-time 5 -X POST "$PANEL_URL/api/agent/selftest-pull" -H "Authorization: Bearer $AGENT_TOKEN" -d "{}" 2>/dev/null)',
    '  if [ -n "$RESPONSE" ]; then run_selftests "$RESPONSE"; fi',
    '}',
    '',
    'LAST_HEARTBEAT=0',
    'while true; do',
    '  NOW=$(date +%s)',
    '  if [ $((NOW - LAST_HEARTBEAT)) -ge $HEARTBEAT_INTERVAL ]; then',
    '    report_status',
    '    LAST_HEARTBEAT=$NOW',
    '  fi',
    '  pull_selftests_once',
    '  sleep $SELFTEST_POLL_INTERVAL',
    'done',
    'AGENT_EOF',
    '',
    'sed -i "s|__PANEL_URL__|$PANEL_URL|g" "$INSTALL_DIR/agent.sh"',
    'sed -i "s|__AGENT_TOKEN__|$AGENT_TOKEN|g" "$INSTALL_DIR/agent.sh"',
    'chmod +x "$INSTALL_DIR/agent.sh"',
    '',
    'echo "[步骤 4/5] 配置系统服务..."',
    'cat > "/etc/systemd/system/$SERVICE_NAME.service" << EOF',
    '[Unit]',
    'Description=ForwardX Agent',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    'ExecStart=/bin/bash $INSTALL_DIR/agent.sh',
    'Restart=always',
    'RestartSec=10',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    'EOF',
    '',
    'systemctl daemon-reload',
    'systemctl enable "$SERVICE_NAME"',
    'systemctl start "$SERVICE_NAME"',
    '',
    'echo "[步骤 5/5] 注册到面板..."',
    'REGISTER_PAYLOAD=$(jq -n \\',
    '  --arg token "$AGENT_TOKEN" \\',
    '  --arg ip "$PUBLIC_IP" \\',
    '  --arg os "$OS_INFO" \\',
    '  --arg cpu "$CPU_INFO" \\',
    '  --arg mem "$MEM_TOTAL_BYTES" \\',
    "  '{token: $token, ip: $ip, osInfo: $os, cpuInfo: $cpu, memoryTotal: ($mem|tonumber)}')",
    '',
    'curl -s --max-time 10 -X POST "$PANEL_URL/api/agent/register" \\',
    '  -H "Content-Type: application/json" \\',
    '  -d "$REGISTER_PAYLOAD"',
    '',
    'echo ""',
    'echo "======================================"',
    'echo "  ForwardX Agent 安装完成!"',
    'echo "======================================"',
    'echo "  安装目录: $INSTALL_DIR"',
    'echo "  服务名称: $SERVICE_NAME"',
    'echo "  查看状态: systemctl status $SERVICE_NAME"',
    'echo "  查看日志: journalctl -u $SERVICE_NAME -f"',
    'echo "  卸载命令: curl -sL $PANEL_URL/api/agent/install.sh | bash -s -- uninstall"',
    'echo "======================================"',
  ];
  return lines.join('\n') + '\n';
}

// 安装/卸载引导脚本
agentRouter.get("/api/agent/install.sh", async (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(generateInstallScript());
});

// 完整安装脚本（由 Agent 引导脚本调用）
agentRouter.get("/api/agent/full-install.sh", async (req: Request, res: Response) => {
  const token = req.query.token as string;
  if (!token) {
    res.status(400).send("echo '[错误] 缺少 Token 参数'");
    return;
  }

  const panelUrl = `${req.protocol}://${req.get("host")}`;

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(generateFullInstallScript(panelUrl, token));
});

export { agentRouter };
