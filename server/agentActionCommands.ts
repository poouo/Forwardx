import { forwardRuleProtocols } from "@shared/forwardTypes";

type IptablesBinary = "iptables" | "ip6tables";

const iptablesBinaries: IptablesBinary[] = ["iptables", "ip6tables"];

function cleanAddress(value: unknown) {
  return String(value || "").trim().replace(/^\[(.*)\]$/, "$1");
}

function isIpv6Address(value: unknown) {
  return cleanAddress(value).includes(":");
}

function iptablesBinaryForTarget(targetIp: unknown): IptablesBinary {
  return isIpv6Address(targetIp) ? "ip6tables" : "iptables";
}

function ignoreShellFailure(command: string) {
  return `${command}; true`;
}

function iptablesCommand(binary: IptablesBinary, args: string, optional = false) {
  if (binary === "ip6tables") {
    return optional
      ? `if command -v ip6tables >/dev/null 2>&1; then ip6tables ${args}; fi; true`
      : `if command -v ip6tables >/dev/null 2>&1; then ip6tables ${args}; else exit 1; fi`;
  }
  const command = `iptables ${args}`;
  return optional ? ignoreShellFailure(command) : command;
}

function iptablesEnsure(binary: IptablesBinary, table: string | null, rule: string, optional = false) {
  const tableArg = table ? `-t ${table} ` : "";
  const command = `if ${binary} ${tableArg}-C ${rule} 2>/dev/null; then :; else ${binary} ${tableArg}-A ${rule}; fi`;
  if (binary === "ip6tables") {
    return optional
      ? `if command -v ip6tables >/dev/null 2>&1; then ${command}; fi; true`
      : `if command -v ip6tables >/dev/null 2>&1; then ${command}; else exit 1; fi`;
  }
  return optional ? ignoreShellFailure(command) : command;
}

function iptablesDelete(binary: IptablesBinary, table: string | null, rule: string) {
  const tableArg = table ? `-t ${table} ` : "";
  const command = `while ${binary} ${tableArg}-C ${rule} 2>/dev/null; do if ${binary} ${tableArg}-D ${rule} 2>/dev/null; then :; else break; fi; done`;
  if (binary === "ip6tables") {
    return `if command -v ip6tables >/dev/null 2>&1; then ${command}; fi; true`;
  }
  return ignoreShellFailure(command);
}

function iptablesFlush(binary: IptablesBinary, table: string, chain: string) {
  return iptablesCommand(binary, `-t ${table} -F ${chain} 2>/dev/null`, true);
}

function iptablesDeleteChain(binary: IptablesBinary, table: string, chain: string) {
  return iptablesCommand(binary, `-t ${table} -X ${chain} 2>/dev/null`, true);
}

function iptablesDnatTarget(targetIp: unknown, targetPort: unknown) {
  const host = cleanAddress(targetIp);
  return isIpv6Address(host) ? `[${host}]:${Number(targetPort) || 0}` : `${host}:${Number(targetPort) || 0}`;
}

function iptablesDeleteDnatRulesForPort(binary: IptablesBinary, port: number, protocol?: string) {
  const protos = forwardRuleProtocols(protocol, "both");
  const body = protos
    .map((proto) => {
      const awk = `awk '/^-A PREROUTING / && / -p ${proto} / && /--dport ${port}( |$)/ && / -j DNAT / {sub(/^-A/, "-D"); print}'`;
      return `while rule=$(${binary} -t nat -S PREROUTING 2>/dev/null | ${awk} | head -n 1) && [ -n "$rule" ]; do ${binary} -t nat $rule 2>/dev/null || break; done`;
    })
    .join("; ");
  if (binary === "ip6tables") {
    return `if command -v ip6tables >/dev/null 2>&1; then ${body}; fi; true`;
  }
  return ignoreShellFailure(body);
}

function buildIptablesForwardPortCleanupCmds(port: number, protocol?: string) {
  return iptablesBinaries.map((binary) => iptablesDeleteDnatRulesForPort(binary, port, protocol));
}

