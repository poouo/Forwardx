type PendingTask = {
  tail: Promise<void>;
  depth: number;
};

const pendingTasks = new Map<string, PendingTask>();

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

export function keyedTaskDepth(keyValue: unknown) {
  return pendingTasks.get(String(keyValue || "").trim())?.depth || 0;
}

export function clearKeyedTaskLocksForTest() {
  pendingTasks.clear();
}
