import { getAllSettings, setSettings } from "./repositories/settingsRepository";

export type PanelMigrationAgentState = "preparing" | "committing" | "committed" | "aborted";

export type PanelMigrationAgentDirective = {
  id: string;
  state: PanelMigrationAgentState;
  targetPanelUrl?: string;
  fallbackPanelUrl?: string;
  startedAt?: number;
  hostIds?: number[];
};

const CACHE_TTL_MS = 30_000;
type CachedAgentMigrationSettings = {
  expiresAt: number;
  directive: PanelMigrationAgentDirective | null;
  scopedHostIds: Set<number> | null;
  switchTarget: string;
  migratedToPanelUrl: string | null;
};

let cached: CachedAgentMigrationSettings | null = null;
let cacheLoad: Promise<CachedAgentMigrationSettings> | null = null;
let cacheGeneration = 0;

export function invalidatePanelMigrationAgentStateCache() {
  cached = null;
  cacheLoad = null;
  cacheGeneration += 1;
}

async function getCachedAgentMigrationSettings() {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached;
  if (cacheLoad) return cacheLoad;

  const generation = cacheGeneration;
  const load = getAllSettings().then((settings) => {
    const id = String(settings.panelMigrationId || "").trim();
    const state = String(settings.panelMigrationPhase || "").trim() as PanelMigrationAgentState;
    const validState = state === "preparing" || state === "committing" || state === "committed" || state === "aborted";
    let scopedHostIds: Set<number> | null = null;
    const rawHostIds = String(settings.panelMigrationHostIds || "").trim();
    if (rawHostIds) {
      try {
        const values = JSON.parse(rawHostIds);
        if (Array.isArray(values)) {
          scopedHostIds = new Set(values.map(Number).filter((value) => Number.isFinite(value) && value > 0));
        }
      } catch {
        scopedHostIds = new Set();
      }
    }
    const directive = id && validState
      ? {
          id,
          state,
          targetPanelUrl: String(settings.panelMigrationTargetPanelUrl || "").trim() || undefined,
          fallbackPanelUrl: String(settings.panelMigrationSourceUrl || "").trim() || undefined,
          startedAt: Number(settings.panelMigrationStartedAt || 0) || undefined,
        }
      : null;
    const loadedAt = Date.now();
    const switchTarget = String(settings.agentMigrationTargetPanelUrl || "").trim();
    const switchExpiresAt = Number(settings.agentMigrationTargetExpiresAt || 0);
    const next: CachedAgentMigrationSettings = {
      expiresAt: loadedAt + CACHE_TTL_MS,
      directive,
      scopedHostIds,
      switchTarget: switchTarget && switchExpiresAt > Math.floor(loadedAt / 1000) ? switchTarget : "",
      migratedToPanelUrl: settings.migratedToPanelUrl || null,
    };
    if (generation === cacheGeneration) cached = next;
    return next;
  });
  cacheLoad = load;
  try {
    return await load;
  } finally {
    if (cacheLoad === load) cacheLoad = null;
  }
}

export async function getPanelMigrationAgentDirective(hostId?: number): Promise<PanelMigrationAgentDirective | null> {
  const state = await getCachedAgentMigrationSettings();
  if (hostId !== undefined && state.scopedHostIds && !state.scopedHostIds.has(Number(hostId))) return null;
  return state.directive;
}

export async function getAgentMigrationSwitchTarget() {
  return (await getCachedAgentMigrationSettings()).switchTarget;
}

export async function getMigratedToPanelUrl() {
  return (await getCachedAgentMigrationSettings()).migratedToPanelUrl;
}

export async function setPanelMigrationAgentDirective(directive: PanelMigrationAgentDirective) {
  await setSettings({
    panelMigrationId: directive.id,
    panelMigrationPhase: directive.state,
    panelMigrationTargetPanelUrl: directive.targetPanelUrl || null,
    panelMigrationSourceUrl: directive.fallbackPanelUrl || null,
    panelMigrationStartedAt: directive.startedAt ? String(Math.floor(directive.startedAt)) : null,
    panelMigrationHostIds: directive.hostIds ? JSON.stringify(directive.hostIds) : null,
  });
  invalidatePanelMigrationAgentStateCache();
}
