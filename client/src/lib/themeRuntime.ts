import { useSyncExternalStore } from "react";
import type { ThemeDefinition } from "@shared/themes";

let current: ThemeDefinition | null = null;
const listeners = new Set<() => void>();
export function setThemeRuntime(definition: ThemeDefinition | null) {
  if (current === definition) return;
  current = definition;
  listeners.forEach(listener => listener());
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useThemeDefinition() {
  return useSyncExternalStore(subscribe, () => current, () => null);
}
