export type LinkAvailabilityStatus = "disabled" | "available" | "degraded" | "pending" | "unavailable";

export type LinkAvailabilitySource = "probe" | "hosts" | "config";

export type LinkAvailabilityResult = {
  status: LinkAvailabilityStatus;
  available: boolean;
  source: LinkAvailabilitySource;
  message: string;
  usableHostIds: Set<number>;
  usableMemberIds: Set<number>;
};

type AvailabilityNode = {
  id: number;
  available: boolean;
};

type AlternativeNodeSet = {
  label: string;
  nodes: AvailabilityNode[];
};

type ProbeInput = {
  latestLatencyMs?: number | null;
  latestLatencyIsTimeout?: boolean;
  latestLatencyAt?: Date | string | number | null;
};

export const LINK_PROBE_FRESH_MS = 3 * 60 * 1000;
const MAX_FUTURE_PROBE_SKEW_MS = 60 * 1000;

function timestampMillis(value: unknown) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 1_000_000_000_000 ? value * 1000 : value;
  }
  const timestamp = new Date(String(value || "")).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function resolveFreshLinkProbe(
  probe: ProbeInput | null | undefined,
  now = Date.now(),
): "available" | "unavailable" | null {
  if (!probe) return null;
  const recordedAt = timestampMillis(probe.latestLatencyAt);
  const fresh = recordedAt > 0
    && recordedAt <= now + MAX_FUTURE_PROBE_SKEW_MS
    && now - recordedAt <= LINK_PROBE_FRESH_MS;
  if (!fresh) return null;
  if (probe.latestLatencyIsTimeout) return "unavailable";
  const latency = Number(probe.latestLatencyMs);
  return probe.latestLatencyMs !== null
    && probe.latestLatencyMs !== undefined
    && Number.isFinite(latency)
    && latency >= 0
    ? "available"
    : null;
}

function result(
  status: LinkAvailabilityStatus,
  source: LinkAvailabilitySource,
  message: string,
  usableHostIds: Iterable<number> = [],
): LinkAvailabilityResult {
  return {
    status,
    available: status === "available" || status === "degraded",
    source,
    message,
    usableHostIds: new Set(Array.from(usableHostIds).filter((id) => Number.isFinite(id) && id > 0)),
    usableMemberIds: new Set<number>(),
  };
}

export function resolveLinkAvailability(input: {
  label: string;
  enabled: boolean;
  configurationValid?: boolean;
  configurationMessage?: string;
  probe?: ProbeInput | null;
  hostsLoaded: boolean;
  requiredNodes?: AvailabilityNode[];
  alternativeNodeSets?: AlternativeNodeSet[];
}, now = Date.now()): LinkAvailabilityResult {
  if (!input.enabled) return result("disabled", "config", `${input.label}已停用`);
  if (input.configurationValid === false) {
    return result("unavailable", "config", input.configurationMessage || `${input.label}配置不完整`);
  }

  const probe = resolveFreshLinkProbe(input.probe, now);
  if (probe === "available") {
    const latency = Math.round(Number(input.probe?.latestLatencyMs) || 0);
    return result("available", "probe", `最近一次独立探测可达（${latency}ms）`);
  }
  if (probe === "unavailable") {
    return result("unavailable", "probe", "最近一次独立探测不可达");
  }

  if (!input.hostsLoaded) return result("pending", "hosts", "等待主机状态同步");

  const required = input.requiredNodes || [];
  const alternatives = input.alternativeNodeSets || [];
  const usableHostIds = new Set<number>();
  required.filter((node) => node.available).forEach((node) => usableHostIds.add(node.id));
  alternatives.forEach((set) => set.nodes.filter((node) => node.available).forEach((node) => usableHostIds.add(node.id)));

  const offlineRequired = required.filter((node) => !node.available);
  if (offlineRequired.length > 0) {
    return result("unavailable", "hosts", `${input.label}包含离线的必经主机`, usableHostIds);
  }

  let hasUnavailableAlternative = false;
  for (const set of alternatives) {
    if (set.nodes.length === 0) {
      return result("unavailable", "config", `${set.label}没有已启用主机`, usableHostIds);
    }
    const onlineCount = set.nodes.filter((node) => node.available).length;
    if (onlineCount === 0) {
      return result("unavailable", "hosts", `${set.label}主机均离线`, usableHostIds);
    }
    if (onlineCount < set.nodes.length) hasUnavailableAlternative = true;
  }

  if (hasUnavailableAlternative) {
    return result("degraded", "hosts", `${input.label}可用，部分备用主机离线`, usableHostIds);
  }
  return result("available", "hosts", `${input.label}包含的主机均在线`, usableHostIds);
}

