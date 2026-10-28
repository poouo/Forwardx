import { dashboardSummaries, operationsSummaries } from "./backgroundSummaryCache";
import { databaseHealth } from "./databaseHealthState";
import { createNonOverlappingScheduledTask } from "./scheduledTask";

let stop: (() => void) | undefined;
export function startDashboardSummaryRefresh() {
  if (stop) return stop;
  let lastWarning = 0;
  const run = createNonOverlappingScheduledTask("user dashboard summaries", async () => {
    const result = await dashboardSummaries.refreshDue(100);
    const operations = await operationsSummaries.refreshDue(25);
    if ((result.failed + operations.failed) && Date.now() - lastWarning > 60_000) {
      lastWarning = Date.now();
      console.warn(`[DashboardSummary] ${result.failed + operations.failed} refreshes failed; previous summaries retained`);
    }
  }, { shouldRun: () => databaseHealth.snapshot().state === "healthy" });
  // One-second scheduling tick, one-minute data cadence. Each cache has a real
  // bounded waiting slice; slow in-flight DB queries keep their own slots but
  // cannot hold this scheduler (or the other cache) indefinitely.
  const timer = setInterval(() => { void run(); }, 1000);
  timer.unref();
  stop = () => { clearInterval(timer); stop = undefined; };
  return stop;
}
