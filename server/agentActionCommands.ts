export function ipIfMissing(rule: string) {
  return `iptables -C ${rule} 2>/dev/null || iptables -A ${rule}`;
}

export function ipIfMissingT(table: string, rule: string) {
  return `iptables -t ${table} -C ${rule} 2>/dev/null || iptables -t ${table} -A ${rule}`;
}

export function buildCountingChainCmds(port: number, targetIp?: string, targetPort?: number, protocol?: string): string[] {
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
}

export function buildCountingCleanupCmds(port: number, targetIp?: string, targetPort?: number, protocol?: string): string[] {
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
}

const nftTable = "forwardx";
const nftChain = (prefix: string, id: number) => `${prefix}_${id}`;
const nftComment = (rule: any) => `fwx-rule-${Number(rule.id) || 0}`;
const nftTrafficPreroutingChain = "traffic_prerouting";
const nftTrafficPostroutingChain = "traffic_postrouting";

export function buildNftCleanupCmds(rule: any): string[] {
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
}

export function buildNftForwardCmds(rule: any): string[] {
  const protos = rule.protocol === "both" ? ["tcp", "udp"] : [rule.protocol === "udp" ? "udp" : "tcp"];
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
}

export function buildManagedPortCleanupCmds(port: number, targetIp?: string, targetPort?: number, protocol?: string): string[] {
  return [
    removeManagedServiceCmd(`forwardx-socat-${port}`),
    removeManagedServiceCmd(`forwardx-socat-tcp-${port}`),
    removeManagedServiceCmd(`forwardx-socat-udp-${port}`),
    removeManagedServiceCmd(`forwardx-realm-${port}`),
    `rm -f /var/lib/forwardx-agent/traffic_${port}.prev /var/lib/forwardx-agent/port_${port}.rule /var/lib/forwardx-agent/port_${port}.fwtype /var/lib/forwardx-agent/target_${port}.info 2>/dev/null || true`,
    ...buildCountingCleanupCmds(port, targetIp, targetPort, protocol),
  ];
}

export function buildIptablesForwardCleanupCmds(rule: any): string[] {
  const proto = rule.protocol === "both" ? "tcp" : rule.protocol;
  const cmds = [
    `iptables -t nat -D PREROUTING -p ${proto} --dport ${rule.sourcePort} -j DNAT --to-destination ${rule.targetIp}:${rule.targetPort} 2>/dev/null || true`,
    `iptables -t nat -D POSTROUTING -p ${proto} -d ${rule.targetIp} --dport ${rule.targetPort} -j MASQUERADE 2>/dev/null || true`,
    `iptables -D FORWARD -p ${proto} -d ${rule.targetIp} --dport ${rule.targetPort} -j ACCEPT 2>/dev/null || true`,
    `iptables -D FORWARD -p ${proto} -s ${rule.targetIp} --sport ${rule.targetPort} -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true`,
  ];
  if (rule.protocol === "both") {
    cmds.push(`iptables -t nat -D PREROUTING -p udp --dport ${rule.sourcePort} -j DNAT --to-destination ${rule.targetIp}:${rule.targetPort} 2>/dev/null || true`);
    cmds.push(`iptables -t nat -D POSTROUTING -p udp -d ${rule.targetIp} --dport ${rule.targetPort} -j MASQUERADE 2>/dev/null || true`);
    cmds.push(`iptables -D FORWARD -p udp -d ${rule.targetIp} --dport ${rule.targetPort} -j ACCEPT 2>/dev/null || true`);
    cmds.push(`iptables -D FORWARD -p udp -s ${rule.targetIp} --sport ${rule.targetPort} -j ACCEPT 2>/dev/null || true`);
  }
  return cmds;
}

export function killByPatternCmd(pattern: string) {
  return `for pid in $(pgrep -f '${pattern}' 2>/dev/null || true); do if [ "$pid" = "$$" ] || [ "$pid" = "$PPID" ]; then continue; fi; kill "$pid" 2>/dev/null || true; done`;
}

export function shQuote(value: string) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function serviceName(value: string) {
  const name = String(value || "").trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`Invalid service name: ${value}`);
  return name;
}

function unitExecStart(unit: string) {
  const line = unit.split(/\r?\n/).map((item) => item.trim()).find((item) => item.startsWith("ExecStart="));
  return line ? line.slice("ExecStart=".length).trim() : "";
}

function openRcScript(svcName: string, execStart: string) {
  return [
    "#!/sbin/openrc-run",
    `name="${svcName}"`,
    `description="ForwardX managed service ${svcName}"`,
    'command="/bin/sh"',
    `command_args="-lc ${shQuote(`exec ${execStart}`)}"`,
    "command_background=true",
    'pidfile="/run/${RC_SVCNAME}.pid"',
    'output_log="/var/log/forwardx-agent/${RC_SVCNAME}.log"',
    'error_log="/var/log/forwardx-agent/${RC_SVCNAME}.log"',
    "depend() {",
    "  need net",
    "}",
    "",
  ].join("\n");
}

function sysVScript(svcName: string, execStart: string) {
  return [
    "#!/bin/sh",
    "### BEGIN INIT INFO",
    `# Provides:          ${svcName}`,
    "# Required-Start:    $network",
    "# Required-Stop:     $network",
    "# Default-Start:     2 3 4 5",
    "# Default-Stop:      0 1 6",
    `# Short-Description: ForwardX managed service ${svcName}`,
    "### END INIT INFO",
    `PIDFILE=/run/${svcName}.pid`,
    `LOGFILE=/var/log/forwardx-agent/${svcName}.log`,
    `CMD=${shQuote(`exec ${execStart}`)}`,
    'start() { mkdir -p /run /var/log/forwardx-agent; if [ -s "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then return 0; fi; nohup sh -lc "$CMD" >> "$LOGFILE" 2>&1 & echo $! > "$PIDFILE"; }',
    'stop() { if [ -s "$PIDFILE" ]; then kill "$(cat "$PIDFILE")" 2>/dev/null || true; rm -f "$PIDFILE"; fi; }',
    'case "$1" in',
    "  start) start ;;",
    "  stop) stop ;;",
    "  restart) stop; sleep 1; start ;;",
    '  status) [ -s "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null ;;',
    '  *) echo "Usage: $0 {start|stop|restart|status}"; exit 1 ;;',
    "esac",
    "",
  ].join("\n");
}