function nftAddressFamily(targetIp: unknown) {
  return isIpv6Address(targetIp) ? "ip6" : "ip";
}

export function buildCountingChainCmds(port: number, targetIp?: string, targetPort?: number, protocol?: string): string[] {
  const protos = forwardRuleProtocols(protocol, "both");
  const inMarker = `fwx-stat-${port}:in`;
  const outMarker = `fwx-stat-${port}:out`;
  const addStatRule = (binary: IptablesBinary, chain: string, rule: string, marker: string) =>
    iptablesEnsure(binary, "mangle", `${chain} ${rule} -m comment --comment "${marker}"`, true);
  const cmds: string[] = [...buildCountingCleanupCmds(port, targetIp, targetPort, protocol)];
  for (const proto of protos) {
    for (const binary of iptablesBinaries) {
      cmds.push(addStatRule(binary, "PREROUTING", `-p ${proto} --dport ${port}`, inMarker));
      cmds.push(addStatRule(binary, "INPUT", `-p ${proto} --dport ${port}`, inMarker));
      cmds.push(addStatRule(binary, "POSTROUTING", `-p ${proto} --sport ${port}`, outMarker));
      cmds.push(addStatRule(binary, "OUTPUT", `-p ${proto} --sport ${port}`, outMarker));
    }
    if (targetIp && Number(targetPort) > 0) {
      const target = cleanAddress(targetIp);
      const targetBinary = iptablesBinaryForTarget(target);
      cmds.push(addStatRule(targetBinary, "FORWARD", `-p ${proto} -d ${target} --dport ${targetPort}`, inMarker));
      cmds.push(addStatRule(targetBinary, "FORWARD", `-p ${proto} -s ${target} --sport ${targetPort}`, outMarker));
    }
  }
  return cmds;
}

