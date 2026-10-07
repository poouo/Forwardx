export type ProbeStatistics = {
  total: number;
  successes: number;
  /** No cumulative telemetry means old, state-change-biased history. */
  available: boolean;
  observedSince: Date | null;
  latestAt: Date | null;
};