function normalizeGroupMode(group: any): "port" | "chain" | "failover" | "entry" | "exit" {
  const mode = String(group?.groupMode || group?.mode || "failover").toLowerCase();
  if (mode === "port" || mode === "chain" || mode === "entry" || mode === "exit") return mode;
  return "failover";
}

function enabledMembers(group: any) {
  return (Array.isArray(group?.members) ? group.members : []).filter((member: any) => member?.isEnabled !== false);
}

function looksLikeIpv4(value: unknown) {
  const parts = String(value || "").trim().split(".");
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function looksLikeIpv6(value: unknown) {
  const text = String(value || "").trim().replace(/^\[|\]$/g, "");
  return text.includes(":") && /^[0-9a-f:.]+$/i.test(text);
}

function memberRecordAvailable(group: any, member: any, hostById: Map<number, any>, tunnelById: Map<number, any>) {
  const tunnel = Number(member?.tunnelId || 0) > 0 ? tunnelById.get(Number(member.tunnelId)) : null;
  const host = hostById.get(Number(member?.hostId || tunnel?.entryHostId || 0));
  const manual = String(host?.entryIp || "").trim();
  const recordType = String(group?.recordType || "A").toUpperCase();
  if (recordType === "AAAA") return looksLikeIpv6(manual) || looksLikeIpv6(host?.ipv6) || looksLikeIpv6(host?.ip);
  if (recordType === "CNAME") {
    if (manual && !looksLikeIpv4(manual) && !looksLikeIpv6(manual)) return true;
    return !!(host?.ddnsEnabled && String(host?.ddnsDomain || "").trim());
  }
  return looksLikeIpv4(manual) || looksLikeIpv4(host?.ipv4) || looksLikeIpv4(host?.ip);
}

function tunnelRouteHostIds(tunnel: any): number[] {
  const explicit: number[] = Array.isArray(tunnel?.hopHostIds)
    ? tunnel.hopHostIds.map(Number).filter((id: number) => Number.isFinite(id) && id > 0)
    : [];
  if (explicit.length > 0) return Array.from(new Set<number>(explicit));
  const embedded: number[] = Array.isArray(tunnel?.hopHosts)
    ? tunnel.hopHosts.map((host: any) => Number(host?.id)).filter((id: number) => Number.isFinite(id) && id > 0)
    : [];
  if (embedded.length > 0) return Array.from(new Set<number>(embedded));
  return Array.from(new Set<number>([Number(tunnel?.entryHostId), Number(tunnel?.exitHostId)].filter((id) => Number.isFinite(id) && id > 0)));
}

function memberNode(
  member: any,
  hostById: Map<number, any>,
  tunnelAvailabilityById: Map<number, LinkAvailabilityResult>,
): AvailabilityNode | null {
  const tunnelId = Number(member?.tunnelId || 0);
  if (tunnelId > 0) {
    const tunnelState = tunnelAvailabilityById.get(tunnelId);
    return { id: tunnelId, available: !!tunnelState?.available };
  }
  const hostId = Number(member?.hostId || 0);
  if (hostId <= 0) return null;
  return { id: hostId, available: hostById.get(hostId)?.isOnline === true };
}

function endpointHostMembers(group: any, hostById: Map<number, any>, tunnelById: Map<number, any>) {
  return enabledMembers(group)
    .filter((member: any) => Number(member?.hostId || 0) > 0)
    .filter((member: any) => {
      const mode = normalizeGroupMode(group);
      if (mode !== "entry") return true;
      return memberRecordAvailable(group, member, hostById, tunnelById);
    });
}

export function buildLinkAvailabilityIndex(input: {
  hosts?: any[];
  tunnels?: any[];
  groups?: any[];
  isTunnelSupported?: (tunnel: any) => boolean;
  now?: number;
}) {
  const hostsLoaded = Array.isArray(input.hosts);
  const hostById = new Map<number, any>((input.hosts || []).map((host: any) => [Number(host.id), host]));
  const tunnels = input.tunnels || [];
  const groups = input.groups || [];
  const tunnelById = new Map<number, any>(tunnels.map((tunnel: any) => [Number(tunnel.id), tunnel]));
  const groupById = new Map<number, any>(groups.map((group: any) => [Number(group.id), group]));
  const now = input.now ?? Date.now();
  const tunnelAvailabilityById = new Map<number, LinkAvailabilityResult>();
  const groupAvailabilityById = new Map<number, LinkAvailabilityResult>();
  const hostNode = (hostId: number): AvailabilityNode => ({
    id: hostId,
    available: hostById.get(hostId)?.isOnline === true,
  });

  for (const tunnel of tunnels) {
    const routeHostIds = tunnelRouteHostIds(tunnel);
    const requiredHostIds = new Set<number>(routeHostIds);
    const alternativeNodeSets: AlternativeNodeSet[] = [];
    const entryGroupId = Number(tunnel?.entryGroupId || 0);
    const exitGroupId = Number(tunnel?.exitGroupId || 0);
    const entryGroup = entryGroupId > 0 ? groupById.get(entryGroupId) : null;
    const exitGroup = exitGroupId > 0 ? groupById.get(exitGroupId) : null;
    let configurationValid = routeHostIds.length >= 2;
    let configurationMessage = "隧道至少需要入口和出口主机";

    if (entryGroupId > 0 && !entryGroup) {
      configurationValid = false;
      configurationMessage = "关联入口组不存在";
    } else if (entryGroup) {
      const members = endpointHostMembers(entryGroup, hostById, tunnelById);
      if (!entryGroup.isEnabled || normalizeGroupMode(entryGroup) !== "entry" || !String(entryGroup.domain || "").trim()) {
        configurationValid = false;
        configurationMessage = "关联入口组配置不可用";
      }
      if (routeHostIds.length > 0) requiredHostIds.delete(routeHostIds[0]);
      alternativeNodeSets.push({ label: "入口组", nodes: members.map((member: any) => hostNode(Number(member.hostId))) });
    }

    if (exitGroupId > 0 && !exitGroup) {
      configurationValid = false;
      configurationMessage = "关联出口组不存在";
    } else if (exitGroup) {
      const members = endpointHostMembers(exitGroup, hostById, tunnelById);
      if (!exitGroup.isEnabled || normalizeGroupMode(exitGroup) !== "exit") {
        configurationValid = false;
        configurationMessage = "关联出口组配置不可用";
      }
      if (routeHostIds.length > 0) requiredHostIds.delete(routeHostIds[routeHostIds.length - 1]);
      alternativeNodeSets.push({ label: "出口组", nodes: members.map((member: any) => hostNode(Number(member.hostId))) });
    } else if (tunnel?.loadBalanceEnabled) {
      const rawExitIds: number[] = [
        Number(routeHostIds[routeHostIds.length - 1] || tunnel?.exitHostId || 0),
        ...(Array.isArray(tunnel?.loadBalanceExits)
          ? tunnel.loadBalanceExits.filter((item: any) => item?.isEnabled !== false).map((item: any) => Number(item?.hostId || item?.host?.id || 0))
          : []),
      ];
      const exitIds = Array.from(new Set(rawExitIds.filter((id) => Number.isFinite(id) && id > 0)));
      exitIds.forEach((id) => requiredHostIds.delete(id));
      alternativeNodeSets.push({ label: "多出口", nodes: exitIds.map(hostNode) });
    }

    const state = resolveLinkAvailability({
      label: "隧道",
      enabled: tunnel?.isEnabled !== false && input.isTunnelSupported?.(tunnel) !== false,
      configurationValid,
      configurationMessage,
      probe: tunnel,
      hostsLoaded,
      requiredNodes: Array.from(requiredHostIds).map(hostNode),
      alternativeNodeSets,
    }, now);
    tunnelAvailabilityById.set(Number(tunnel.id), state);
  }

  for (const group of groups) {
    const mode = normalizeGroupMode(group);
    const members = enabledMembers(group);
    const memberNodes = new Map<number, AvailabilityNode>();
    for (const member of members) {
      const node = memberNode(member, hostById, tunnelAvailabilityById);
      if (node) memberNodes.set(Number(member.id), node);
    }
    let eligibleMemberIds = new Set<number>(members.map((member: any) => Number(member.id)));
    let state: LinkAvailabilityResult;

    if (mode === "chain") {
      const entryGroupId = Number(group?.entryGroupId || 0);
      const entryGroup = entryGroupId > 0 ? groupById.get(entryGroupId) : null;
      const minMembers = entryGroupId > 0 ? 1 : 2;
      const configurationValid = members.length >= minMembers
        && memberNodes.size === members.length
        && (entryGroupId <= 0 || !!entryGroup)
        && (!entryGroup || (
          entryGroup.isEnabled !== false
          && normalizeGroupMode(entryGroup) === "entry"
          && !!String(entryGroup.domain || "").trim()
        ));
      const alternatives: AlternativeNodeSet[] = [];
      if (entryGroup) {
        alternatives.push({
          label: "入口组",
          nodes: endpointHostMembers(entryGroup, hostById, tunnelById).map((member: any) => hostNode(Number(member.hostId))),
        });
      }
      state = resolveLinkAvailability({
        label: "转发链",
        enabled: group?.isEnabled !== false,
        configurationValid,
        configurationMessage: entryGroupId > 0 && !entryGroup
          ? "关联入口组不存在"
          : entryGroup
            ? "转发链至少需要一个链路成员及可用入口组"
            : "转发链至少需要两个链路成员",
        probe: group,
        hostsLoaded,
        requiredNodes: Array.from(memberNodes.values()),
        alternativeNodeSets: alternatives,
      }, now);
    } else if (mode === "port") {
      state = resolveLinkAvailability({
        label: "端口转发",
        enabled: group?.isEnabled !== false,
        configurationValid: members.length === 1 && memberNodes.size === 1,
        configurationMessage: "端口转发需要一台所属主机",
        hostsLoaded,
        requiredNodes: Array.from(memberNodes.values()),
      }, now);
    } else {
      let candidates = members;
      let configurationValid = members.length > 0;
      let configurationMessage = `${mode === "entry" ? "入口组" : mode === "exit" ? "出口组" : "转发组"}没有已启用成员`;
      if ((mode === "entry" || mode === "failover") && !String(group?.domain || "").trim()) {
        configurationValid = false;
        configurationMessage = mode === "entry" ? "入口组需要指定入口域名" : "转发组需要指定 DDNS 域名";
      }
      if (mode === "entry" || mode === "failover") {
        candidates = candidates.filter((member: any) => memberRecordAvailable(group, member, hostById, tunnelById));
        if (members.length > 0 && candidates.length === 0) {
          configurationValid = false;
          configurationMessage = `${String(group?.recordType || "A").toUpperCase()} 记录缺少可用成员地址`;
        }
      }
      if (String(group?.lastStatus || "").toLowerCase() === "error") {
        configurationValid = false;
        configurationMessage = String(group?.lastMessage || "DDNS 同步异常");
      }
      if (group?.chinaHealthCheckEnabled) {
        const healthy = candidates.filter((member: any) => String(member?.chinaHealthStatus || "unknown").toLowerCase() === "healthy");
        const pending = candidates.some((member: any) => !["healthy", "unhealthy"].includes(String(member?.chinaHealthStatus || "unknown").toLowerCase()));
        if (healthy.length > 0) {
          candidates = healthy;
        } else if (pending && configurationValid && group?.isEnabled !== false) {
          state = result("pending", "probe", "等待入口健康度检测结果");
          groupAvailabilityById.set(Number(group.id), state);
          continue;
        } else if (configurationValid) {
          configurationValid = false;
          configurationMessage = "入口健康度检测未通过";
        }
      }
      eligibleMemberIds = new Set<number>(candidates.map((member: any) => Number(member.id)));
      const candidateNodes = candidates
        .map((member: any) => ({ member, node: memberNodes.get(Number(member.id)) }))
        .filter((item: any) => !!item.node);
      state = resolveLinkAvailability({
        label: mode === "entry" ? "入口组" : mode === "exit" ? "出口组" : "转发组",
        enabled: group?.isEnabled !== false,
        configurationValid: configurationValid && candidateNodes.length > 0,
        configurationMessage,
        hostsLoaded,
        alternativeNodeSets: [{
          label: mode === "entry" ? "入口组" : mode === "exit" ? "出口组" : "转发组",
          nodes: candidateNodes.map((item: any) => item.node),
        }],
      }, now);
    }

    if (state.source === "probe" && state.available) {
      eligibleMemberIds.forEach((memberId) => state.usableMemberIds.add(memberId));
    } else {
      members.forEach((member: any) => {
        if (!eligibleMemberIds.has(Number(member.id))) return;
        const node = memberNodes.get(Number(member.id));
        if (node?.available) state.usableMemberIds.add(Number(member.id));
      });
    }
    groupAvailabilityById.set(Number(group.id), state);
  }

  return { tunnelAvailabilityById, groupAvailabilityById };
}