export function buildCountingCleanupCmds(port: number, targetIp?: string, targetPort?: number, protocol?: string): string[] {
  const protos = forwardRuleProtocols(protocol, "both");
  const inMarker = `fwx-stat-${port}:in`;
  const outMarker = `fwx-stat-${port}:out`;
  const cmds: string[] = [];
  for (const binary of iptablesBinaries) {
    cmds.push(
      iptablesDelete(binary, "mangle", `PREROUTING -p tcp --dport ${port} -j FWX_IN_${port}`),
      iptablesDelete(binary, "mangle", `PREROUTING -p udp --dport ${port} -j FWX_IN_${port}`),
      iptablesDelete(binary, "mangle", `POSTROUTING -p tcp --sport ${port} -j FWX_OUT_${port}`),
      iptablesDelete(binary, "mangle", `POSTROUTING -p udp --sport ${port} -j FWX_OUT_${port}`),
      iptablesDelete(binary, "mangle", `INPUT -p tcp --dport ${port} -j FWX_IN_${port}`),
      iptablesDelete(binary, "mangle", `INPUT -p udp --dport ${port} -j FWX_IN_${port}`),
      iptablesDelete(binary, "mangle", `OUTPUT -p tcp --sport ${port} -j FWX_OUT_${port}`),
      iptablesDelete(binary, "mangle", `OUTPUT -p udp --sport ${port} -j FWX_OUT_${port}`),
      iptablesDelete(binary, "mangle", `FORWARD -p tcp -j FWX_IN_${port}`),
      iptablesDelete(binary, "mangle", `FORWARD -p udp -j FWX_IN_${port}`),
      iptablesDelete(binary, "mangle", `FORWARD -p tcp -j FWX_OUT_${port}`),
      iptablesDelete(binary, "mangle", `FORWARD -p udp -j FWX_OUT_${port}`),
      iptablesFlush(binary, "mangle", `FWX_IN_${port}`),
      iptablesDeleteChain(binary, "mangle", `FWX_IN_${port}`),
      iptablesFlush(binary, "mangle", `FWX_OUT_${port}`),
      iptablesDeleteChain(binary, "mangle", `FWX_OUT_${port}`),
    );
  }
  for (const proto of protos) {
    for (const binary of iptablesBinaries) {
      cmds.unshift(iptablesDelete(binary, "mangle", `PREROUTING -p ${proto} --dport ${port} -m comment --comment "${inMarker}"`));
      cmds.unshift(iptablesDelete(binary, "mangle", `INPUT -p ${proto} --dport ${port} -m comment --comment "${inMarker}"`));
      cmds.unshift(iptablesDelete(binary, "mangle", `POSTROUTING -p ${proto} --sport ${port} -m comment --comment "${outMarker}"`));
      cmds.unshift(iptablesDelete(binary, "mangle", `OUTPUT -p ${proto} --sport ${port} -m comment --comment "${outMarker}"`));
    }
    if (targetIp && Number(targetPort) > 0) {
      const target = cleanAddress(targetIp);
      const targetBinary = iptablesBinaryForTarget(target);
      cmds.unshift(iptablesDelete(targetBinary, "mangle", `FORWARD -p ${proto} -d ${target} --dport ${targetPort} -m comment --comment "${inMarker}"`));
      cmds.unshift(iptablesDelete(targetBinary, "mangle", `FORWARD -p ${proto} -s ${target} --sport ${targetPort} -m comment --comment "${outMarker}"`));
      cmds.unshift(iptablesDelete(targetBinary, "mangle", `FORWARD -p ${proto} -d ${target} --dport ${targetPort} -j FWX_IN_${port}`));
      cmds.unshift(iptablesDelete(targetBinary, "mangle", `FORWARD -p ${proto} -s ${target} --sport ${targetPort} -j FWX_OUT_${port}`));
      cmds.unshift(iptablesDelete(targetBinary, "mangle", `OUTPUT -p ${proto} -d ${target} --dport ${targetPort} -j FWX_IN_${port}`));
      cmds.unshift(iptablesDelete(targetBinary, "mangle", `POSTROUTING -p ${proto} -d ${target} --dport ${targetPort} -j FWX_IN_${port}`));
      cmds.unshift(iptablesDelete(targetBinary, "mangle", `PREROUTING -p ${proto} -s ${target} --sport ${targetPort} -j FWX_OUT_${port}`));
      cmds.unshift(iptablesDelete(targetBinary, "mangle", `INPUT -p ${proto} -s ${target} --sport ${targetPort} -j FWX_OUT_${port}`));
    }
  }
  return cmds;
}

const nftTable = "forwardx";
const nftChain = (prefix: string, id: number) => `${prefix}_${id}`;
const nftComment = (rule: any) => `fwx-rule-${Number(rule.id) || 0}`;
const nftTrafficPreroutingChain = "traffic_prerouting";
const nftTrafficPostroutingChain = "traffic_postrouting";
const nftTrafficForwardChain = "traffic_forward";
const nftDirectionComment = (comment: string, direction: "in" | "out") => `${comment}-${direction}`;
const nftDnatMasqueradeComment = "fwx-dnat-masquerade";
const nftIpv6RoutefixChain = "ipv6_routefix";
const nftIpv6RoutefixComment = "fwx-ipv6-dnat-routefix";

function nftOptional(command: string) {
  return `${command} 2>/dev/null; true`;
}

function nftCounterRuleWithFallback(counterRule: string, alternateCounterRule: string, commentedRule: string, bareRule: string, label: string) {
  return `${counterRule} || { echo "[nftables] counter rule failed, fallback=${label}"; ${alternateCounterRule} || { echo "[nftables] alternate counter rule failed, fallback=${label}:comment"; ${commentedRule} || { echo "[nftables] commented rule failed, fallback=${label}:bare"; ${bareRule} || true; }; }; }`;
}

