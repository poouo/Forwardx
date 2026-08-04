import { forwardRuleProtocols, normalizeForwardRuleProtocol } from "@shared/forwardTypes";
import { isIP } from "net";

type IptablesBinary = "iptables" | "ip6tables";

const iptablesBinaries: IptablesBinary[] = ["iptables", "ip6tables"];

function cleanAddress(value: unknown) {
  return String(value || "").trim().replace(/^\[(.*)\]$/, "$1");
}

function isIpv6Address(value: unknown) {
  return cleanAddress(value).includes(":");
}

function isIpAddress(value: unknown) {
  return isIP(cleanAddress(value)) !== 0;
}

function iptablesBinaryForTarget(targetIp: unknown): IptablesBinary {
  return isIpv6Address(targetIp) ? "ip6tables" : "iptables";
}

function ignoreShellFailure(command: string) {
  return `${command}; true`;
}
function shellQuote(value: string) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function nftCommentLiteral(comment: string) {
  const escaped = String(comment).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  // nft parses the comment expression after the shell has already consumed
  // normal quotes, so pass the quotes as part of the nft argument.
  return shellQuote(`"${escaped}"`);
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

export type CountingRuleMode = "none" | "kernel" | "process";

export function countingRuleModeForForwardType(forwardType?: string): CountingRuleMode {
  const normalized = String(forwardType || "").trim().toLowerCase();
  if (normalized === "nftables" || normalized === "forwardx" || normalized.startsWith("forwardx-")) return "none";
  if (normalized === "iptables") return "kernel";
  return "process";
}

function iptablesDeleteCountingRules(binary: IptablesBinary, port: number) {
  const tableArg = "-t mangle ";
  const marker = `fwx-stat-${port}:`;
  const inChain = `FWX_IN_${port}`;
  const outChain = `FWX_OUT_${port}`;
  const command = `${binary} ${tableArg}-S 2>/dev/null | awk -v marker=${shellQuote(marker)} -v in_chain=${shellQuote(inChain)} -v out_chain=${shellQuote(outChain)} '/^-A / {chain=$2; position[chain]++; matched=index($0, marker)>0; if (!matched) for (i=1; i<=NF; i++) if ($i==in_chain || $i==out_chain) {matched=1; break} if (matched) {count++; chains[count]=chain; numbers[count]=position[chain]}} END {for (i=count; i>=1; i--) print chains[i], numbers[i]}' | while read -r chain number; do [ -n "$chain" ] && [ -n "$number" ] && ${binary} ${tableArg}-D "$chain" "$number" 2>/dev/null || true; done`;
  if (binary === "ip6tables") {
    return `if command -v ip6tables >/dev/null 2>&1; then ${command}; fi; true`;
  }
  return ignoreShellFailure(command);
}

export function buildCountingChainCmds(port: number, targetIp?: string, targetPort?: number, protocol?: string, forwardType?: string): string[] {
  const protos = forwardRuleProtocols(protocol, "both");
  const inMarker = `fwx-stat-${port}:in`;
  const outMarker = `fwx-stat-${port}:out`;
  const addStatRule = (binary: IptablesBinary, chain: string, rule: string, marker: string) =>
    iptablesEnsure(binary, "mangle", `${chain} ${rule} -m comment --comment "${marker}"`, true);
  const mode = countingRuleModeForForwardType(forwardType);
  // Process runtimes are reconciled by the Agent from runningRules. Keeping
  // these commands out of shared GOST/Nginx reload actions prevents an
  // unrelated DNS target change from rescanning and rebuilding every port's
  // counter rules.
  if (mode === "process") return [];
  const cmds: string[] = [...buildCountingCleanupCmds(port, targetIp, targetPort, protocol)];
  if (mode === "none") return cmds;
  for (const proto of protos) {
    const target = cleanAddress(targetIp);
    if (isIpAddress(target) && Number(targetPort) > 0) {
      const targetBinary = iptablesBinaryForTarget(target);
      const targetRules = [
        // Process forwarders are already isolated by their listener port in
        // the input/output hooks above. Matching only the shared target in
        // those hooks would merge traffic from every proxy instance that
        // dials the same endpoint. Keep target matching for kernel DNAT,
        // where packets traverse FORWARD and conntrack retains the original
        // listener port.
        ["FORWARD", `-p ${proto} -m conntrack --ctorigdstport ${port} -d ${target} --dport ${targetPort}`, inMarker],
        ["FORWARD", `-p ${proto} -m conntrack --ctorigdstport ${port} -s ${target} --sport ${targetPort}`, outMarker],
      ] as const;
      for (const [chain, rule, marker] of targetRules) cmds.push(addStatRule(targetBinary, chain, rule, marker));
    }
  }
  return cmds;
}

export function buildCountingCleanupCmds(port: number, targetIp?: string, targetPort?: number, protocol?: string): string[] {
  const cmds: string[] = [];
  for (const binary of iptablesBinaries) {
    cmds.push(
      iptablesDeleteCountingRules(binary, port),
      iptablesFlush(binary, "mangle", `FWX_IN_${port}`),
      iptablesDeleteChain(binary, "mangle", `FWX_IN_${port}`),
      iptablesFlush(binary, "mangle", `FWX_OUT_${port}`),
      iptablesDeleteChain(binary, "mangle", `FWX_OUT_${port}`),
    );
  }
  // Keep the legacy parameters in the public API so old action builders can
  // call the cleanup helper while upgrading from target-specific layouts.
  void targetIp;
  void targetPort;
  void protocol;
  cmds.push(nftProcessCountingCleanupCmd(port));
  return cmds;
}

const nftTable = "forwardx";
const nftProcessTrafficTable = "forwardx_traffic";
const nftProcessTrafficInputChain = "input";
const nftProcessTrafficOutputChain = "output";
const nftProcessTrafficForwardChain = "forward";
const nftProcessTrafficChains = [
  nftProcessTrafficInputChain,
  nftProcessTrafficOutputChain,
  nftProcessTrafficForwardChain,
];
const nftChain = (prefix: string, id: number) => `${prefix}_${id}`;
const nftComment = (rule: any) => `fwx-rule-${Number(rule.id) || 0}`;
const nftTrafficPreroutingChain = "traffic_prerouting";
const nftTrafficPostroutingChain = "traffic_postrouting";
const nftTrafficForwardChain = "traffic_forward";
const nftDirectionComment = (comment: string, direction: "in" | "out") => `${comment}-${direction}`;
const nftDnatMasqueradeComment = "fwx-dnat-masquerade";
const nftIpv6RoutefixChain = "ipv6_routefix";
const nftIpv6RoutefixComment = "fwx-ipv6-dnat-routefix";

function nftProcessCountingCleanupCmd(port: number) {
  const marker = `fwx-stat-${port}:`;
  return `if command -v nft >/dev/null 2>&1 && nft list table inet ${nftProcessTrafficTable} >/dev/null 2>&1; then for c in ${nftProcessTrafficChains.join(" ")}; do for h in $(nft -a list chain inet ${nftProcessTrafficTable} "$c" 2>/dev/null | awk -v marker=${shellQuote(marker)} 'index($0, marker) {print $NF}'); do nft delete rule inet ${nftProcessTrafficTable} "$c" handle "$h" 2>/dev/null || true; done; done; fi; true`;
}

function nftOptional(command: string) {
  return `${command} 2>/dev/null; true`;
}

function nftCounterRuleWithFallback(counterRule: string, alternateCounterRule: string, commentedRule: string, bareRule: string, label: string) {
  return `${counterRule} || { echo "[nftables] counter rule failed, fallback=${label}"; ${alternateCounterRule} || { echo "[nftables] alternate counter rule failed, fallback=${label}:comment"; ${commentedRule} || { echo "[nftables] commented rule failed, fallback=${label}:bare"; ${bareRule}; }; }; }`;
}

function nftDnatCounterRuleWithFallback(counterRule: string, alternateCounterRule: string, commentedDnatRule: string, bareDnatRule: string, fallbackCounterRule: string, label: string) {
  return `${counterRule} || ${alternateCounterRule} || { echo "[nftables] dnat counter rule failed, fallback=${label}:forward-counter"; (${commentedDnatRule} || ${bareDnatRule}) && { ${fallbackCounterRule}; }; }`;
}

function nftEnsureCommentedRuleCmd(chain: string, comment: string, ruleBody: string) {
  return `if nft list chain inet ${nftTable} ${chain} >/dev/null 2>&1 && nft -a list chain inet ${nftTable} ${chain} 2>/dev/null | awk -v c='comment "${comment}"' 'index($0, c) {found=1} END{exit found ? 0 : 1}'; then :; else nft add rule inet ${nftTable} ${chain} ${ruleBody} comment ${nftCommentLiteral(comment)} 2>/dev/null || true; fi; true`;
}

function nftEnsureCommentedRuleWithFallbackCmd(
  chain: string,
  comment: string,
  ruleBody: string,
  fallbackComment: string,
  fallbackRuleBody: string,
) {
  const hasRule = `nft list chain inet ${nftTable} ${chain} >/dev/null 2>&1 && nft -a list chain inet ${nftTable} ${chain} 2>/dev/null | awk -v c='comment "${comment}"' 'index($0, c) {found=1} END{exit found ? 0 : 1}'`;
  const primary = `nft add rule inet ${nftTable} ${chain} ${ruleBody} comment ${nftCommentLiteral(comment)} 2>/dev/null`;
  const fallback = `nft add rule inet ${nftTable} ${chain} ${fallbackRuleBody} comment ${nftCommentLiteral(fallbackComment)} 2>/dev/null`;
  return `if ${hasRule}; then :; else if ${primary}; then :; else echo "[nftables] rule failed, fallback=${fallbackComment}"; ${fallback}; fi; fi`;
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
    const awk = `awk -v proto='${proto}' -v port='${port}' 'index($0, proto " dport " port) && index($0, " dnat ") {print $NF}'`;
    return `if nft list chain inet ${nftTable} prerouting >/dev/null 2>&1; then for h in $(nft -a list chain inet ${nftTable} prerouting 2>/dev/null | ${awk}); do nft delete rule inet ${nftTable} prerouting handle "$h" 2>/dev/null; true; done; fi; true`;
  });
}

