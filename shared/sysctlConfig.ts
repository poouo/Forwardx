export const BBR_FQ_PRESET = "net.core.default_qdisc = fq\nnet.ipv4.tcp_congestion_control = bbr\n";
export const SYSCTL_TEXT_MAX_BYTES = 12000;
const coreKeys = new Set(["default_qdisc", "somaxconn", "rmem_max", "wmem_max", "rmem_default", "wmem_default", "optmem_max", "netdev_max_backlog", "netdev_budget", "netdev_budget_usecs"]);

export function isSupportedSysctlKey(key: string) {
  return /^net\.ipv4\.tcp_[a-z0-9_]+$/.test(key) || key.startsWith("net.core.") && coreKeys.has(key.slice(9));
}

/** Configuration data only: never accepts commands, includes, wildcards or duplicate keys. */
export function parseSysctlConfig(text: string): Map<string, string> {
  if (new TextEncoder().encode(text).length > SYSCTL_TEXT_MAX_BYTES) throw new Error("配置不能超过 12000 字节");
  const entries = new Map<string, string>();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const clean = line.split("#", 1)[0].trim();
    if (!clean || clean.startsWith(";")) continue;
    const match = clean.match(/^([a-z0-9_.]+)\s*=\s*([a-zA-Z0-9_.:/+ \t-]+)$/);
    if (!match || !isSupportedSysctlKey(match[1]) || !match[2].trim()) throw new Error(`第 ${index + 1} 行不是受支持的 TCP / 队列参数`);
    if (entries.has(match[1])) throw new Error(`第 ${index + 1} 行参数重复：${match[1]}`);
    entries.set(match[1], match[2].trim().replace(/\s+/g, " "));
  }
  return entries;
}

/** Edits one key without discarding custom parameters, ordering or comments. */
export function updateSysctlConfig(text: string, key: string, value: string): string {
  parseSysctlConfig(text);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const index = lines.findIndex(line => line.split("#", 1)[0].trim().split(/\s*=/, 1)[0] === key);
  if (index >= 0) {
    const commentAt = lines[index].indexOf("#");
    const comment = commentAt >= 0 ? lines[index].slice(commentAt) : "";
    if (value.trim()) lines[index] = `${key} = ${value.trim()}${comment ? ` ${comment}` : ""}`;
    else if (comment) lines[index] = comment;
    else lines.splice(index, 1);
  } else if (value.trim()) {
    if (lines.at(-1) === "") lines.pop();
    lines.push(`${key} = ${value.trim()}`, "");
  }
  return lines.join("\n");
}

export const SYSCTL_GUI_FIELDS = [
  { key: "net.ipv4.tcp_congestion_control", label: "拥塞控制", options: ["bbr", "cubic", "reno", "bbr2", "bbr3"] },
  { key: "net.core.default_qdisc", label: "默认队列", options: ["fq", "fq_codel", "pfifo_fast", "cake"] },
  { key: "net.ipv4.tcp_rmem", label: "TCP 接收缓冲", placeholder: "4096 131072 6291456" },
  { key: "net.ipv4.tcp_wmem", label: "TCP 发送缓冲", placeholder: "4096 16384 4194304" },
  { key: "net.core.rmem_max", label: "接收缓冲上限", placeholder: "字节" },
  { key: "net.core.wmem_max", label: "发送缓冲上限", placeholder: "字节" },
  { key: "net.ipv4.tcp_mtu_probing", label: "MTU 探测", options: ["0", "1", "2"] },
  { key: "net.ipv4.tcp_fastopen", label: "TCP Fast Open", options: ["0", "1", "2", "3"] },
  { key: "net.ipv4.tcp_slow_start_after_idle", label: "空闲后慢启动", options: ["0", "1"] },
  { key: "net.ipv4.tcp_no_metrics_save", label: "禁用 TCP 指标缓存", options: ["0", "1"] },
  { key: "net.core.somaxconn", label: "监听队列上限", placeholder: "4096" },
  { key: "net.core.netdev_max_backlog", label: "收包队列上限", placeholder: "1000" },
] as const;