function nftDnatCounterRuleWithFallback(counterRule: string, alternateCounterRule: string, commentedDnatRule: string, bareDnatRule: string, fallbackCounterRule: string, label: string) {
  return `${counterRule} || ${alternateCounterRule} || { echo "[nftables] dnat counter rule failed, fallback=${label}:forward-counter"; (${commentedDnatRule} || ${bareDnatRule}) && { ${fallbackCounterRule}; }; }`;
}

function nftEnsureCommentedRuleCmd(chain: string, comment: string, ruleBody: string) {
  return `if nft list chain inet ${nftTable} ${chain} >/dev/null 2>&1 && nft -a list chain inet ${nftTable} ${chain} 2>/dev/null | awk -v c='comment "${comment}"' 'index($0, c) {found=1} END{exit found ? 0 : 1}'; then :; else nft add rule inet ${nftTable} ${chain} ${ruleBody} comment "${comment}" 2>/dev/null || true; fi; true`;
}

function nftEnsureDnatMasqueradeCmd() {
  return nftEnsureCommentedRuleCmd("postrouting", nftDnatMasqueradeComment, "ct status dnat masquerade");
}

function buildNftIpv6RoutefixCmds(family: string): string[] {
  if (family !== "ip6") return [];
  const routeExists = `command -v ip >/dev/null 2>&1 && ip -6 route show table 100 2>/dev/null | grep -q '^default '`;
  return [
    `if ${routeExists}; then ip -6 rule show 2>/dev/null | grep -Eq 'fwmark (0x64|100).*lookup 100|fwmark (0x64|100).*table 100' || ip -6 rule add fwmark 100 table 100 pref 100 2>/dev/null || true; fi; true`,
    `if ${routeExists}; then nft add chain inet ${nftTable} ${nftIpv6RoutefixChain} '{ type filter hook prerouting priority mangle; policy accept; }' 2>/dev/null || true; ${nftEnsureCommentedRuleCmd(nftIpv6RoutefixChain, nftIpv6RoutefixComment, "ct direction reply ct status dnat ct mark 0 meta mark set 0x64")}; fi; true`,
  ];
}

function buildNftPortCleanupCmds(port: number, protocol?: string): string[] {
  if (!Number(port)) return [];
  const protos = forwardRuleProtocols(protocol, "both");
  return protos.map((proto) => {
    const awk = `awk '/ ${proto} dport ${port}( |$)/ && / dnat / {print $NF}'`;
    return `if nft list chain inet ${nftTable} prerouting >/dev/null 2>&1; then for h in $(nft -a list chain inet ${nftTable} prerouting 2>/dev/null | ${awk}); do nft delete rule inet ${nftTable} prerouting handle "$h" 2>/dev/null; true; done; fi; true`;
  });
}

function buildNftForwardTargetCleanupCmds(rule: any): string[] {
  const targetIp = cleanAddress(rule.targetIp);
  const targetPort = Number(rule.targetPort) || 0;
  if (!targetIp || targetPort <= 0) return [];
  const protos = forwardRuleProtocols(rule.protocol);
  const family = nftAddressFamily(targetIp);
  const cmds: string[] = [];
  for (const proto of protos) {
    const deleteBy = (direction: "daddr" | "saddr", portField: "dport" | "sport") => {
      const awk = `awk -v family='${family}' -v addr='${targetIp}' -v proto='${proto}' -v port='${targetPort}' 'index($0, " comment ") == 0 && index($0, family " ${direction} " addr) && index($0, proto " ${portField} " port) {print $NF}'`;
      return `if nft list chain inet ${nftTable} forward >/dev/null 2>&1; then for h in $(nft -a list chain inet ${nftTable} forward 2>/dev/null | ${awk}); do nft delete rule inet ${nftTable} forward handle "$h" 2>/dev/null; true; done; fi; true`;
    };
    cmds.push(deleteBy("daddr", "dport"));
    cmds.push(deleteBy("saddr", "sport"));
  }
  return cmds;
}