function buildConntrackCleanupCmds(port: number, protocol?: string): string[] {
  if (!Number(port)) return [];
  return forwardRuleProtocols(protocol, "both").map((proto) =>
    `command -v conntrack >/dev/null 2>&1 && conntrack -D -p ${proto} --dport ${port} 2>/dev/null || true`
  );
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

export function buildNftCleanupCmds(rule: any, options: { removeStateFiles?: boolean; cleanupConntrack?: boolean } = {}): string[] {
  const ruleId = Number(rule.id) || 0;
  const comment = nftComment(rule);
  const cmds = [
    ...buildNftPortCleanupCmds(Number(rule.sourcePort), rule.protocol),
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
  ];
  if (options.cleanupConntrack) {
    cmds.push(...buildConntrackCleanupCmds(Number(rule.sourcePort), rule.protocol));
  }
  if (options.removeStateFiles !== false) {
    cmds.push(`rm -f /var/lib/forwardx-agent/traffic_${rule.sourcePort}.prev /var/lib/forwardx-agent/port_${rule.sourcePort}.rule /var/lib/forwardx-agent/port_${rule.sourcePort}.fwtype /var/lib/forwardx-agent/port_${rule.sourcePort}.tunnel /var/lib/forwardx-agent/target_${rule.sourcePort}.info 2>/dev/null; true`);
  }
  return cmds;
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
    `if nft list chain inet ${nftTable} prerouting >/dev/null 2>&1 && nft list chain inet ${nftTable} postrouting >/dev/null 2>&1 && nft list chain inet ${nftTable} forward >/dev/null 2>&1; then :; else echo "[nftables] forwarding chains are unavailable"; exit 1; fi`,
    ...buildNftCleanupCmds(rule),
    nftOptional(`nft add table inet ${nftTable}`),
    nftOptional(`nft add chain inet ${nftTable} prerouting '{ type nat hook prerouting priority dstnat; policy accept; }'`),
    nftOptional(`nft add chain inet ${nftTable} postrouting '{ type nat hook postrouting priority srcnat; policy accept; }'`),
    nftOptional(`nft add chain inet ${nftTable} forward '{ type filter hook forward priority filter; policy accept; }'`),
    ...buildNftIpv6RoutefixCmds(family),
  ];
  for (const proto of protos) {
    const inComment = nftDirectionComment(comment, "in");
    const outComment = nftDirectionComment(comment, "out");
    const originalPortMatch = `ct original proto-dst ${rule.sourcePort}`;
    const targetOnlyInAccept = `nft add rule inet ${nftTable} forward meta l4proto ${proto} ${family} daddr ${targetIp} ${proto} dport ${rule.targetPort} accept comment ${nftCommentLiteral(inComment)}`;
    const targetOnlyOutAccept = `nft add rule inet ${nftTable} forward meta l4proto ${proto} ${family} saddr ${targetIp} ${proto} sport ${rule.targetPort} ct state established,related accept comment ${nftCommentLiteral(outComment)}`;
    const fallbackInCounterRule = nftCounterRuleWithFallback(
      `nft add rule inet ${nftTable} forward meta l4proto ${proto} ${family} daddr ${targetIp} ${proto} dport ${rule.targetPort} ${originalPortMatch} counter accept comment ${nftCommentLiteral(inComment)}`,
      `nft add rule inet ${nftTable} forward meta l4proto ${proto} ${family} daddr ${targetIp} ${proto} dport ${rule.targetPort} ${originalPortMatch} comment ${nftCommentLiteral(inComment)} counter accept`,
      `nft add rule inet ${nftTable} forward meta l4proto ${proto} ${family} daddr ${targetIp} ${proto} dport ${rule.targetPort} ${originalPortMatch} comment ${nftCommentLiteral(inComment)} accept`,
      targetOnlyInAccept,
      `${inComment}:${proto}`,
    );
    cmds.push(nftEnsureCommentedRuleWithFallbackCmd(
      "postrouting",
      nftDnatMasqueradeComment,
      "ct status dnat masquerade",
      `${comment}-masquerade-${proto}`,
      `meta l4proto ${proto} ${family} daddr ${targetIp} ${proto} dport ${rule.targetPort} masquerade`,
    ));
    cmds.push(nftDnatCounterRuleWithFallback(
      `nft add rule inet ${nftTable} prerouting meta l4proto ${proto} ${proto} dport ${rule.sourcePort} counter dnat ${family} to ${dnatTarget} comment ${nftCommentLiteral(inComment)}`,
      `nft add rule inet ${nftTable} prerouting meta l4proto ${proto} ${proto} dport ${rule.sourcePort} comment ${nftCommentLiteral(inComment)} counter dnat ${family} to ${dnatTarget}`,
      `nft add rule inet ${nftTable} prerouting meta l4proto ${proto} ${proto} dport ${rule.sourcePort} comment ${nftCommentLiteral(inComment)} dnat ${family} to ${dnatTarget}`,
      `nft add rule inet ${nftTable} prerouting meta l4proto ${proto} ${proto} dport ${rule.sourcePort} dnat ${family} to ${dnatTarget}`,
      fallbackInCounterRule,
      `${inComment}:${proto}`,
    ));
    cmds.push(nftCounterRuleWithFallback(
      `nft add rule inet ${nftTable} forward meta l4proto ${proto} ${family} saddr ${targetIp} ${proto} sport ${rule.targetPort} ${originalPortMatch} ct state established,related counter accept comment ${nftCommentLiteral(outComment)}`,
      `nft add rule inet ${nftTable} forward meta l4proto ${proto} ${family} saddr ${targetIp} ${proto} sport ${rule.targetPort} ${originalPortMatch} ct state established,related comment ${nftCommentLiteral(outComment)} counter accept`,
      `nft add rule inet ${nftTable} forward meta l4proto ${proto} ${family} saddr ${targetIp} ${proto} sport ${rule.targetPort} ${originalPortMatch} ct state established,related comment ${nftCommentLiteral(outComment)} accept`,
      targetOnlyOutAccept,
      `${outComment}:${proto}`,
    ));
    cmds.push(`nft add rule inet ${nftTable} forward meta l4proto ${proto} ${family} daddr ${targetIp} ${proto} dport ${rule.targetPort} ${originalPortMatch} accept comment ${nftCommentLiteral(comment)} || { echo "[nftables] forward selector failed, fallback=fwx-rule-${ruleId}"; ${targetOnlyInAccept}; }`);
  }
  return cmds;
}

