import type { HistoryTrendSegment } from "./latencyHistory";

export type AvailabilityInterval = {
  observationKey: string;
  hostId: number;
  online: boolean;
  startAt: number;
  endAt: number;
  offlineIncident: boolean;
};

/** Timestamps/durations in seconds. Rate excludes unknown observation gaps. */
export type AvailabilityDay = {
  startAt: number; endAt: number; onlineSeconds: number; offlineSeconds: number;
  unknownSeconds: number; observedSeconds: number; offlineCount: number;
  uptimePercent: number | null; coveragePercent: number | null;
  trend?: HistoryTrendSegment[];
};
