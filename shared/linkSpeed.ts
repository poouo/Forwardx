export type LinkSpeedProtocol = "tcp" | "udp";
export type LinkSpeedDirection = "upload" | "download";
export type LinkSpeedState =
  | "preparing"
  | "upload"
  | "download"
  | "completed"
  | "cancelled"
  | "error";
export type LinkSpeedSample = {
  direction: LinkSpeedDirection;
  elapsedMs: number;
  bytes: number;
  mbps: number;
};
export type LinkSpeedMeasurement = {
  bytes: number;
  durationMs: number;
  mbps: number;
  peakMbps: number;
  packets?: number;
  sentPackets?: number;
  lostPackets?: number;
  lossPercent?: number;
  jitterMs?: number;
};
export type LinkSpeedBenchmark = {
  formatVersion: 1;
  panelVersion: string;
  generatedAt: string;
  durationSeconds: number;
  offeredRateMbps: number;
  routeHostIds: number[];
  agentVersions: Record<string, string>;
  methodology: string;
};
export type LinkSpeedStatus = {
  id: string;
  resourceType: "tunnel" | "chain";
  resourceId: number;
  name: string;
  protocol: LinkSpeedProtocol;
  duration: number;
  rateMbps: number;
  state: LinkSpeedState;
  route: { hostId: number; name: string; transport: string; agentVersion?: string; osInfo?: string }[];
  samples: LinkSpeedSample[];
  upload?: LinkSpeedMeasurement;
  download?: LinkSpeedMeasurement;
  benchmark?: LinkSpeedBenchmark;
  error?: string;
  createdAt: string;
  finishedAt?: string;
};
export function linkSpeedActive(state?: LinkSpeedState) {
  return state === "preparing" || state === "upload" || state === "download";
}
