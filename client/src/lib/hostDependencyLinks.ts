const groupTargets: Record<string, { tab: string; label: string }> = {
  port: { tab: "ports", label: "端口转发" },
  failover: { tab: "groups", label: "转发组" },
  chain: { tab: "chains", label: "转发链" },
  entry: { tab: "entries", label: "入口组" },
  exit: { tab: "exits", label: "出口组" },
};

export function hostDependencyGroupTarget(mode: unknown) {
  const key = String(mode);
  const target = Object.hasOwn(groupTargets, key) ? groupTargets[key] : groupTargets.failover;
  return { href: `/tunnels?tab=${target.tab}`, label: target.label };
}
