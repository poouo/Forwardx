import { structuredLinkTestMessage } from "./linkTestMessages";
import { getTunnelMultiEntryHopDetails } from "./tunnelMultiEntryLatencyState";

/** Publish the same live samples as the total, never a previous manual test. */
export function tunnelMultiEntryProbeMessage(input: {
  tunnelId: number;
  expectedEntryHostIds: number[];
  hopCount: number;
  generation: string;
  pathKey?: string;
  totalLatencyMs: number | null;
}) {
  const samples = getTunnelMultiEntryHopDetails(input);
  if (!samples?.length) return null;
  const reported = new Set(samples.filter(sample => sample.hopIndex === 0).map(sample => sample.fromHostId));
  const missingEntryHostIds = [...new Set(input.expectedEntryHostIds)].filter(id => !reported.has(id));
  const firstTarget = samples.find(sample => sample.hopIndex === 0)?.toHostId
    || samples.find(sample => sample.hopIndex === 1)?.fromHostId;
  const details = samples.map(sample => ({
    ...sample,
    success: !sample.isTimeout && Number(sample.latencyMs) > 0,
    pending: false,
    message: sample.isTimeout ? "隧道跳探测超时" : null,
    hopLabel: `${sample.hopIndex + 1}/${sample.hopCount} ${sample.fromHostId}->${sample.toHostId}`,
    method: "tcp",
  }));
  // No report is not a failed TCP probe: retain that distinction in the UI,
  // without writing fabricated timeouts or packet-loss samples to history.
  for (const hostId of missingEntryHostIds) details.push({
    fromHostId: hostId, toHostId: firstTarget || null, hopIndex: 0, hopCount: input.hopCount,
    latencyMs: null, isTimeout: false, recordedAt: 0, success: false, pending: false,
    message: "未收到探测结果", hopLabel: `1/${input.hopCount} ${hostId}->${firstTarget}`, method: "tcp",
  });
  details.sort((a, b) => a.hopIndex - b.hopIndex || Number(a.fromHostId) - Number(b.fromHostId));
  return {
    missingEntryHostIds,
    sampleAgeMs: Date.now() - Math.min(...samples.map(sample => sample.recordedAt)),
    message: structuredLinkTestMessage({
      kind: "tunnel-entry-group-summary", tunnelId: input.tunnelId, details,
      totalLatencyMs: input.totalLatencyMs,
      message: missingEntryHostIds.length ? "部分入口尚未回报探测结果" : "多入口隧道探测结果",
    }),
  };
}