function buildNftPostroutingTargetCleanupCmds(rule: any): string[] {
  const targetIp = cleanAddress(rule.targetIp);
  const targetPort = Number(rule.targetPort) || 0;
  if (!targetIp || targetPort <= 0) return [];
  const protos = forwardRuleProtocols(rule.protocol);
  const family = nftAddressFamily(targetIp);
  return protos.map((proto) => {
    const awk = `awk -v family='${family}' -v addr='${targetIp}' -v proto='${proto}' -v port='${targetPort}' 'index($0, family " daddr " addr) && index($0, proto " dport " port) && index($0, " masquerade") {print $NF}'`;
    return `if nft list chain inet ${nftTable} postrouting >/dev/null 2>&1; then for h in $(nft -a list chain inet ${nftTable} postrouting 2>/dev/null | ${awk}); do nft delete rule inet ${nftTable} postrouting handle "$h" 2>/dev/null; true; done; fi; true`;
  });
}

function nftDeleteCommentedRulesCmd(chain: string, comment: string) {
  return `if nft list table inet ${nftTable} >/dev/null 2>&1; then for h in $(nft -a list chain inet ${nftTable} ${chain} 2>/dev/null | awk -v exact='comment "${comment}"' -v colon='comment "${comment}:' -v dash='comment "${comment}-' 'index($0, exact) || index($0, colon) || index($0, dash) {print $NF}'); do nft delete rule inet ${nftTable} ${chain} handle "$h" 2>/dev/null; true; done; fi; true`;
}

export function buildNftCleanupCmds(rule: any): string[] {
  const ruleId = Number(rule.id) || 0;
  const comment = nftComment(rule);
  return [
    ...buildNftPortCleanupCmds(Number(rule.sourcePort)),
    ...buildNftForwardTargetCleanupCmds(rule),
    ...buildNftPostroutingTargetCleanupCmds(rule),
    nftDeleteCommentedRulesCmd("prerouting", comment),
    nftDeleteCommentedRulesCmd("postrouting", comment),
    nftDeleteCommentedRulesCmd("forward", comment),
    nftDeleteCommentedRulesCmd(nftTrafficPreroutingChain, comment),
    nftDeleteCommentedRulesCmd(nftTrafficPostroutingChain, comment),
    nftDeleteCommentedRulesCmd(nftTrafficForwardChain, comment),
    nftOptional(`nft flush chain inet ${nftTable} ${nftChain("in", ruleId)}`),
    nftOptional(`nft delete chain inet ${nftTable} ${nftChain("in", ruleId)}`),
    nftOptional(`nft flush chain inet ${nftTable} ${nftChain("out", ruleId)}`),
    nftOptional(`nft delete chain inet ${nftTable} ${nftChain("out", ruleId)}`),
    `rm -f /var/lib/forwardx-agent/traffic_${rule.sourcePort}.prev /var/lib/forwardx-agent/port_${rule.sourcePort}.rule /var/lib/forwardx-agent/port_${rule.sourcePort}.fwtype /var/lib/forwardx-agent/target_${rule.sourcePort}.info 2>/dev/null; true`,
  ];
}

