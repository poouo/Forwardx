import crypto from "crypto";

export type Iperf3TaskOp = "start" | "stop";
export type Iperf3ServerState = "idle" | "queued" | "starting" | "running" | "stopping" | "stopped" | "error";

export type Iperf3AgentTask = {
  taskId: string;
  op: Iperf3TaskOp;
  port: number;
  createdAt: string;
};

export type Iperf3AgentResult = {
  taskId: string;
  op: Iperf3TaskOp;
  port: number;
  status: "running" | "stopped" | "error";
  output: string;
  pid?: number | null;
  startedAt?: string;
  updatedAt?: string;
  error?: string;
};

export type Iperf3Status = {
  taskId?: string;
  state: Iperf3ServerState;
  port: number;
  output: string;
  pid?: number | null;
  startedAt?: string;
  updatedAt: string;
  error?: string;
};

type Iperf3State = Iperf3Status & {
  hostId: number;
  timer?: NodeJS.Timeout;
};

const AUTO_IPERF3_PORT = 0;
const queues = new Map<number, Iperf3AgentTask[]>();
const states = new Map<number, Iperf3State>();

function nowIso() {
  return new Date().toISOString();
}

function toStatus(state?: Iperf3State): Iperf3Status {
  if (!state) {
    return {
      state: "idle",
      port: AUTO_IPERF3_PORT,
      output: "iperf3 服务端未启动",
      updatedAt: nowIso(),
    };
  }
  return {
    taskId: state.taskId,
    state: state.state,
    port: state.port,
    output: state.output,
    pid: state.pid,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    error: state.error,
  };
}

function markTimeout(hostId: number, taskId: string) {
  const state = states.get(hostId);
  if (!state || state.taskId !== taskId || state.state === "running" || state.state === "stopped") return;
  state.state = "error";
  state.error = "Agent 未在超时时间内回报 iperf3 服务端状态";
  state.output = state.error;
  state.updatedAt = nowIso();
}

export function enqueueIperf3AgentTask(hostId: number, input: { op: Iperf3TaskOp; port?: number }, timeoutMs = 30_000) {
  const current = states.get(hostId);
  if (input.op === "start" && current && (current.state === "queued" || current.state === "starting" || current.state === "running" || current.state === "stopping")) {
    throw new Error("该测试主机已有 iperf3 服务端任务正在执行，请等待完成或停止后再重试");
  }
  if (input.op === "stop" && current && (current.state === "queued" || current.state === "starting" || current.state === "stopping")) {
    throw new Error("该测试主机已有 iperf3 服务端任务正在处理，请稍后再试");
  }
  const port = input.port === undefined || input.port === null ? AUTO_IPERF3_PORT : Number(input.port);
  const task: Iperf3AgentTask = {
    taskId: crypto.randomUUID(),
    op: input.op,
    port,
    createdAt: nowIso(),
  };
  const queue = queues.get(hostId) || [];
  queue.push(task);
  queues.set(hostId, queue.slice(-10));

  const timer = setTimeout(() => markTimeout(hostId, task.taskId), timeoutMs);
  const state: Iperf3State = {
    hostId,
    taskId: task.taskId,
    state: input.op === "start" ? "queued" : "stopping",
    port,
    output: input.op === "start" ? "任务已创建，等待 Agent 启动 iperf3 服务端..." : "任务已创建，等待 Agent 停止 iperf3 服务端...",
    updatedAt: task.createdAt,
    timer,
  };
  const previous = states.get(hostId);
  if (previous?.timer) clearTimeout(previous.timer);
  states.set(hostId, state);

  return { task, status: toStatus(state) };
}

export function takeIperf3AgentTasks(hostId: number, limit = 2) {
  const queue = queues.get(hostId) || [];
  const tasks = queue.splice(0, limit);
  if (queue.length > 0) queues.set(hostId, queue);
  else queues.delete(hostId);

  for (const task of tasks) {
    const state = states.get(hostId);
    if (!state || state.taskId !== task.taskId) continue;
    state.state = task.op === "start" ? "starting" : "stopping";
    state.output = task.op === "start" ? "Agent 已拉取任务，正在启动 iperf3 服务端..." : "Agent 已拉取任务，正在停止 iperf3 服务端...";
    state.updatedAt = nowIso();
  }
  return tasks;
}

export function completeIperf3AgentTask(hostId: number, result: Iperf3AgentResult) {
  const previous = states.get(hostId);
  if (previous?.timer) clearTimeout(previous.timer);
  const updatedAt = String(result.updatedAt || nowIso());
  const state: Iperf3State = {
    hostId,
    taskId: String(result.taskId || previous?.taskId || ""),
    state: result.status,
    port: Number(result.port || previous?.port || AUTO_IPERF3_PORT),
    output: String(result.output || ""),
    pid: result.pid === undefined ? previous?.pid : result.pid,
    startedAt: result.startedAt || previous?.startedAt,
    updatedAt,
    error: result.error ? String(result.error) : undefined,
  };
  states.set(hostId, state);
  return true;
}

export function getIperf3Status(hostId: number) {
  return toStatus(states.get(hostId));
}

export function hasActiveIperf3Task(hostId: number) {
  const state = states.get(hostId);
  return !!state && (state.state === "queued" || state.state === "starting" || state.state === "running" || state.state === "stopping");
}

export const AUTO_IPERF3_SERVER_PORT = AUTO_IPERF3_PORT;
