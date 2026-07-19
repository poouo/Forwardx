import { createHash } from "node:crypto";

type EmptyObservation = {
  firstSeenAt: number;
  lastSeenAt: number;
  streak: number;
  token: string;
};

const observations = new Map<string, EmptyObservation>();
export const MIMIC_REMOVAL_MIN_STREAK = 3;
export const MIMIC_REMOVAL_MIN_AGE_MS = 60_000;

function observationKey(hostId: number, networkInterface: string) {
  return `${Math.floor(Number(hostId))}:${String(networkInterface || "").trim()}`;
}

function removalToken(key: string, firstSeenAt: number) {
  return createHash("sha256").update(`${key}:${firstSeenAt}:forwardx-mimic-removal-v1`).digest("hex");
}

export function resetMimicRemovalGuard(hostId: number) {
  const prefix = `${Math.floor(Number(hostId))}:`;
  for (const key of observations.keys()) if (key.startsWith(prefix)) observations.delete(key);
}

export function approveMimicInterfaceRemovals(input: {
  hostId: number;
  desiredInterfaces: Iterable<string>;
  reportedInterfaces: Iterable<string>;
  completeSnapshot: boolean;
  rebootDetected?: boolean;
  now?: number;
}) {
  const hostId = Math.floor(Number(input.hostId));
  const now = Number(input.now || Date.now());
  const desired = new Set(Array.from(input.desiredInterfaces, (value) => String(value || "").trim()).filter(Boolean));
  const reported = new Set(Array.from(input.reportedInterfaces, (value) => String(value || "").trim()).filter(Boolean));
  const approved = new Map<string, string>();
  if (hostId <= 0) return approved;
  if (input.rebootDetected) resetMimicRemovalGuard(hostId);

  const prefix = `${hostId}:`;
  for (const key of observations.keys()) {
    if (!key.startsWith(prefix)) continue;
    const iface = key.slice(prefix.length);
    if (desired.has(iface) || !reported.has(iface)) observations.delete(key);
  }
  if (!input.completeSnapshot || input.rebootDetected) return approved;

  for (const iface of reported) {
    if (desired.has(iface)) continue;
    const key = observationKey(hostId, iface);
    const previous = observations.get(key);
    const state = previous && now >= previous.lastSeenAt
      ? { ...previous, streak: previous.streak + 1, lastSeenAt: now }
      : { firstSeenAt: now, lastSeenAt: now, streak: 1, token: removalToken(key, now) };
    observations.set(key, state);
    if (state.streak >= MIMIC_REMOVAL_MIN_STREAK && now - state.firstSeenAt >= MIMIC_REMOVAL_MIN_AGE_MS) {
      approved.set(iface, state.token);
    }
  }
  return approved;
}

export function clearMimicRemovalGuardForTests() {
  observations.clear();
}
