import { TRPCError } from "@trpc/server";
import { SERVICE_BUSY_MESSAGE } from "../shared/databaseHealth";

// Bounds waiting work as well as active work. Never time out a running SQL
// operation: its slot must stay occupied until the driver really finishes.
export function createRequestWorkPool({ concurrency, maxQueued, queueTimeoutMs }: {
  concurrency: number; maxQueued: number; queueTimeoutMs: number;
}) {
  let active = 0;
  const queue = new Set<{ start: () => void }>();
  const busy = () => new TRPCError({ code: "SERVICE_UNAVAILABLE", message: SERVICE_BUSY_MESSAGE });
  async function run<T>(load: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      if (queue.size >= maxQueued) throw busy();
      await new Promise<void>((resolve, reject) => {
        const waiter = { start: () => { clearTimeout(timer); active++; resolve(); } };
        const timer = setTimeout(() => { queue.delete(waiter); reject(busy()); }, queueTimeoutMs);
        queue.add(waiter);
      });
    } else active++;
    try { return await load(); }
    finally {
      active--;
      const waiter = queue.values().next().value;
      if (waiter) { queue.delete(waiter); waiter.start(); }
    }
  }
  return { run, stats: () => ({ active, queued: queue.size }) };
}
