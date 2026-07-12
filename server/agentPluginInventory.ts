export type AgentPluginInventory = {
  versions: ReadonlyMap<string, string>;
  syncSignatures: ReadonlyMap<string, string>;
  supportsSyncSignatures: boolean;
  reportedAt: number;
};

const AGENT_PLUGIN_INVENTORY_TTL_MS = 2 * 60 * 1000;
const inventories = new Map<number, {
  versions: Map<string, string>;
  syncSignatures: Map<string, string>;
  supportsSyncSignatures: boolean;
  reportedAt: number;
}>();
const pluginIdPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function normalizedHostId(value: unknown) {
  const hostId = Number(value);
  return Number.isInteger(hostId) && hostId > 0 ? hostId : 0;
}

function normalizePluginValues(value: unknown, valueLimit: number) {
  const normalized = new Map<string, string>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return normalized;
  for (const [rawPluginId, rawValue] of Object.entries(value).slice(0, 256)) {
    const pluginId = String(rawPluginId || "").trim().toLowerCase();
    const item = String(rawValue || "").trim().slice(0, valueLimit);
    if (pluginIdPattern.test(pluginId) && item) normalized.set(pluginId, item);
  }
  return normalized;
}

export function updateAgentPluginInventory(
  hostIdValue: unknown,
  value: unknown,
  syncSignaturesValue?: unknown,
  reportedAt = Date.now(),
) {
  const hostId = normalizedHostId(hostIdValue);
  if (!hostId || !value || typeof value !== "object" || Array.isArray(value)) return false;
  const supportsSyncSignatures = !!syncSignaturesValue
    && typeof syncSignaturesValue === "object"
    && !Array.isArray(syncSignaturesValue);
  inventories.set(hostId, {
    versions: normalizePluginValues(value, 64),
    syncSignatures: normalizePluginValues(syncSignaturesValue, 128),
    supportsSyncSignatures,
    reportedAt,
  });
  return true;
}

export function getAgentPluginInventory(hostIdValue: unknown, now = Date.now()): AgentPluginInventory | null {
  const hostId = normalizedHostId(hostIdValue);
  const inventory = inventories.get(hostId);
  if (!inventory) return null;
  if (now - inventory.reportedAt > AGENT_PLUGIN_INVENTORY_TTL_MS) {
    inventories.delete(hostId);
    return null;
  }
  return {
    versions: new Map(inventory.versions),
    syncSignatures: new Map(inventory.syncSignatures),
    supportsSyncSignatures: inventory.supportsSyncSignatures,
    reportedAt: inventory.reportedAt,
  };
}

export function clearAgentPluginInventoriesForTest() {
  inventories.clear();
}
