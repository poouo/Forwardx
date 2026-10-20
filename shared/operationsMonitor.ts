import { z } from "zod";

export const operationsMonitorSchema = z.object({
  enabled: z.boolean().default(false), notify: z.boolean().default(true),
  notifyUserId: z.number().int().positive().nullable().default(null),
  cpu: z.number().min(0).max(100).default(90), memory: z.number().min(0).max(100).default(90), disk: z.number().min(0).max(100).default(90),
  durationSeconds: z.number().int().min(60).max(3600).default(300),
  recoverySeconds: z.number().int().min(30).max(600).default(60),
}).strict();
export type OperationsMonitorSettings = z.infer<typeof operationsMonitorSchema>;
export const defaultOperationsMonitor = operationsMonitorSchema.parse({});
export type ResourceAlertState = { phase: "pending" | "active" | "recovering"; since: number; lastSeen: number; peak: number };

/** Missing samples never count as sustained overload/recovery. Five points of hysteresis. */
export function advanceResourceAlert(previous: ResourceAlertState | null, value: number, threshold: number, now: number, duration: number, recovery: number): { state: ResourceAlertState | null; event?: "triggered" | "recovered" } {
  if (!threshold || !Number.isFinite(value) || value < 0 || value > 100) return { state: null };
  const continuous = previous && now >= previous.lastSeen && now - previous.lastSeen <= 120;
  const active = previous?.phase === "active" || previous?.phase === "recovering";
  if (active) {
    const peak = Math.max(previous!.peak, value);
    if (value > Math.max(0, threshold - 5)) return { state: { phase: "active", since: previous!.since, lastSeen: now, peak } };
    const since = continuous && previous!.phase === "recovering" ? previous!.since : now;
    if (now - since >= recovery) return { state: null, event: "recovered" };
    return { state: { phase: "recovering", since, lastSeen: now, peak } };
  }
  if (value < threshold) return { state: null };
  const since = continuous && previous?.phase === "pending" ? previous.since : now;
  const peak = continuous && previous ? Math.max(previous.peak, value) : value;
  if (now - since >= duration) return { state: { phase: "active", since, lastSeen: now, peak }, event: "triggered" };
  return { state: { phase: "pending", since, lastSeen: now, peak } };
}
