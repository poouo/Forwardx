import { FORWARD_TYPES, type ForwardType } from "../shared/forwardTypes";
import { setBoundedMapValue } from "./boundedCache";
import { appendPanelLog } from "./_core/panelLogger";

const TTL_MS = 3 * 60_000;
const inventories = new Map<number, { tools: Partial<Record<ForwardType, boolean>>; checkedAt: number }>();
const loggedInventories = new Map<number, {signature:string;at:number}>();

export function updateAgentToolInventory(hostId: number, value: unknown, checkedAtValue: unknown, now = Date.now()) {
  if (!Number.isSafeInteger(hostId) || hostId <= 0 || !value || typeof value !== "object" || Array.isArray(value)) return;
  const checkedAt = Number(checkedAtValue);
  if (!Number.isSafeInteger(checkedAt) || checkedAt > now + 30_000 || checkedAt < now - TTL_MS) return;
  const tools: Partial<Record<ForwardType, boolean>> = {};
  for (const type of FORWARD_TYPES) {
    const available = (value as Record<string, unknown>)[type];
    if (typeof available === "boolean") tools[type] = available;
  }
  if (Object.keys(tools).length === 0) return;
  const existing = inventories.get(hostId);
  if (existing && existing.checkedAt > checkedAt) return;
  for (const [id, inventory] of inventories) if (now - inventory.checkedAt > TTL_MS) inventories.delete(id);
  setBoundedMapValue(inventories, hostId, {tools, checkedAt}, 5000);
  const signature = FORWARD_TYPES.map((type) => `${type}:${tools[type] ?? "unknown"}`).join(",");
  const logged = loggedInventories.get(hostId);
  if ((!logged || logged.signature !== signature) && (!logged || now - logged.at >= 60_000)) {
    setBoundedMapValue(loggedInventories,hostId,{signature,at:now},5000);
    appendPanelLog(logged ? "warn" : "info",`[AgentTools] host=${hostId} executable inventory ${logged ? "changed" : "received"} ${signature}; discovery only, not a runtime health check`);
  }
}

export function getAgentToolAvailability(hostId: number, type: ForwardType, now = Date.now()) {
  const inventory = inventories.get(hostId);
  if (!inventory || now - inventory.checkedAt > TTL_MS) {
    inventories.delete(hostId);
    return { status: "unknown" as const, checkedAt: null };
  }
  const value = inventory.tools[type];
  return { status: value === true ? "available" as const : value === false ? "missing" as const : "unknown" as const, checkedAt: inventory.checkedAt };
}
