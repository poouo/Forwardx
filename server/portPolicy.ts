export type PortPolicySource = {
  portRangeStart?: number | null;
  portRangeEnd?: number | null;
  portAllowlist?: string | null;
  portRanges?: Array<{ start: number; end: number }> | null;
};

export type PortPolicy = {
  rangeStart: number | null;
  rangeEnd: number | null;
  allowlist: number[];
  ranges?: Array<{ start: number; end: number }>;
  denyAll?: boolean;
};

type PortInterval = { start: number; end: number };

const normalizedPolicies = new WeakSet<PortPolicy>();

function normalizeIntervals(intervals: PortInterval[]) {
  const sorted = intervals
    .flatMap((range) => {
      if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) return [];
      const start = Math.max(1, Math.ceil(range.start));
      const end = Math.min(65535, Math.floor(range.end));
      return start <= end ? [{ start, end }] : [];
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const normalized: PortInterval[] = [];
  for (const range of sorted) {
    const previous = normalized[normalized.length - 1];
    if (previous && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      normalized.push({ ...range });
    }
  }
  return normalized;
}

function policyIntervals(policy: PortPolicy) {
  if (policy.denyAll) return [];
  const intervals: PortInterval[] = [];
  if (policy.rangeStart !== null && policy.rangeEnd !== null) {
    intervals.push({ start: policy.rangeStart, end: policy.rangeEnd });
  }
  intervals.push(...(policy.ranges || []));
  intervals.push(...policy.allowlist.map((port) => ({ start: port, end: port })));
  return normalizeIntervals(intervals);
}

function intersectIntervals(left: PortInterval[], right: PortInterval[]) {
  const intersection: PortInterval[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const start = Math.max(left[leftIndex].start, right[rightIndex].start);
    const end = Math.min(left[leftIndex].end, right[rightIndex].end);
    if (start <= end) intersection.push({ start, end });
    if (left[leftIndex].end < right[rightIndex].end) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }
  return intersection;
}

function sortedNumbersInclude(values: number[], target: number) {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const value = values[middle];
    if (value === target) return true;
    if (value < target) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

function sortedIntervalsInclude(intervals: PortInterval[], target: number) {
  let low = 0;
  let high = intervals.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const range = intervals[middle];
    if (target < range.start) high = middle - 1;
    else if (target > range.end) low = middle + 1;
    else return true;
  }
  return false;
}

function normalizedPolicy(policy: PortPolicy) {
  normalizedPolicies.add(policy);
  return policy;
}

export function parsePortAllowlist(value: unknown) {
  const text = String(value || "").trim();
  if (!text) return [];
  const ports = text
    .split(",")
    .map((item) => Number(String(item).trim()))
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535);
  return Array.from(new Set(ports)).sort((a, b) => a - b);
}

export function normalizePortAllowlist(value: unknown) {
  return parsePortAllowlist(value).join(",");
}

function optionalPort(value: unknown) {
  if (value == null || value === "") return null;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

export function portPolicyFrom(source: PortPolicySource | null | undefined): PortPolicy {
  const rangeStart = optionalPort(source?.portRangeStart);
  const rangeEnd = optionalPort(source?.portRangeEnd);
  const hasValidRange = rangeStart !== null && rangeEnd !== null && rangeStart <= rangeEnd;
  const ranges = normalizeIntervals(Array.from(new Map(
    (source?.portRanges || [])
      .map((range) => ({ start: optionalPort(range?.start), end: optionalPort(range?.end) }))
      .filter((range) => range.start !== null && range.end !== null && range.start <= range.end)
      .map((range) => [`${range.start}:${range.end}`, { start: range.start!, end: range.end! }]),
  ).values()));
  return normalizedPolicy({
    rangeStart: hasValidRange ? rangeStart : null,
    rangeEnd: hasValidRange ? rangeEnd : null,
    allowlist: parsePortAllowlist(source?.portAllowlist),
    ...(ranges.length > 0 ? { ranges } : {}),
  });
}

export function portPolicyHasRestriction(policy: PortPolicy) {
  return !!policy.denyAll
    || (policy.rangeStart !== null && policy.rangeEnd !== null)
    || (policy.ranges?.length || 0) > 0
    || policy.allowlist.length > 0;
}

export function isPortAllowedByPolicy(port: number, policy: PortPolicy) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (policy.denyAll) return false;
  if (!portPolicyHasRestriction(policy)) return true;
  const inRange = policy.rangeStart !== null && policy.rangeEnd !== null && port >= policy.rangeStart && port <= policy.rangeEnd;
  if (inRange) return true;
  if (normalizedPolicies.has(policy)) {
    return sortedIntervalsInclude(policy.ranges || [], port) || sortedNumbersInclude(policy.allowlist, port);
  }
  const inRanges = (policy.ranges || []).some((range) => port >= range.start && port <= range.end);
  return inRanges || policy.allowlist.includes(port);
}

