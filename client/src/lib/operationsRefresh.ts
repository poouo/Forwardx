import { adaptivePollingInterval } from "./queryPolicy";

export const OPERATIONS_REFRESH_SECONDS = [5, 10, 30, 0] as const;
export type OperationsRefreshSeconds = typeof OPERATIONS_REFRESH_SECONDS[number];
export const DEFAULT_OPERATIONS_REFRESH_SECONDS: OperationsRefreshSeconds = 30;

export function normalizeOperationsRefresh(value: unknown): OperationsRefreshSeconds {
  if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim()) return DEFAULT_OPERATIONS_REFRESH_SECONDS;
  const seconds = Number(value);
  return OPERATIONS_REFRESH_SECONDS.includes(seconds as OperationsRefreshSeconds)
    ? seconds as OperationsRefreshSeconds : DEFAULT_OPERATIONS_REFRESH_SECONDS;
}

export function operationsRefreshStorageKey(userId: number | undefined) {
  return `forwardx.operations.refreshSeconds:${userId || 0}`;
}

export function operationsRefreshInterval(seconds: OperationsRefreshSeconds, visible: boolean, path: string): number | false {
  return visible && path.split("?")[0] === "/operations" && seconds > 0 ? seconds * 1000 : false;
}

export function operationsRefreshOptions(interval: number | false) {
  return {
    refetchInterval: interval === false ? false : adaptivePollingInterval(interval),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  } as const;
}
