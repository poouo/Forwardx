import crypto from "crypto";

export type LookingGlassMethod = "ping" | "ping6" | "traceroute" | "traceroute6" | "mtr" | "mtr6" | "tcp";

export type LookingGlassAgentTask = {
  taskId: string;
  method: LookingGlassMethod;
  target: string;
  resolvedAddress: string;
  resolvedAddresses: string[];
  family: number;
  port?: number;
  createdAt: string;
};

export type LookingGlassAgentResult = {
  taskId: string;
  method: LookingGlassMethod;
  target: string;
  port?: number;
  resolvedAddress: string;
  resolvedAddresses: string[];
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  error?: string;
};

const queues = new Map<number, LookingGlassAgentTask[]>();
const pending = new Map<string, {
  hostId: number;
  timer: NodeJS.Timeout;
  resolve: (result: LookingGlassAgentResult) => void;
  reject: (error: Error) => void;
}>();

export function enqueueLookingGlassAgentTask(
  hostId: number,
  input: Omit<LookingGlassAgentTask, "taskId" | "createdAt">,
  timeoutMs = 45_000,
) {
  const task: LookingGlassAgentTask = {
    ...input,
    taskId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const queue = queues.get(hostId) || [];
  queue.push(task);
  queues.set(hostId, queue.slice(-20));

  const promise = new Promise<LookingGlassAgentResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(task.taskId);
      reject(new Error("Agent 执行 Looking Glass 超时，请确认目标主机在线"));
    }, timeoutMs);
    pending.set(task.taskId, { hostId, timer, resolve, reject });
  });

  return { task, promise };
}

export function takeLookingGlassAgentTasks(hostId: number, limit = 4) {
  const queue = queues.get(hostId) || [];
  const tasks = queue.splice(0, limit);
  if (queue.length > 0) queues.set(hostId, queue);
  else queues.delete(hostId);
  return tasks;
}

export function completeLookingGlassAgentTask(hostId: number, result: LookingGlassAgentResult) {
  const item = pending.get(result.taskId);
  if (!item || item.hostId !== hostId) return false;
  clearTimeout(item.timer);
  pending.delete(result.taskId);
  item.resolve(result);
  return true;
}