export function buildNftForwardCmds(rule: any): string[] {
  const protos = forwardRuleProtocols(rule.protocol);
  const ruleId = Number(rule.id) || 0;
  const comment = nftComment(rule);
  const targetIp = cleanAddress(rule.targetIp);
  const family = nftAddressFamily(targetIp);
  const dnatTarget = family === "ip6" ? `[${targetIp}]:${rule.targetPort}` : `${targetIp}:${rule.targetPort}`;
  const cmds = [
    `command -v nft >/dev/null 2>&1`,
    `sysctl -w net.ipv4.ip_forward=1 >/dev/null`,
    `sysctl -w net.ipv6.conf.all.forwarding=1 >/dev/null 2>&1; true`,
    nftOptional(`nft add table inet ${nftTable}`),
    nftOptional(`nft add chain inet ${nftTable} prerouting '{ type nat hook prerouting priority dstnat; policy accept; }'`),
    nftOptional(`nft add chain inet ${nftTable} postrouting '{ type nat hook postrouting priority srcnat; policy accept; }'`),
    nftOptional(`nft add chain inet ${nftTable} forward '{ type filter hook forward priority filter; policy accept; }'`),
    ...buildNftCleanupCmds(rule),
    nftOptional(`nft add table inet ${nftTable}`),
    nftOptional(`nft add chain inet ${nftTable} prerouting '{ type nat hook prerouting priority dstnat; policy accept; }'`),
    nftOptional(`nft add chain inet ${nftTable} postrouting '{ type nat hook postrouting priority srcnat; policy accept; }'`),
    nftOptional(`nft add chain inet ${nftTable} forward '{ type filter hook forward priority filter; policy accept; }'`),
    nftEnsureDnatMasqueradeCmd(),
    ...buildNftIpv6RoutefixCmds(family),
  ];
  for (const proto of protos) {
    const inComment = nftDirectionComment(comment, "in");
    const outComment = nftDirectionComment(comment, "out");
    const fallbackInCounterRule = nftCounterRuleWithFallback(
      `nft add rule inet ${nftTable} forward meta l4proto ${proto} ${family} daddr ${targetIp} ${proto} dport ${rule.targetPort} counter accept comment "${inComment}"`,
      `nft add rule inet ${nftTable} forward meta l4proto ${proto} ${family} daddr ${targetIp} ${proto} dport ${rule.targetPort} comment "${inComment}" counter accept`,
      `nft add rule inet ${nftTable} forward meta l4proto ${proto} ${family} daddr ${targetIp} ${proto} dport ${rule.targetPort} comment "${inComment}" accept`,
      `nft add rule inet ${nftTable} forward meta l4proto ${proto} ${family} daddr ${targetIp} ${proto} dport ${rule.targetPort} accept`,
      `${inComment}:${proto}`,
    );
    cmds.push(nftDnatCounterRuleWithFallback(
      `nft add rule inet ${nftTable} prerouting meta l4proto ${proto} ${proto} dport ${rule.sourcePort} counter dnat ${family} to ${dnatTarget} comment "${inComment}"`,
      `nft add rule inet ${nftTable} prerouting meta l4proto ${proto} ${proto} dport ${rule.sourcePort} comment "${inComment}" counter dnat ${family} to ${dnatTarget}`,
      `nft add rule inet ${nftTable} prerouting meta l4proto ${proto} ${proto} dport ${rule.sourcePort} comment "${inComment}" dnat ${family} to ${dnatTarget}`,
      `nft add rule inet ${nftTable} prerouting meta l4proto ${proto} ${proto} dport ${rule.sourcePort} dnat ${family} to ${dnatTarget}`,
      fallbackInCounterRule,
      `${inComment}:${proto}`,
    ));
    cmds.push(nftCounterRuleWithFallback(
      `nft add rule inet ${nftTable} forward meta l4proto ${proto} ${family} saddr ${targetIp} ${proto} sport ${rule.targetPort} ct state established,related counter accept comment "${outComment}"`,
      `nft add rule inet ${nftTable} forward meta l4proto ${proto} ${family} saddr ${targetIp} ${proto} sport ${rule.targetPort} ct state established,related comment "${outComment}" counter accept`,
      `nft add rule inet ${nftTable} forward meta l4proto ${proto} ${family} saddr ${targetIp} ${proto} sport ${rule.targetPort} ct state established,related comment "${outComment}" accept`,
      `nft add rule inet ${nftTable} forward meta l4proto ${proto} ${family} saddr ${targetIp} ${proto} sport ${rule.targetPort} accept`,
      `${outComment}:${proto}`,
    ));
    cmds.push(`nft add rule inet ${nftTable} forward meta l4proto ${proto} ${family} daddr ${targetIp} ${proto} dport ${rule.targetPort} accept comment "${comment}"`);
  }
  return cmds;
}