export function writeManagedServiceCmd(svcNameRaw: string, unit: string) {
  const svcName = serviceName(svcNameRaw);
  const execStart = unitExecStart(unit);
  if (!execStart) return `echo "[service] ${svcName} missing ExecStart"; exit 1`;
  const unitB64 = Buffer.from(unit, "utf8").toString("base64");
  const openRcB64 = Buffer.from(openRcScript(svcName, execStart), "utf8").toString("base64");
  const sysVB64 = Buffer.from(sysVScript(svcName, execStart), "utf8").toString("base64");
  return `mkdir -p /var/log/forwardx-agent; if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then mkdir -p /etc/systemd/system; printf '%s' '${unitB64}' | base64 -d > /etc/systemd/system/${svcName}.service; systemctl daemon-reload; elif command -v rc-service >/dev/null 2>&1 && command -v rc-update >/dev/null 2>&1; then printf '%s' '${openRcB64}' | base64 -d > /etc/init.d/${svcName}; chmod 755 /etc/init.d/${svcName}; elif [ -d /etc/init.d ]; then printf '%s' '${sysVB64}' | base64 -d > /etc/init.d/${svcName}; chmod 755 /etc/init.d/${svcName}; else echo "[service] unsupported init system for ${svcName}"; exit 1; fi`;
}

export function startManagedServiceCmd(svcNameRaw: string) {
  const svcName = serviceName(svcNameRaw);
  const q = shQuote(svcName);
  return `if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl enable ${q}.service 2>/dev/null || true; systemctl restart ${q}.service || { systemctl status ${q}.service --no-pager -l 2>/dev/null || true; journalctl -u ${q}.service -n 80 --no-pager 2>/dev/null || true; exit 1; }; elif command -v rc-service >/dev/null 2>&1 && command -v rc-update >/dev/null 2>&1; then rc-update add ${q} default >/dev/null 2>&1 || true; rc-service ${q} restart || { rc-service ${q} status 2>/dev/null || true; exit 1; }; elif [ -x /etc/init.d/${svcName} ]; then command -v update-rc.d >/dev/null 2>&1 && update-rc.d ${q} defaults >/dev/null 2>&1 || true; command -v chkconfig >/dev/null 2>&1 && chkconfig ${q} on >/dev/null 2>&1 || true; /etc/init.d/${svcName} restart; else echo "[service] missing init script for ${svcName}"; exit 1; fi`;
}

export function restartManagedServiceIfConfigChangedCmd(svcNameRaw: string, configPath: string) {
  const svcName = serviceName(svcNameRaw);
  const q = shQuote(svcName);
  const config = shQuote(configPath);
  const start = startManagedServiceCmd(svcName);
  const alreadyRunning = `if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl is-active --quiet ${q}.service; elif command -v rc-service >/dev/null 2>&1; then rc-service ${q} status >/dev/null 2>&1; elif [ -x /etc/init.d/${svcName} ]; then /etc/init.d/${svcName} status >/dev/null 2>&1; else false; fi`;
  const configHash = `if command -v sha256sum >/dev/null 2>&1; then sha256sum ${config} 2>/dev/null | awk '{print "sha256:"$1}'; elif command -v cksum >/dev/null 2>&1; then cksum ${config} 2>/dev/null | awk '{print "cksum:"$1":"$2}'; else echo "mtime:$(wc -c < ${config} 2>/dev/null):$(date -r ${config} +%s 2>/dev/null)"; fi`;
  return `new_hash=$(${configHash}); old_hash=$(cat ${config}.sha256 2>/dev/null || true); if [ "$new_hash" != "$old_hash" ] || ! { ${alreadyRunning}; }; then ${start}; [ -n "$new_hash" ] && printf '%s' "$new_hash" > ${config}.sha256; else echo "[service] ${svcName} config unchanged"; fi`;
}

export function stopManagedServiceCmd(svcNameRaw: string) {
  const svcName = serviceName(svcNameRaw);
  const q = shQuote(svcName);
  return `if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl disable ${q}.service 2>/dev/null || true; systemctl stop ${q}.service 2>/dev/null || true; fi; if command -v rc-service >/dev/null 2>&1; then rc-service ${q} stop 2>/dev/null || true; fi; if command -v rc-update >/dev/null 2>&1; then rc-update del ${q} default 2>/dev/null || true; fi; if [ -x /etc/init.d/${svcName} ]; then /etc/init.d/${svcName} stop 2>/dev/null || true; fi`;
}

export function removeManagedServiceCmd(svcNameRaw: string) {
  const svcName = serviceName(svcNameRaw);
  const q = shQuote(svcName);
  return `${stopManagedServiceCmd(svcName)}; rm -f /etc/systemd/system/${svcName}.service /etc/init.d/${svcName}; if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl daemon-reload 2>/dev/null || true; fi; command -v update-rc.d >/dev/null 2>&1 && update-rc.d -f ${q} remove >/dev/null 2>&1 || true; command -v chkconfig >/dev/null 2>&1 && chkconfig ${q} off >/dev/null 2>&1 || true`;
}
