import { z } from "zod";
import type { IpSwitchHook } from "../shared/hostChinaHealth";
import { setBoundedMapValue } from "./boundedCache";
import { pushAgentRefresh } from "./agentEvents";
import { panelCryptoNowMs } from "./panelClock";

export const ipSwitchResultSchema = z.object({
  taskId: z.string().uuid(), outcome: z.enum(["accepted", "verified", "uncertain", "not_executed"]),
  reason: z.enum(["ok", "invalid_request", "expired", "duplicate", "state_unavailable", "claim_denied", "request_failed", "http_status", "invalid_response", "success_mismatch", "invalid_ip"]),
  httpStatus: z.number().int().min(0).max(599).optional(), newIp: z.string().max(64).optional(),
}).strict();
export type IpSwitchAgentResult = z.infer<typeof ipSwitchResultSchema>;
export type IpSwitchAgentTask = { taskId: string; serviceId: number; expiresAt: number; request: IpSwitchHook };
type Pending = { taskId: string; serviceId: number; expectedIp: string; expiresAt: number; task?: IpSwitchAgentTask; delivered: boolean; claimStarted: boolean; claimed: boolean; resolve: (result: IpSwitchAgentResult) => void; timer: ReturnType<typeof setTimeout> };
const capabilities = new Map<number, number>();
const pending = new Map<number, Pending>();
export function recordIpSwitchAgentCapability(hostId: number, supported: unknown) {
  if (supported === true) setBoundedMapValue(capabilities, hostId, Date.now(), 50000);
  else capabilities.delete(hostId);
}
export function ipSwitchAgentReady(hostId: number) { return Date.now() - (capabilities.get(hostId) || 0) < 300000; }
export class IpSwitchNotDispatchedError extends Error {}
export function enqueueIpSwitchAgentTask(hostId: number, input: Omit<IpSwitchAgentTask, "expiresAt"> & { expectedIp: string }, timeoutMs = 120000): Promise<IpSwitchAgentResult> {
  if (!ipSwitchAgentReady(hostId) || pending.has(hostId)) throw new IpSwitchNotDispatchedError("agent_unavailable");
  return new Promise(resolve => {
    const expiresAt = Math.ceil((panelCryptoNowMs() + Math.min(timeoutMs, 60000)) / 1000);
    const timer = setTimeout(() => {
      const current = pending.get(hostId);
      if (current?.taskId !== input.taskId) return;
      pending.delete(hostId);
      resolve({ taskId: input.taskId, outcome: current.delivered ? "uncertain" : "not_executed", reason: "expired" });
    }, timeoutMs);
    timer.unref?.();
    pending.set(hostId, { taskId: input.taskId, serviceId: input.serviceId, expectedIp: input.expectedIp, task: { taskId: input.taskId, serviceId: input.serviceId, request: input.request, expiresAt }, expiresAt, delivered: false, claimStarted: false, claimed: false, resolve, timer });
    console.info(`[ChinaHealth] host=${hostId} service=${input.serviceId} task=${input.taskId} stage=queued 换 IP 任务已排队，等待 Agent 领取；尚未请求商家接口`);
    pushAgentRefresh(hostId, "china-health-ip-switch");
  });
}
export function hasQueuedIpSwitchAgentTasks(hostId: number) { return !!pending.get(hostId)?.task; }
export function takeIpSwitchAgentTasks(hostId: number) {
  const current = pending.get(hostId);
  if (!current?.task || !ipSwitchAgentReady(hostId)) return [];
  if (current.expiresAt <= panelCryptoNowMs() / 1000) {
    completeIpSwitchAgentTask(hostId, { taskId: current.taskId, outcome: "not_executed", reason: "expired" });
    return [];
  }
  const task = current.task;
  current.task = undefined;
  current.delivered = true;
  console.info(`[ChinaHealth] host=${hostId} service=${current.serviceId} task=${current.taskId} stage=dispatched 换 IP 任务已下发，是否开始请求以 Agent 日志为准`);
  return [task];
}
export async function claimIpSwitchAgentTask(hostId: number, taskId: string, validate: (serviceId: number, taskId: string, expectedIp: string) => Promise<boolean>) {
  const current = pending.get(hostId);
  if (!current || current.taskId !== taskId || !current.delivered || current.claimStarted || current.expiresAt <= panelCryptoNowMs() / 1000) return false;
  current.claimStarted = true; // Never retry a lost claim response: the action may be billable.
  current.claimed = await validate(current.serviceId, taskId, current.expectedIp) && pending.get(hostId) === current;
  return current.claimed;
}
export function completeIpSwitchAgentTask(hostId: number, input: unknown) {
  const parsed = ipSwitchResultSchema.safeParse(input);
  if (!parsed.success) return false;
  const current = pending.get(hostId), result = parsed.data;
  if (!current || current.taskId !== result.taskId || (!current.delivered && result.reason !== "expired")) return false;
  if (["accepted", "verified"].includes(result.outcome) && !current.claimed) return false;
  clearTimeout(current.timer); pending.delete(hostId); current.resolve(result);
  return true;
}