export function buildManagedPortCleanupCmds(port: number, targetIp?: string, targetPort?: number, protocol?: string): string[] {
  const normalizedProtocol = normalizeForwardRuleProtocol(protocol, "both");
  const protocols = forwardRuleProtocols(protocol, "both");
  const legacyServiceCleanup = normalizedProtocol === "both"
    ? [
        removeManagedServiceCmd(`forwardx-socat-${port}`),
        removeManagedServiceCmd(`forwardx-realm-${port}`),
        `rm -f /etc/forwardx/realm/forwardx-realm-${port}.toml /etc/forwardx/realm/forwardx-realm-${port}.toml.sha256 2>/dev/null || true`,
      ]
    : [];
  return [
    ...buildIptablesForwardPortCleanupCmds(port, protocol),
    ...buildNftPortCleanupCmds(port, protocol),
    ...legacyServiceCleanup,
    ...protocols.map((proto) => removeManagedServiceCmd(`forwardx-socat-${proto}-${port}`)),
    removeManagedServiceCmd(`forwardx-realm-${normalizedProtocol}-${port}`),
    `rm -f /etc/forwardx/realm/forwardx-realm-${normalizedProtocol}-${port}.toml /etc/forwardx/realm/forwardx-realm-${normalizedProtocol}-${port}.toml.sha256 2>/dev/null || true`,
    `rm -f /var/lib/forwardx-agent/traffic_${port}.prev /var/lib/forwardx-agent/port_${port}.rule /var/lib/forwardx-agent/port_${port}.fwtype /var/lib/forwardx-agent/port_${port}.tunnel /var/lib/forwardx-agent/target_${port}.info 2>/dev/null || true`,
    ...buildCountingCleanupCmds(port, targetIp, targetPort, protocol),
  ];
}

