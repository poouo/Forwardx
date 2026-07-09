import type { PluginExtensionPoint, PluginPermissionKey } from "../shared/pluginTypes";

type PluginEventHandler = (payload: unknown) => void | Promise<void>;

const pluginEventHandlers = new Map<string, PluginEventHandler[]>();

export type PluginRuntimeContext = {
  pluginId: string;
  permissions: PluginPermissionKey[];
  extensionPoints: PluginExtensionPoint[];
};

export function registerPluginEventHandler(event: string, handler: PluginEventHandler) {
  const key = String(event || "").trim();
  if (!key) throw new Error("Plugin event name is required");
  const handlers = pluginEventHandlers.get(key) || [];
  handlers.push(handler);
  pluginEventHandlers.set(key, handlers);
  return () => {
    const next = (pluginEventHandlers.get(key) || []).filter((item) => item !== handler);
    if (next.length) pluginEventHandlers.set(key, next);
    else pluginEventHandlers.delete(key);
  };
}

export async function emitPluginEvent(event: string, payload: unknown) {
  const handlers = pluginEventHandlers.get(String(event || "").trim()) || [];
  for (const handler of handlers) {
    await handler(payload);
  }
}

export function createPluginRuntimeContext(input: PluginRuntimeContext) {
  const permissionSet = new Set(input.permissions);
  const extensionSet = new Set(input.extensionPoints);
  return {
    pluginId: input.pluginId,
    hasPermission(permission: PluginPermissionKey) {
      return permissionSet.has(permission);
    },
    requirePermission(permission: PluginPermissionKey) {
      if (!permissionSet.has(permission)) {
        throw new Error(`Plugin ${input.pluginId} missing permission ${permission}`);
      }
    },
    hasExtensionPoint(point: PluginExtensionPoint) {
      return extensionSet.has(point);
    },
    requireExtensionPoint(point: PluginExtensionPoint) {
      if (!extensionSet.has(point)) {
        throw new Error(`Plugin ${input.pluginId} missing extension point ${point}`);
      }
    },
  };
}
