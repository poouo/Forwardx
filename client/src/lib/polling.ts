export const POLLING_INTERVALS = {
  realtime: 1_000,
  interactive: 1_500,
  live: 2_000,
  active: 3_000,
  fast: 5_000,
  log: 10_000,
  normal: 15_000,
  slow: 30_000,
} as const;

export type PollingIntervalName = keyof typeof POLLING_INTERVALS;
export type QueryPollingInterval = number | false;

export function pollingInterval(name: PollingIntervalName, enabled = true): QueryPollingInterval {
  return enabled ? POLLING_INTERVALS[name] : false;
}

export function visiblePollingInterval(name: PollingIntervalName, visible = true): QueryPollingInterval {
  return pollingInterval(name, visible);
}
