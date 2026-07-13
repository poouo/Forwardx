type TaskFactory<T> = () => Promise<T>;

export class KeyedTaskDispatcher {
  private readonly concurrency: number;
  private readonly keyTails = new Map<string, Promise<void>>();
  private readonly slotWaiters: Array<() => void> = [];
  private readonly idleWaiters: Array<() => void> = [];
  private activeSlots = 0;
  private pendingTasks = 0;

  constructor(concurrencyValue: number) {
    this.concurrency = Math.max(1, Math.floor(Number(concurrencyValue) || 1));
  }

  get pendingCount() {
    return this.pendingTasks;
  }

  get activeCount() {
    return this.activeSlots;
  }

  private async acquireSlot() {
    if (this.activeSlots < this.concurrency) {
      this.activeSlots += 1;
      return;
    }
    await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
  }

  private releaseSlot() {
    const next = this.slotWaiters.shift();
    if (next) {
      next();
      return;
    }
    this.activeSlots = Math.max(0, this.activeSlots - 1);
  }

  enqueue<T>(keyValue: unknown, task: TaskFactory<T>): Promise<T> {
    const key = String(keyValue || "").trim() || "default";
    const previous = this.keyTails.get(key) || Promise.resolve();
    this.pendingTasks += 1;

    const result = previous
      .catch(() => undefined)
      .then(async () => {
        await this.acquireSlot();
        try {
          return await task();
        } finally {
          this.releaseSlot();
        }
      });

    let tail!: Promise<void>;
    tail = result
      .then(() => undefined, () => undefined)
      .finally(() => {
        if (this.keyTails.get(key) === tail) this.keyTails.delete(key);
        this.pendingTasks = Math.max(0, this.pendingTasks - 1);
        if (this.pendingTasks === 0) {
          for (const resolve of this.idleWaiters.splice(0)) resolve();
        }
      });
    this.keyTails.set(key, tail);
    return result;
  }

  async waitForIdle() {
    if (this.pendingTasks === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }
}
