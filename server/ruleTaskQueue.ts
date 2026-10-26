import { createHash, randomUUID } from "node:crypto";
import type { RuleTaskAction, RuleTaskResult, RuleTaskSnapshot } from "../shared/ruleTaskQueue";
import type { SessionKind } from "./session";

export type RuleTaskActor = { userId: number; sid: string | null; kind: SessionKind; dev: boolean; requestId: string };
type Job = {
  actor: RuleTaskActor; hash: string; actions: RuleTaskAction[];
  snapshot: RuleTaskSnapshot; results: RuleTaskResult[]; cancel: boolean; payloadBytes: number;
};
type Options = { maxJobs?: number; maxPendingItems?: number; maxUserJobs?: number; retentionMs?: number };
export const RULE_TASK_INSTANCE_ID = randomUUID();
export class RuleTaskStopError extends Error {}
export class RuleTaskAuthorizationError extends RuleTaskStopError {}

/** One global writer, rotating jobs after each item so a large import cannot
 * starve other users. No request/response objects or credentials are retained.
 */
export class RuleTaskQueue {
  private jobs = new Map<string, Job>();
  private ready: string[] = [];
  private active: string | null = null;
  private draining = false;
  constructor(private execute: (actor: RuleTaskActor, action: RuleTaskAction) => Promise<RuleTaskResult["value"]>, private options: Options = {}) {}

  private prune() {
    const cutoff = Date.now() - (this.options.retentionMs ?? 15 * 60_000);
    for (const [id, job] of this.jobs) if (job.snapshot.finishedAt && job.snapshot.finishedAt < cutoff) this.jobs.delete(id);
  }
  enqueue(actor: RuleTaskActor, request: { requestId: string; title: string; actions: RuleTaskAction[] }) {
    this.prune();
    const json = JSON.stringify(request);
    if (Buffer.byteLength(json) > 2 * 1024 * 1024 || !request.actions.length || request.actions.length > 5000) throw Error("批量任务过大，请拆分后提交");
    const payloadBytes = Buffer.byteLength(json);
    const hash = createHash("sha256").update(json).digest("hex");
    for (const job of this.jobs.values()) if (job.actor.userId === actor.userId && job.snapshot.requestId === request.requestId) {
      if (job.hash !== hash) throw Error("同一提交标识不能用于不同任务");
      return this.snapshot(job);
    }
    let pending = 0, own = 0, pendingBytes = 0, retainedItems = 0;
    for (const job of this.jobs.values()) retainedItems += job.snapshot.total;
    for (const job of this.jobs.values()) if (!job.snapshot.finishedAt) {
      pending += job.snapshot.total - job.snapshot.completed;
      pendingBytes += job.payloadBytes;
      if (job.actor.userId === actor.userId) own++;
    }
    if (own >= (this.options.maxUserJobs ?? 3) || pending + request.actions.length > (this.options.maxPendingItems ?? 20_000) || pendingBytes + payloadBytes > 8 * 1024 * 1024) throw Error("执行队列已满，请等待现有任务完成");
    // Reclaim oldest completed jobs first; never evict accepted pending work.
    for (const [id, job] of this.jobs) {
      if (this.jobs.size < (this.options.maxJobs ?? 100) && retainedItems + request.actions.length <= 20_000) break;
      if (job.snapshot.finishedAt) { this.jobs.delete(id); retainedItems -= job.snapshot.total; }
    }
    if (this.jobs.size >= (this.options.maxJobs ?? 100) || retainedItems + request.actions.length > 20_000) throw Error("执行队列已满，请稍后再试");
    const id = randomUUID();
    const job: Job = { actor: { ...actor }, hash, actions: structuredClone(request.actions), results: [], cancel: false, payloadBytes,
      snapshot: { id, requestId: request.requestId, title: request.title, state: "queued", total: request.actions.length,
        completed: 0, succeeded: 0, failed: 0, skipped: 0, cancelled: 0, queuePosition: 0, createdAt: Date.now() } };
    this.jobs.set(id, job); this.ready.push(id);
    // Start after the enqueue response, not while the user waits for SQL.
    setImmediate(() => { void this.drain(); });
    return this.snapshot(job);
  }
  private snapshot(job: Job): RuleTaskSnapshot {
    return { ...job.snapshot, queuePosition: job.snapshot.finishedAt || this.active === job.snapshot.id ? 0 : this.ready.indexOf(job.snapshot.id) + 1,
      ...(job.snapshot.finishedAt ? { results: job.results.map(row => ({ ...row, ...(row.value ? { value: { ...row.value } } : {}) })) } : {}) };
  }
  get(userId: number, id: string) {
    this.prune(); const job = this.jobs.get(id);
    return job?.actor.userId === userId ? this.snapshot(job) : null;
  }
  lookup(userId: number, requestId: string) {
    this.prune();
    for (const job of this.jobs.values()) if (job.actor.userId === userId && job.snapshot.requestId === requestId) return this.snapshot(job);
    return null;
  }
  cancel(userId: number, id: string) {
    const job = this.jobs.get(id);
    if (!job || job.actor.userId !== userId) return null;
    if (!job.snapshot.finishedAt) { job.cancel = true; setImmediate(() => { void this.drain(); }); }
    return this.snapshot(job);
  }
  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.ready.length) {
        const id = this.ready.shift()!, job = this.jobs.get(id)!;
        this.active = id;
        if (!job.cancel) {
          const index = job.snapshot.completed;
          job.snapshot.state = "running";
          let result: RuleTaskResult;
          try {
            const value = await this.execute(job.actor, job.actions[index]);
            result = { index, status: value?.skipped ? "skipped" : "succeeded", value };
          } catch (error) {
            // Never blindly replay a write whose commit outcome is unknown.
            result = { index, status: "failed", error: (error instanceof Error ? error.message : "执行失败").slice(0, 300) };
            if (error instanceof RuleTaskStopError) job.cancel = true;
          }
          job.results.push(result); job.snapshot.completed++;
          if (result.status === "failed") job.snapshot.failed++;
          else if (result.status === "skipped") job.snapshot.skipped++;
          else job.snapshot.succeeded++;
          // Release potentially large rule payloads as soon as they settle.
          job.actions[index] = undefined as any;
        }
        if (job.cancel) {
          while (job.snapshot.completed < job.snapshot.total) {
            job.results.push({ index: job.snapshot.completed++, status: "cancelled" }); job.snapshot.cancelled++;
          }
        }
        if (job.snapshot.completed === job.snapshot.total) {
          job.snapshot.state = job.snapshot.cancelled > 0 ? "cancelled" : "completed"; job.snapshot.finishedAt = Date.now(); job.actions = []; job.payloadBytes = 0;
        } else this.ready.push(id);
        this.active = null;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    } finally { this.active = null; this.draining = false; }
  }
}
