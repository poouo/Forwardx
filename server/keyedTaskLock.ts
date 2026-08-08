import { AsyncLocalStorage } from "node:async_hooks";

type PendingTask = {
  tail: Promise<void>;
  depth: number;
};

const pendingTasks = new Map<string, PendingTask>();
type TrafficBillingLockToken = { active: boolean };
const trafficBillingLockContext = new AsyncLocalStorage<Map<string, TrafficBillingLockToken>>();

export function trafficBillingUserLockKey(userId: unknown) {
  const id = Number(userId || 0);
  return `traffic-billing-user:${Number.isFinite(id) && id > 0 ? Math.floor(id) : 0}`;
}

export async function withKeyedTaskLock<T>(keyValue: unknown, task: () => Promise<T>): Promise<T> {
  const key = String(keyValue || "").trim();
  if (!key) return task();

  const previous = pendingTasks.get(key);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const current: PendingTask = {
    tail: gate,
    depth: (previous?.depth || 0) + 1,
  };
  pendingTasks.set(key, current);

  if (previous) await previous.tail;
  try {
    return await task();
  } finally {
    release();
    if (pendingTasks.get(key) === current) pendingTasks.delete(key);
  }
}

export async function withTrafficBillingUserLock<T>(userId: unknown, task: () => Promise<T>): Promise<T> {
  const key = trafficBillingUserLockKey(userId);
  const inheritedLocks = trafficBillingLockContext.getStore();
  if (inheritedLocks?.get(key)?.active) return task();

  return withKeyedTaskLock(key, () => {
    const token = { active: true };
    const heldLocks = new Map(inheritedLocks);
    heldLocks.set(key, token);
    return trafficBillingLockContext.run(heldLocks, async () => {
      try {
        return await task();
      } finally {
        token.active = false;
      }
    });
  });
}

export function keyedTaskDepth(keyValue: unknown) {
  return pendingTasks.get(String(keyValue || "").trim())?.depth || 0;
}

export function clearKeyedTaskLocksForTest() {
  pendingTasks.clear();
}
