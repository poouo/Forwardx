type CacheEntry<T> = {
  freshUntil: number;
  staleUntil: number;
  value?: T;
  promise?: Promise<T>;
};

export type CacheQueryOptions = {
  ttlMs: number;
  staleMs?: number;
};

export function createQueryCache(maxEntries = 300) {
  const cache = new Map<string, CacheEntry<unknown>>();

  function prune(now = Date.now()) {
    for (const [key, entry] of cache.entries()) {
      if (!entry.promise && entry.staleUntil <= now) cache.delete(key);
    }
    if (cache.size <= maxEntries) return;
    const removable = Array.from(cache.entries())
      .filter(([, entry]) => !entry.promise)
      .sort((a, b) => a[1].staleUntil - b[1].staleUntil);
    for (const [key] of removable.slice(0, cache.size - maxEntries)) {
      cache.delete(key);
    }
  }

  function refresh<T>(key: string, opts: Required<CacheQueryOptions>, load: () => Promise<T>) {
    const promise = load()
      .then((value) => {
        const now = Date.now();
        cache.set(key, {
          value,
          freshUntil: now + opts.ttlMs,
          staleUntil: now + opts.ttlMs + opts.staleMs,
        });
        prune();
        return value;
      })
      .catch((error) => {
        const cached = cache.get(key) as CacheEntry<T> | undefined;
        if (cached?.value !== undefined) {
          cache.set(key, { ...cached, promise: undefined });
        } else if (cached?.promise === promise) {
          cache.delete(key);
        }
        throw error;
      });
    const existing = cache.get(key) as CacheEntry<T> | undefined;
    cache.set(key, {
      value: existing?.value,
      promise,
      freshUntil: existing?.freshUntil ?? 0,
      staleUntil: existing?.staleUntil ?? 0,
    });
    return promise;
  }

  function get<T>(key: string, options: CacheQueryOptions, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const opts = { ttlMs: options.ttlMs, staleMs: options.staleMs ?? options.ttlMs };
    const cached = cache.get(key) as CacheEntry<T> | undefined;
    if (cached?.value !== undefined && cached.freshUntil > now) {
      return Promise.resolve(cached.value);
    }
    if (cached?.value !== undefined && cached.staleUntil > now) {
      if (!cached.promise) refresh(key, opts, load).catch(() => undefined);
      return Promise.resolve(cached.value);
    }
    if (cached?.promise) return cached.promise;
    return refresh(key, opts, load);
  }

  function clear() {
    cache.clear();
  }

  return { get, prune, clear };
}
