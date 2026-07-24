import type {
  AgentForwardGroupLatencyResult,
  AgentHostProbeServiceResult,
  AgentTcpingResult,
  AgentTunnelTcpingResult,
} from "../shared/agentDtos";

export const AGENT_TCPING_STEADY_REPORT_MS = 5 * 60 * 1000;
const AGENT_TCPING_GATE_STATE_TTL_MS = 30 * 60 * 1000;

type ProbeResult = AgentTcpingResult | AgentTunnelTcpingResult | AgentForwardGroupLatencyResult;

type GateState = {
  signature: string;
  acceptedAt: number;
  lastSeenAt: number;
  sequence: number;
};

type GateUpdate = GateState & {
  key: string;
};

export type AgentTcpingReportGateInput = {
  hostId: number;
  force?: boolean;
  gateRules?: boolean;
  results: AgentTcpingResult[];
  tunnels: AgentTunnelTcpingResult[];
  forwardGroups: AgentForwardGroupLatencyResult[];
  services: AgentHostProbeServiceResult[];
};

export type AgentTcpingReportGatePlan = {
  results: AgentTcpingResult[];
  tunnels: AgentTunnelTcpingResult[];
  forwardGroups: AgentForwardGroupLatencyResult[];
  services: AgentHostProbeServiceResult[];
  transitionRuleIds: Set<number>;
  commit: () => void;
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function integer(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) ? number : 0;
}

function probeStateKey(kind: "rule" | "tunnel" | "forwardGroup", report: ProbeResult) {
  const probeKey = text(report.probeKey);
  if (probeKey) return probeKey;
  const item = report as any;
  return [
    kind,
    integer(item.ruleId),
    integer(item.tunnelId),
    integer(item.groupId),
    integer(item.memberId),
    text(item.targetIp).toLowerCase(),
    integer(item.targetPort),
    text(item.method).toLowerCase(),
    integer(item.hopIndex),
    integer(item.hopCount),
    text(item.seriesKey).toLowerCase(),
  ].join(":");
}

function reportUnitKey(hostId: number, kind: "rule" | "tunnel" | "forwardGroup", report: ProbeResult) {
  const item = report as any;
  if (kind === "rule") return `${hostId}:rule:${integer(item.ruleId)}`;
  if (kind === "tunnel") return `${hostId}:tunnel:${integer(item.tunnelId)}:${text(item.topologyKey)}`;
  return `${hostId}:forward-group:${integer(item.groupId)}:${text(item.topologyKey)}`;
}

function addUnits(
  units: Map<string, string[]>,
  hostId: number,
  kind: "rule" | "tunnel" | "forwardGroup",
  reports: ProbeResult[],
) {
  for (const report of reports) {
    const key = reportUnitKey(hostId, kind, report);
    const state = `${probeStateKey(kind, report)}=${!!report.isTimeout}`;
    const values = units.get(key) || [];
    values.push(state);
    units.set(key, values);
  }
}

function signaturesFor(units: Map<string, string[]>) {
  return new Map(Array.from(units.entries()).map(([key, values]) => [key, [...values].sort().join("|")]));
}

function filterSelected<T extends ProbeResult>(
  reports: T[],
  hostId: number,
  kind: "rule" | "tunnel" | "forwardGroup",
  selected: Set<string>,
) {
  return reports.filter((report) => selected.has(reportUnitKey(hostId, kind, report)));
}

export class AgentTcpingReportGate {
  private readonly states = new Map<string, GateState>();
  private sequence = 0;

  constructor(
    private readonly steadyReportMs = AGENT_TCPING_STEADY_REPORT_MS,
    private readonly stateTtlMs = AGENT_TCPING_GATE_STATE_TTL_MS,
  ) {}

  plan(input: AgentTcpingReportGateInput, now = Date.now()): AgentTcpingReportGatePlan {
    const hostId = integer(input.hostId);
    const units = new Map<string, string[]>();
    if (input.gateRules !== false) addUnits(units, hostId, "rule", input.results);
    addUnits(units, hostId, "tunnel", input.tunnels);
    addUnits(units, hostId, "forwardGroup", input.forwardGroups);
    const signatures = signaturesFor(units);
    const selected = new Set<string>();
    const transitions = new Set<string>();
    const updates: GateUpdate[] = [];

    for (const [key, state] of this.states.entries()) {
      if (now - state.lastSeenAt > this.stateTtlMs) this.states.delete(key);
    }

    for (const [key, signature] of signatures.entries()) {
      const previous = this.states.get(key);
      if (previous) previous.lastSeenAt = now;
      const transition = !previous || previous.signature !== signature;
      if (!input.force && !transition && now - previous.acceptedAt < this.steadyReportMs) continue;
      const sequence = ++this.sequence;
      selected.add(key);
      if (transition || input.force) transitions.add(key);
      updates.push({ key, signature, acceptedAt: now, lastSeenAt: now, sequence });
    }

    const results = input.gateRules === false
      ? [...input.results]
      : filterSelected(input.results, hostId, "rule", selected);
    const transitionRuleIds = new Set(results
      .filter((report) => transitions.has(reportUnitKey(hostId, "rule", report)))
      .map((report) => integer(report.ruleId))
      .filter((ruleId) => ruleId > 0));
    let committed = false;

    return {
      results,
      tunnels: filterSelected(input.tunnels, hostId, "tunnel", selected),
      forwardGroups: filterSelected(input.forwardGroups, hostId, "forwardGroup", selected),
      services: [...input.services],
      transitionRuleIds,
      commit: () => {
        if (committed) return;
        committed = true;
        for (const update of updates) {
          const current = this.states.get(update.key);
          if (!current || current.sequence < update.sequence) this.states.set(update.key, update);
        }
      },
    };
  }
}

export const agentTcpingReportGate = new AgentTcpingReportGate();
