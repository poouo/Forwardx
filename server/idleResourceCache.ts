type Entry<V> = {
  value: Promise<V>;
  users: number;
  failed: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

// Large, reconstructible resources only. Each caller holds a lease until its
// asynchronous work ends; idle eviction cannot invalidate an active lookup.
export class IdleResourceCache<K, V> {
  private readonly entries = new Map<K, Entry<V>>();

  constructor(private readonly load: (key: K) => Promise<V>, private readonly idleMs: number) {
    if (!Number.isFinite(idleMs) || idleMs <= 0) throw new Error("Invalid resource idle timeout");
  }

  async use<T>(key: K, work: (value: V) => T | Promise<T>): Promise<T> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { value: Promise.resolve().then(() => this.load(key)), users: 0, failed: false };
      this.entries.set(key, entry);
    }
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
    entry.users++;
    try {
      let value: V;
      try { value = await entry.value; } catch (error) { entry.failed = true; throw error; }
      return await work(value);
    } finally {
      entry.users--;
      if (entry.users === 0) {
        if (entry.failed) {
          // Do not keep a rejected promise forever: repaired assets can retry.
          this.entries.delete(key);
        } else {
          entry.timer = setTimeout(() => { this.entries.delete(key); }, this.idleMs);
          entry.timer.unref();
        }
      }
    }
  }
}
