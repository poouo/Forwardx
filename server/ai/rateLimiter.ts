export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
};

type SlidingWindowRateLimiterOptions = {
  limit: number;
  windowMs: number;
  maxKeys?: number;
  now?: () => number;
};

export class SlidingWindowRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly events = new Map<string, number[]>();

  constructor(options: SlidingWindowRateLimiterOptions) {
    this.limit = Math.max(1, Math.floor(options.limit));
    this.windowMs = Math.max(1_000, Math.floor(options.windowMs));
    this.maxKeys = Math.max(100, Math.floor(options.maxKeys || 10_000));
    this.now = options.now || Date.now;
  }

  consume(keyValue: unknown): RateLimitResult {
    const key = String(keyValue || "").trim() || "anonymous";
    const now = this.now();
    const cutoff = now - this.windowMs;
    const current = (this.events.get(key) || []).filter((timestamp) => timestamp > cutoff);
    if (current.length >= this.limit) {
      this.events.set(key, current);
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(1, current[0] + this.windowMs - now),
      };
    }
    current.push(now);
    this.events.delete(key);
    this.events.set(key, current);
    this.pruneIfNeeded(cutoff);
    return {
      allowed: true,
      remaining: Math.max(0, this.limit - current.length),
      retryAfterMs: 0,
    };
  }

  private pruneIfNeeded(cutoff: number) {
    if (this.events.size <= this.maxKeys) return;
    for (const [key, timestamps] of this.events) {
      const active = timestamps.filter((timestamp) => timestamp > cutoff);
      if (active.length === 0) this.events.delete(key);
      else if (active.length !== timestamps.length) this.events.set(key, active);
      if (this.events.size <= this.maxKeys) return;
    }
    while (this.events.size > this.maxKeys) {
      const oldestKey = this.events.keys().next().value;
      if (oldestKey === undefined) return;
      this.events.delete(oldestKey);
    }
  }

  clear() {
    this.events.clear();
  }
}