export function buildIptablesForwardCleanupCmds(rule: any): string[] {
  const targetIp = cleanAddress(rule.targetIp);
  const binary = iptablesBinaryForTarget(targetIp);
  const protos = forwardRuleProtocols(rule.protocol);
  const cmds: string[] = buildIptablesForwardPortCleanupCmds(Number(rule.sourcePort), rule.protocol);
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

export function hardenManagedServiceUnit(unit: string) {
  const lines = String(unit || "").replace(/\r\n/g, "\n").split("\n");
  const serviceIndex = lines.findIndex((line) => line.trim().toLowerCase() === "[service]");
  if (serviceIndex < 0) return unit;
  const existing = new Set<string>();
  for (let index = serviceIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith("[") && line.endsWith("]")) break;
    const separator = line.indexOf("=");
    if (separator > 0) existing.add(line.slice(0, separator).trim().toLowerCase());
  }
  const directives = [
    "LimitCORE=0",
    "LogRateLimitIntervalSec=30s",
    "LogRateLimitBurst=200",
  ].filter((directive) => !existing.has(directive.slice(0, directive.indexOf("=")).toLowerCase()));
  if (directives.length === 0) return lines.join("\n");
  lines.splice(serviceIndex + 1, 0, ...directives);
  return lines.join("\n");
}