export function describePortPolicy(policy: PortPolicy) {
  if (policy.denyAll) return "无可用端口";
  const parts: string[] = [];
  if (policy.rangeStart !== null && policy.rangeEnd !== null) {
    parts.push(`${policy.rangeStart}-${policy.rangeEnd}`);
  }
  if (policy.ranges?.length) {
    parts.push(policy.ranges.map((range) => `${range.start}-${range.end}`).join(","));
  }
  if (policy.allowlist.length > 0) {
    parts.push(policy.allowlist.join(","));
  }
  return parts.length > 0 ? parts.join(" + ") : "不限制";
}

export function portPolicyErrorMessage(policy: PortPolicy, label = "端口") {
  return `${label}必须在允许范围内：${describePortPolicy(policy)}`;
}

export function combinePortPolicies(...policies: PortPolicy[]) {
  const restricted = policies.filter(portPolicyHasRestriction);
  if (restricted.length === 0) return portPolicyFrom(null);
  let allowed = policyIntervals(restricted[0]);
  for (let index = 1; index < restricted.length && allowed.length > 0; index += 1) {
    allowed = intersectIntervals(allowed, policyIntervals(restricted[index]));
  }
  if (allowed.length === 0) {
    return normalizedPolicy({
      rangeStart: null,
      rangeEnd: null,
      allowlist: [],
      denyAll: true,
    } satisfies PortPolicy);
  }
  let bestIndex = 0;
  for (let index = 1; index < allowed.length; index += 1) {
    if (allowed[index].end - allowed[index].start > allowed[bestIndex].end - allowed[bestIndex].start) {
      bestIndex = index;
    }
  }
  const best = allowed[bestIndex];
  const hasPrimaryRange = best.end > best.start;
  const remaining = allowed.filter((_, index) => !hasPrimaryRange || index !== bestIndex);
  return normalizedPolicy({
    rangeStart: hasPrimaryRange ? best.start : null,
    rangeEnd: hasPrimaryRange ? best.end : null,
    allowlist: remaining.filter((range) => range.start === range.end).map((range) => range.start),
    ...(remaining.some((range) => range.start !== range.end)
      ? { ranges: remaining.filter((range) => range.start !== range.end) }
      : {}),
  } satisfies PortPolicy);
}

export function pickAvailablePort(
  policy: PortPolicy,
  usedPorts: Set<number>,
  defaults: { start: number; end: number },
) {
  const candidates: number[] = [];
  const candidateSet = new Set<number>();
  const addCandidate = (port: number) => {
    if (usedPorts.has(port) || candidateSet.has(port)) return;
    candidateSet.add(port);
    candidates.push(port);
  };
  if (portPolicyHasRestriction(policy)) {
    if (policy.rangeStart !== null && policy.rangeEnd !== null) {
      for (let port = policy.rangeStart; port <= policy.rangeEnd; port++) {
        addCandidate(port);
      }
    }
    for (const range of policy.ranges || []) {
      for (let port = range.start; port <= range.end; port++) {
        addCandidate(port);
      }
    }
    for (const port of policy.allowlist) {
      addCandidate(port);
    }
  } else {
    const start = Math.max(1, Math.min(65535, defaults.start));
    const end = Math.max(start, Math.min(65535, defaults.end));
    const range = end - start + 1;
    if (range <= 10000) {
      for (let port = start; port <= end; port++) {
        addCandidate(port);
      }
    } else {
      // Random sampling can miss the only free port in a busy large range.
      // Scan from a random offset once; the bounded TCP port space is small
      // enough to make this deterministic without a material cost.
      const offset = Math.floor(Math.random() * range);
      for (let i = 0; i < range; i += 1) {
        const port = start + ((offset + i) % range);
        if (!usedPorts.has(port)) return port;
      }
      return null;
    }
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}
