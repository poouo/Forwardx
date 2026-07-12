export type AgentPluginInventory = {
  versions: ReadonlyMap<string, string>;
  reportedAt: number;
};

const AGENT_PLUGIN_INVENTORY_TTL_MS = 2 * 60 * 1000;
const inventories = new Map<number, { versions: Map<string, string>; reportedAt: number }>();
const pluginIdPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function normalizedHostId(value: unknown) {
  const hostId = Number(value);
  return Number.isInteger(hostId) && hostId > 0 ? hostId : 0;
}

export function updateAgentPluginInventory(hostIdValue: unknown, value: unknown, reportedAt = Date.now()) {
  const hostId = normalizedHostId(hostIdValue);
  if (!hostId || !value || typeof value !== "object" || Array.isArray(value)) return false;
  const versions = new Map<string, string>();
  for (const [rawPluginId, rawVersion] of Object.entries(value).slice(0, 256)) {
    const pluginId = String(rawPluginId || "").trim().toLowerCase();
    const version = String(rawVersion || "").trim().slice(0, 64);
    if (pluginIdPattern.test(pluginId) && version) versions.set(pluginId, version);
  }
  inventories.set(hostId, { versions, reportedAt });
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
  return { versions: new Map(inventory.versions), reportedAt: inventory.reportedAt };
}

export function clearAgentPluginInventoriesForTest() {
  inventories.clear();
}
