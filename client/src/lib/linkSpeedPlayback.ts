import type { LinkSpeedSample, LinkSpeedStatus } from "../../../shared/linkSpeed";

/** Bounded playback buffer: measured points retain their timing, stalls catch up. */
export class LinkSpeedPlayback {
  id = "";
  count = 0;
  private seen = 0;
  private queue: { count: number; at: number }[] = [];

  get pending() {
    return this.queue.length > 0;
  }

  receive(status: LinkSpeedStatus, now: number, animated = true) {
    const fresh = this.id !== status.id || status.samples.length < this.seen;
    if (fresh) {
      this.id = status.id;
      this.count = this.seen = 0;
      this.queue = [];
    }
    if (!animated || status.state === "error" || status.state === "cancelled" ||
      (fresh && status.state === "completed")) {
      this.count = this.seen = status.samples.length;
      this.queue = [];
      return;
    }
    this.advance(now);
    for (let i = this.seen; i < status.samples.length; i++) {
      const previous: LinkSpeedSample | undefined = status.samples[i - 1];
      const current = status.samples[i];
      const gap = previous?.direction === current.direction
        ? Math.max(1, Math.min(500, current.elapsedMs - previous.elapsedMs))
        : 100;
      const at = Math.max(now, this.queue.at(-1)?.at ?? now) + gap;
      this.queue.push({ count: i + 1, at });
    }
    this.seen = status.samples.length;
    // Resume/reopen/network stalls must not leave the dial seconds behind.
    const end = this.queue.at(-1)?.at ?? now;
    const shift = Math.max(0, end - now - 600);
    if (shift) for (const point of this.queue) point.at -= shift;
    this.advance(now);
  }

  advance(now: number) {
    while (this.queue.length && this.queue[0].at <= now) {
      this.count = this.queue.shift()!.count;
    }
  }
}