export function buildManagedPortCleanupCmds(port: number, targetIp?: string, targetPort?: number, protocol?: string): string[] {
  return [
    ...buildIptablesForwardPortCleanupCmds(port),
    ...buildNftPortCleanupCmds(port),
    removeManagedServiceCmd(`forwardx-socat-${port}`),
    removeManagedServiceCmd(`forwardx-socat-tcp-${port}`),
    removeManagedServiceCmd(`forwardx-socat-udp-${port}`),
    removeManagedServiceCmd(`forwardx-realm-${port}`),
    `rm -f /etc/forwardx/realm/forwardx-realm-${port}.toml /etc/forwardx/realm/forwardx-realm-${port}.toml.sha256 2>/dev/null || true`,
    `rm -f /var/lib/forwardx-agent/traffic_${port}.prev /var/lib/forwardx-agent/port_${port}.rule /var/lib/forwardx-agent/port_${port}.fwtype /var/lib/forwardx-agent/target_${port}.info 2>/dev/null || true`,
    ...buildCountingCleanupCmds(port, targetIp, targetPort, protocol),
  ];
}

export function buildIptablesForwardCleanupCmds(rule: any): string[] {
  const targetIp = cleanAddress(rule.targetIp);
  const binary = iptablesBinaryForTarget(targetIp);
  const protos = forwardRuleProtocols(rule.protocol);
  const cmds: string[] = buildIptablesForwardPortCleanupCmds(Number(rule.sourcePort));
  for (const proto of protos) {
    cmds.push(iptablesDelete(binary, "nat", `PREROUTING -p ${proto} --dport ${rule.sourcePort} -j DNAT --to-destination ${iptablesDnatTarget(targetIp, rule.targetPort)}`));
    cmds.push(iptablesDelete(binary, "nat", `POSTROUTING -p ${proto} -d ${targetIp} --dport ${rule.targetPort} -j MASQUERADE`));
    cmds.push(iptablesDelete(binary, null, `FORWARD -p ${proto} -d ${targetIp} --dport ${rule.targetPort} -j ACCEPT`));
    cmds.push(iptablesDelete(binary, null, `FORWARD -p ${proto} -s ${targetIp} --sport ${rule.targetPort} ${proto === "tcp" ? "-m state --state ESTABLISHED,RELATED " : ""}-j ACCEPT`));
  }
  return cmds;
}

export function buildIptablesForwardCmds(rule: any): string[] {
  const targetIp = cleanAddress(rule.targetIp);
  const binary = iptablesBinaryForTarget(targetIp);
  const protos = forwardRuleProtocols(rule.protocol);
  const cmds = [
    binary === "ip6tables"
      ? `sysctl -w net.ipv6.conf.all.forwarding=1 >/dev/null`
      : `sysctl -w net.ipv4.ip_forward=1 >/dev/null`,
    ...buildIptablesForwardCleanupCmds(rule),
  ];
  for (const proto of protos) {
    cmds.push(iptablesEnsure(binary, "nat", `PREROUTING -p ${proto} --dport ${rule.sourcePort} -j DNAT --to-destination ${iptablesDnatTarget(targetIp, rule.targetPort)}`));
    cmds.push(iptablesEnsure(binary, "nat", `POSTROUTING -p ${proto} -d ${targetIp} --dport ${rule.targetPort} -j MASQUERADE`));
    cmds.push(iptablesEnsure(binary, null, `FORWARD -p ${proto} -d ${targetIp} --dport ${rule.targetPort} -j ACCEPT`));
    cmds.push(iptablesEnsure(binary, null, `FORWARD -p ${proto} -s ${targetIp} --sport ${rule.targetPort} ${proto === "tcp" ? "-m state --state ESTABLISHED,RELATED " : ""}-j ACCEPT`));
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
  if (!/^[A-Za-z0-9_.@-]+$/.test(name)) throw new Error(`Invalid service name: ${value}`);
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
