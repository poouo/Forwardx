import { getAllSettings, setSettings } from "./repositories/settingsRepository";

export type PanelMigrationAgentState = "preparing" | "committing" | "committed" | "aborted";

export type PanelMigrationAgentDirective = {
  id: string;
  state: PanelMigrationAgentState;
  fallbackPanelUrl?: string;
  startedAt?: number;
};

const CACHE_TTL_MS = 2_000;
let cached: {
  expiresAt: number;
  directive: PanelMigrationAgentDirective | null;
  switchTarget: string;
} | null = null;

export function invalidatePanelMigrationAgentStateCache() {
  cached = null;
}

async function getCachedAgentMigrationSettings() {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached;
  const settings = await getAllSettings();
  const id = String(settings.panelMigrationId || "").trim();
  const state = String(settings.panelMigrationPhase || "").trim() as PanelMigrationAgentState;
  const validState = state === "preparing" || state === "committing" || state === "committed" || state === "aborted";
  const directive = id && validState
    ? {
        id,
        state,
        fallbackPanelUrl: String(settings.panelMigrationSourceUrl || "").trim() || undefined,
        startedAt: Number(settings.panelMigrationStartedAt || 0) || undefined,
      }
    : null;
  const switchTarget = String(settings.agentMigrationTargetPanelUrl || "").trim();
  const switchExpiresAt = Number(settings.agentMigrationTargetExpiresAt || 0);
  cached = {
    expiresAt: now + CACHE_TTL_MS,
    directive,
    switchTarget: switchTarget && switchExpiresAt > Math.floor(now / 1000) ? switchTarget : "",
  };
  return cached;
}

export async function getPanelMigrationAgentDirective(): Promise<PanelMigrationAgentDirective | null> {
  return (await getCachedAgentMigrationSettings()).directive;
}

export async function getAgentMigrationSwitchTarget() {
  return (await getCachedAgentMigrationSettings()).switchTarget;
}

export async function setPanelMigrationAgentDirective(directive: PanelMigrationAgentDirective) {
  await setSettings({
    panelMigrationId: directive.id,
    panelMigrationPhase: directive.state,
    panelMigrationSourceUrl: directive.fallbackPanelUrl || null,
    panelMigrationStartedAt: directive.startedAt ? String(Math.floor(directive.startedAt)) : null,
  });
  invalidatePanelMigrationAgentStateCache();
}