function openRcScript(svcName: string, execStart: string) {
  return [
    "#!/sbin/openrc-run",
    `name="${svcName}"`,
    `description="ForwardX managed service ${svcName}"`,
    'command="/bin/sh"',
    `command_args="-lc ${shQuote(`ulimit -c 0 2>/dev/null || true; exec ${execStart}`)}"`,
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
    `CMD=${shQuote(`ulimit -c 0 2>/dev/null || true; exec ${execStart}`)}`,
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
  const boundedUnit = hardenManagedServiceUnit(unit);
  const execStart = unitExecStart(boundedUnit);
  if (!execStart) return `echo "[service] ${svcName} missing ExecStart"; exit 1`;
  const q = shQuote(svcName);
  const unitB64 = Buffer.from(boundedUnit, "utf8").toString("base64");
  const openRcB64 = Buffer.from(openRcScript(svcName, execStart), "utf8").toString("base64");
  const sysVB64 = Buffer.from(sysVScript(svcName, execStart), "utf8").toString("base64");
  return `mkdir -p /var/log/forwardx-agent; if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then mkdir -p /etc/systemd/system; unit_path=/etc/systemd/system/${svcName}.service; unit_tmp="$unit_path.forwardx-new.$$"; printf '%s' '${unitB64}' | base64 -d > "$unit_tmp" || { rm -f "$unit_tmp"; exit 1; }; if [ ! -f "$unit_path" ] || ! cmp -s "$unit_tmp" "$unit_path"; then mv -f "$unit_tmp" "$unit_path"; chmod 644 "$unit_path"; systemctl daemon-reload; else rm -f "$unit_tmp"; fi; systemctl reset-failed ${q}.service 2>/dev/null || true; elif command -v rc-service >/dev/null 2>&1 && command -v rc-update >/dev/null 2>&1; then script_path=/etc/init.d/${svcName}; script_tmp="$script_path.forwardx-new.$$"; printf '%s' '${openRcB64}' | base64 -d > "$script_tmp" || { rm -f "$script_tmp"; exit 1; }; if [ ! -f "$script_path" ] || ! cmp -s "$script_tmp" "$script_path"; then mv -f "$script_tmp" "$script_path"; chmod 755 "$script_path"; else rm -f "$script_tmp"; fi; elif [ -d /etc/init.d ]; then script_path=/etc/init.d/${svcName}; script_tmp="$script_path.forwardx-new.$$"; printf '%s' '${sysVB64}' | base64 -d > "$script_tmp" || { rm -f "$script_tmp"; exit 1; }; if [ ! -f "$script_path" ] || ! cmp -s "$script_tmp" "$script_path"; then mv -f "$script_tmp" "$script_path"; chmod 755 "$script_path"; else rm -f "$script_tmp"; fi; else echo "[service] unsupported init system for ${svcName}"; exit 1; fi`;
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

function mimicInterfaceName(value: string) {
  const name = String(value || "").trim();
  if (!/^[A-Za-z0-9_.:-]+$/.test(name) || name === "." || name === "..") {
    throw new Error(`Invalid network interface name: ${value}`);
  }
  return name;
}

/**
 * Mimic's package service does not detach stale XDP programs or lock files.
 * Do that only when the managed config really needs a restart, then retry in
 * skb mode when native XDP cannot attach on a particular VPS NIC.
 */
export function restartMimicServiceIfConfigChangedCmd(svcNameRaw: string, configPath: string, ifaceRaw: string) {
  const svcName = serviceName(svcNameRaw);
  const iface = mimicInterfaceName(ifaceRaw);
  const q = shQuote(svcName);
  const config = shQuote(configPath);
  const modeState = shQuote(`${configPath}.forwardx-xdp-mode`);
  const qIface = shQuote(iface);
  const dropInDir = `/etc/systemd/system/${svcName}.service.d`;
  const dropInPath = `${dropInDir}/forwardx-bpf.conf`;
  const dropIn = [
    "[Service]",
    "CapabilityBoundingSet=CAP_SYS_ADMIN CAP_NET_ADMIN CAP_NET_BIND_SERVICE CAP_NET_RAW CAP_BPF",
    "AmbientCapabilities=CAP_SYS_ADMIN CAP_NET_ADMIN CAP_NET_BIND_SERVICE CAP_NET_RAW CAP_BPF",
    "NoNewPrivileges=no",
    "",
  ].join("\n");
  const configHash = `if command -v sha256sum >/dev/null 2>&1; then sha256sum ${config} 2>/dev/null | awk '{print "sha256:"$1}'; elif command -v cksum >/dev/null 2>&1; then cksum ${config} 2>/dev/null | awk '{print "cksum:"$1":"$2}'; else echo "mtime:$(wc -c < ${config} 2>/dev/null):$(date -r ${config} +%s 2>/dev/null)"; fi`;
  const alreadyRunning = `if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl is-active --quiet ${q}.service; elif command -v rc-service >/dev/null 2>&1; then rc-service ${q} status >/dev/null 2>&1; elif [ -x /etc/init.d/${svcName} ]; then /etc/init.d/${svcName} status >/dev/null 2>&1; else false; fi`;
  const ensureBpfDropIn = [
    `mimic_dropin_changed=0`,
    `if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then`,
    `  mkdir -p ${shQuote(dropInDir)}`,
    `  mimic_dropin_tmp=${shQuote(`${dropInPath}.tmp`)}.$$`,
    `  printf '%s' ${shQuote(dropIn)} > "$mimic_dropin_tmp"`,
    `  if [ ! -f ${shQuote(dropInPath)} ] || ! cmp -s "$mimic_dropin_tmp" ${shQuote(dropInPath)}; then`,
    `    mv -f "$mimic_dropin_tmp" ${shQuote(dropInPath)}`,
    `    chmod 644 ${shQuote(dropInPath)}`,
    `    systemctl daemon-reload`,
    `    mimic_dropin_changed=1`,
    `  else`,
    `    rm -f "$mimic_dropin_tmp"`,
    `  fi`,
    `fi`,
  ].join("\n");
  const setXdpMode = [
    `mimic_set_xdp_mode() {`,
    `  mimic_mode_tmp=${config}.xdp.$$`,
    `  awk -v mode="$1" '/^[[:space:]]*xdp_mode[[:space:]]*=/ { if (!done) print "xdp_mode = " mode; done=1; next } { print } END { if (!done) print "xdp_mode = " mode }' ${config} > "$mimic_mode_tmp" && mv -f "$mimic_mode_tmp" ${config}`,
    `}`,
    `mimic_xdp_mode="\${FORWARDX_MIMIC_XDP_MODE:-}"`,
    `case "$mimic_xdp_mode" in native|skb) ;; *) mimic_xdp_mode="" ;; esac`,
    // The panel rewrites the managed config on every desired-state sync. Keep
    // the selected mode in a sidecar so a successful fallback survives that
    // rewrite and does not restart the tunnel on every heartbeat.
    `mimic_saved_xdp_mode="\$(cat ${modeState} 2>/dev/null || true)"`,
    `if [ -z "$mimic_xdp_mode" ]; then case "$mimic_saved_xdp_mode" in native|skb) mimic_xdp_mode="$mimic_saved_xdp_mode" ;; esac; fi`,
    `mimic_existing_xdp_mode="\$(awk -F= '/^[[:space:]]*xdp_mode[[:space:]]*=/ { gsub(/[[:space:]]/, "", $2); print $2; exit }' ${config} 2>/dev/null || true)"`,
    `if [ -z "$mimic_xdp_mode" ]; then case "$mimic_existing_xdp_mode" in native|skb) mimic_xdp_mode="$mimic_existing_xdp_mode" ;; esac; fi`,
    `if [ -z "$mimic_xdp_mode" ]; then`,
    `  mimic_driver="\$(readlink -f /sys/class/net/${iface}/device/driver 2>/dev/null || true)"`,
    `  mimic_driver="\${mimic_driver##*/}"`,
    `  case "$mimic_driver" in ena|ena_*|e1000|e1000e|igb|igc|mlx4_en|mlx5_core|virtio|virtio_net|veth|tap|tun|*) mimic_xdp_mode=skb ;; esac`,
    `fi`,
    `mimic_set_xdp_mode "$mimic_xdp_mode"`,
    `mimic_persist_xdp_mode() { mimic_mode_state_tmp=${modeState}.tmp.$$; printf '%s' "$mimic_xdp_mode" > "$mimic_mode_state_tmp" && mv -f "$mimic_mode_state_tmp" ${modeState}; }`,
  ].join("\n");
  const hooksCheck = [
    `mimic_hooks_ready() {`,
    `  mimic_has_xdp=0; mimic_has_tc=0`,
    `  if command -v ip >/dev/null 2>&1 && ip -details link show dev ${qIface} 2>/dev/null | grep -qi xdp; then mimic_has_xdp=1; fi`,
    `  if command -v tc >/dev/null 2>&1; then`,
    `    if [ -n "\$(tc filter show dev ${qIface} egress 2>/dev/null)" ]; then mimic_has_tc=1; fi`,
    `  fi`,
    `  [ "$mimic_has_xdp" = "1" ] && [ "$mimic_has_tc" = "1" ]`,
    `}`,
    `mimic_wait_for_hooks() { for mimic_attempt in 1 2 3 4 5; do mimic_hooks_ready && return 0; sleep 1; done; return 1; }`,
  ].join("\n");
  const cleanup = [
    `mimic_cleanup_runtime() {`,
    `  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl stop ${q}.service 2>/dev/null || true; elif command -v rc-service >/dev/null 2>&1; then rc-service ${q} stop 2>/dev/null || true; elif [ -x /etc/init.d/${svcName} ]; then /etc/init.d/${svcName} stop 2>/dev/null || true; fi`,
    `  if command -v ip >/dev/null 2>&1; then`,
    `    ip link set dev ${qIface} xdp off 2>/dev/null || true`,
    `    ip link set dev ${qIface} xdpgeneric off 2>/dev/null || true`,
    `    ip link set dev ${qIface} xdpdrv off 2>/dev/null || true`,
    `    ip link set dev ${qIface} xdpoffload off 2>/dev/null || true`,
    `  fi`,
    `  if command -v bpftool >/dev/null 2>&1; then`,
    `    bpftool net detach xdp dev ${qIface} 2>/dev/null || true`,
    `    bpftool net detach xdpgeneric dev ${qIface} 2>/dev/null || true`,
    `    bpftool net detach xdpdrv dev ${qIface} 2>/dev/null || true`,
    `    bpftool net detach xdpoffload dev ${qIface} 2>/dev/null || true`,
    `  fi`,
    `  mimic_ifindex="\$(cat /sys/class/net/${iface}/ifindex 2>/dev/null || true)"`,
    `  if [ -n "$mimic_ifindex" ]; then rm -f /run/mimic/*_"$mimic_ifindex".lock 2>/dev/null || true; fi`,
    `  if command -v modprobe >/dev/null 2>&1; then modprobe -r mimic 2>/dev/null || true; fi`,
    `}`,
  ].join("\n");
  const reloadModule = [
    `mimic_reload_module() {`,
    `  if ! command -v modprobe >/dev/null 2>&1; then echo "[mimic] modprobe is unavailable"; return 1; fi`,
    `  modprobe mimic 2>/dev/null || { echo "[mimic] kernel module could not be loaded"; return 1; }`,
    `}`,
  ].join("\n");
  const startService = [
    `mimic_start_service() {`,
    `  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl enable ${q}.service >/dev/null 2>&1 || true; systemctl restart ${q}.service || { systemctl status ${q}.service --no-pager -l 2>/dev/null || true; journalctl -u ${q}.service -n 80 --no-pager 2>/dev/null || true; return 1; }; elif command -v rc-service >/dev/null 2>&1; then command -v rc-update >/dev/null 2>&1 && rc-update add ${q} default >/dev/null 2>&1 || true; rc-service ${q} restart; elif [ -x /etc/init.d/${svcName} ]; then command -v update-rc.d >/dev/null 2>&1 && update-rc.d ${q} defaults >/dev/null 2>&1 || true; command -v chkconfig >/dev/null 2>&1 && chkconfig ${q} on >/dev/null 2>&1 || true; /etc/init.d/${svcName} restart; else echo "[mimic] unsupported init system for ${svcName}"; return 1; fi`,
    `}`,
  ].join("\n");
  const startAndWait = [
    `mimic_start_and_wait() {`,
    `  mimic_start_output=""`,
    `  if ! mimic_start_output="\$(mimic_start_service 2>&1)"; then printf '%s\\n' "$mimic_start_output"; return 2; fi`,
    `  if mimic_wait_for_hooks; then return 0; fi`,
    `  return 2`,
    `}`,
  ].join("\n");
  return [
    "set -e",
    setXdpMode,
    hooksCheck,
    cleanup,
    reloadModule,
    startService,
    startAndWait,
    ensureBpfDropIn,
    `new_hash=$(${configHash}); old_hash=$(cat ${config}.sha256 2>/dev/null || true); mimic_needs_start=0; if [ "\${mimic_force_restart:-0}" = "1" ] || [ "$new_hash" != "$old_hash" ] || [ "$mimic_dropin_changed" = "1" ] || ! { ${alreadyRunning}; } || ! mimic_hooks_ready; then mimic_needs_start=1; fi`,
    `if [ "$mimic_needs_start" = "1" ]; then`,
    `  mimic_cleanup_runtime`,
    `  mimic_reload_module || exit 1`,
    `  mimic_start_status=0; mimic_start_and_wait || mimic_start_status=$?`,
    `  if [ "$mimic_start_status" -ne 0 ]; then`,
    `    if [ "$mimic_start_status" -eq 2 ] && [ "\${FORWARDX_MIMIC_AUTO_FALLBACK:-1}" != "0" ]; then`,
    `      if [ "$mimic_xdp_mode" = "native" ]; then mimic_fallback_mode=skb; else mimic_fallback_mode=native; fi`,
    `      echo "[mimic] $mimic_xdp_mode XDP/TC hooks were not ready; retrying with $mimic_fallback_mode mode"`,
    `      mimic_xdp_mode="$mimic_fallback_mode"; mimic_set_xdp_mode "$mimic_xdp_mode"; mimic_cleanup_runtime; mimic_reload_module || exit 1`,
    `      mimic_start_and_wait || { echo "[mimic] $mimic_xdp_mode XDP/TC hooks were not detected on ${iface}"; exit 1; }`,
    `    else`,
    `      echo "[mimic] service is active but XDP/TC hooks were not detected on ${iface}"; exit 1`,
    `    fi`,
    `  fi`,
    `  new_hash=$(${configHash})`,
    `  mimic_persist_xdp_mode`,
    `  [ -n "$new_hash" ] && printf '%s' "$new_hash" > ${config}.sha256`,
    `else`,
    `  mimic_persist_xdp_mode`,
    `  echo "[service] ${svcName} config unchanged and hooks ready"`,
    `fi`,
  ].join("\n");
}

export function stopManagedServiceCmd(svcNameRaw: string) {
  const svcName = serviceName(svcNameRaw);
  const q = shQuote(svcName);
  return `if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl disable ${q}.service 2>/dev/null || true; systemctl stop ${q}.service 2>/dev/null || true; fi; if command -v rc-service >/dev/null 2>&1; then rc-service ${q} stop 2>/dev/null || true; fi; if command -v rc-update >/dev/null 2>&1; then rc-update del ${q} default 2>/dev/null || true; fi; if [ -x /etc/init.d/${svcName} ]; then /etc/init.d/${svcName} stop 2>/dev/null || true; fi`;
}

export function removeManagedServiceCmd(svcNameRaw: string) {
  const svcName = serviceName(svcNameRaw);
  const q = shQuote(svcName);
  return `${stopManagedServiceCmd(svcName)}; systemd_unit=/etc/systemd/system/${svcName}.service; systemd_removed=0; if [ -e "$systemd_unit" ]; then rm -f "$systemd_unit"; systemd_removed=1; fi; rm -f /etc/init.d/${svcName} /var/lib/forwardx-agent/service_${svcName}.signature /var/log/forwardx-agent/${svcName}.log 2>/dev/null || true; if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then if [ "$systemd_removed" = "1" ]; then systemctl daemon-reload 2>/dev/null || true; fi; systemctl reset-failed ${q}.service 2>/dev/null || true; fi; command -v update-rc.d >/dev/null 2>&1 && update-rc.d -f ${q} remove >/dev/null 2>&1 || true; command -v chkconfig >/dev/null 2>&1 && chkconfig ${q} off >/dev/null 2>&1 || true`;
}
