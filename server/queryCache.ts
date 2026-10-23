type CacheEntry<T> = {
  freshUntil: number;
  staleUntil: number;
  retryAt: number;
  bytes: number;
  value?: T;
  promise?: Promise<T>;
};

export type CacheQueryOptions = {
  ttlMs: number;
  staleMs?: number;
};

type CacheOptions = {
  maxEntries?: number;
  maxBytes?: number;
  sizeOf?: (value: unknown) => number;
  retryMs?: number;
  now?: () => number;
};

export class QueryCacheBusyError extends Error {
  constructor() { super("Query cache is busy"); }
}

export function createQueryCache(options: number | CacheOptions = 300) {
  const config = typeof options === "number" ? { maxEntries: options } : options;
  const maxEntries = Math.max(1, config.maxEntries ?? 300);
  const maxBytes = config.maxBytes ?? Infinity;
  const clock = config.now ?? Date.now;
  const cache = new Map<string, CacheEntry<unknown>>();
  let bytes = 0;
  let nextPruneAt = clock() + 1000;

  function remove(key: string) {
    const entry = cache.get(key);
    if (entry) bytes -= entry.bytes;
    cache.delete(key);
  }

  // Never evict running loads: doing so would allow duplicate concurrent SQL.
  function trim(reserve = 0) {
    for (const [key, entry] of cache) {
      if (cache.size + reserve <= maxEntries && bytes <= maxBytes) break;
      if (!entry.promise) remove(key);
    }
  }

  function prune(now = clock()) {
    for (const [key, entry] of cache.entries()) {
      if (!entry.promise && entry.staleUntil <= now) remove(key);
    }
    trim();
  }

  function refresh<T>(key: string, opts: Required<CacheQueryOptions>, load: () => Promise<T>) {
    let entry = cache.get(key) as CacheEntry<T> | undefined;
    if (!entry) {
      trim(1);
      if (cache.size >= maxEntries) return Promise.reject(new QueryCacheBusyError());
      entry = { freshUntil: 0, staleUntil: 0, retryAt: 0, bytes: 0 };
      cache.set(key, entry);
    }
    const current = entry;
    const promise = Promise.resolve().then(load)
      .then((value) => {
        // Clearing during an in-flight load must not resurrect its old value.
        if (cache.get(key) !== current) return value;
        const size = config.sizeOf ? config.sizeOf(value) + key.length * 2 : 0;
        // One oversized response should not evict every other user's hot data.
        if (size > maxBytes) { remove(key); return value; }
        bytes -= current.bytes;
        const now = clock();
        Object.assign(current, {
          value, promise: undefined, bytes: size, retryAt: 0,
          freshUntil: now + opts.ttlMs,
          staleUntil: now + opts.ttlMs + opts.staleMs,
        });
        bytes += size;
        trim();
        return value;
      })
      .catch((error) => {
        if (cache.get(key) === current) {
          current.promise = undefined;
          current.retryAt = clock() + (config.retryMs ?? 1000);
          if (current.value === undefined) remove(key);
        }
        throw error;
      });
    current.promise = promise;
    return promise;
  }

  function get<T>(key: string, options: CacheQueryOptions, load: () => Promise<T>): Promise<T> {
    const now = clock();
    // Reclaim expired chart/summary values without scanning the full map on
    // every hot-cache hit or completed query.
    if (now >= nextPruneAt) { prune(now); nextPruneAt = now + 1000; }
    const opts = { ttlMs: options.ttlMs, staleMs: options.staleMs ?? options.ttlMs };
    const cached = cache.get(key) as CacheEntry<T> | undefined;
    if (cached) { cache.delete(key); cache.set(key, cached); }
    if (cached?.value !== undefined && cached.freshUntil > now) {
      return Promise.resolve(cached.value);
    }
    if (cached?.value !== undefined && cached.staleUntil > now) {
      if (!cached.promise && cached.retryAt <= now) refresh(key, opts, load).catch(() => undefined);
      return Promise.resolve(cached.value);
    }
    if (cached?.promise) return cached.promise;
    return refresh(key, opts, load);
  }

  function clear(matches?: (key: string) => boolean) {
    if (!matches) { cache.clear(); bytes = 0; return; }
    for (const key of cache.keys()) if (matches(key)) remove(key);
  }

  return { get, prune, clear, size: () => cache.size, bytes: () => bytes };
}
