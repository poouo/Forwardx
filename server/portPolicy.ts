export type PortPolicySource = {
  portRangeStart?: number | null;
  portRangeEnd?: number | null;
  portAllowlist?: string | null;
};

export type PortPolicy = {
  rangeStart: number | null;
  rangeEnd: number | null;
  allowlist: number[];
  denyAll?: boolean;
};

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
  return {
    rangeStart: hasValidRange ? rangeStart : null,
    rangeEnd: hasValidRange ? rangeEnd : null,
    allowlist: parsePortAllowlist(source?.portAllowlist),
  };
}

export function portPolicyHasRestriction(policy: PortPolicy) {
  return !!policy.denyAll || (policy.rangeStart !== null && policy.rangeEnd !== null) || policy.allowlist.length > 0;
}

export function isPortAllowedByPolicy(port: number, policy: PortPolicy) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (policy.denyAll) return false;
  if (!portPolicyHasRestriction(policy)) return true;
  const inRange = policy.rangeStart !== null && policy.rangeEnd !== null && port >= policy.rangeStart && port <= policy.rangeEnd;
  return inRange || policy.allowlist.includes(port);
}

export function describePortPolicy(policy: PortPolicy) {
  if (policy.denyAll) return "无可用端口";
  const parts: string[] = [];
  if (policy.rangeStart !== null && policy.rangeEnd !== null) {
    parts.push(`${policy.rangeStart}-${policy.rangeEnd}`);
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
  const allowed: number[] = [];
  for (let port = 1; port <= 65535; port++) {
    if (restricted.every((policy) => isPortAllowedByPolicy(port, policy))) {
      allowed.push(port);
    }
  }
  if (allowed.length === 0) {
    return {
      rangeStart: null,
      rangeEnd: null,
      allowlist: [],
      denyAll: true,
    } satisfies PortPolicy;
  }
  let bestStart = allowed[0];
  let bestEnd = allowed[0];
  let runStart = allowed[0];
  let previous = allowed[0];
  for (let i = 1; i <= allowed.length; i++) {
    const current = allowed[i];
    if (current === previous + 1) {
      previous = current;
      continue;
    }
    if (previous - runStart > bestEnd - bestStart) {
      bestStart = runStart;
      bestEnd = previous;
    }
    runStart = current;
    previous = current;
  }
  const rangeStart = bestEnd > bestStart ? bestStart : null;
  const rangeEnd = bestEnd > bestStart ? bestEnd : null;
  return {
    rangeStart,
    rangeEnd,
    allowlist: allowed.filter((port) => rangeStart === null || rangeEnd === null || port < rangeStart || port > rangeEnd),
  } satisfies PortPolicy;
}

export function pickAvailablePort(
  policy: PortPolicy,
  usedPorts: Set<number>,
  defaults: { start: number; end: number },
) {
  const candidates: number[] = [];
  if (portPolicyHasRestriction(policy)) {
    if (policy.rangeStart !== null && policy.rangeEnd !== null) {
      for (let port = policy.rangeStart; port <= policy.rangeEnd; port++) {
        if (!usedPorts.has(port)) candidates.push(port);
      }
    }
    for (const port of policy.allowlist) {
      if (!usedPorts.has(port) && !candidates.includes(port)) candidates.push(port);
    }
  } else {
    const start = Math.max(1, Math.min(65535, defaults.start));
    const end = Math.max(start, Math.min(65535, defaults.end));
    const range = end - start + 1;
    if (range <= 10000) {
      for (let port = start; port <= end; port++) {
        if (!usedPorts.has(port)) candidates.push(port);
      }
    } else {
      for (let i = 0; i < 100; i++) {
        const port = start + Math.floor(Math.random() * range);
        if (!usedPorts.has(port)) return port;
      }
      return null;
    }
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}
