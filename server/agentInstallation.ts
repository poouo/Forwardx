import { executeRaw, getDatabaseKind, insertAndGetId, queryRaw, withDatabaseTransaction } from "./dbRuntime";
import { quoteIdentifier as q } from "./dbCompat";
import { invalidateAgentAuthTokenCandidates } from "./repositories/tokenRepository";

export function normalizeAgentInstallationId(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : "";
}

export const agentSupersededResponse = {
  success: true,
  agentSuperseded: true,
  message: "此 Token 已由新的 Agent 安装实例接管；保留本机转发，停止面板同步。",
  actions: [],
  heartbeatInterval: 300,
  nextInterval: 300,
  presence: true,
  presenceSupported: true,
  nextPresenceInterval: 300,
};

// Parallel normal reports, exclusive registration. Drain older requests before
// switching ownership, otherwise an in-flight old status could undo the reset.
export class AgentInstallationGate {
  private states = new Map<string, { active: number; exclusive: boolean; queue: Array<{ exclusive: boolean; resolve: (release: () => void) => void }> }>();

  acquire(key: string, exclusive = false): Promise<() => void> {
    let state = this.states.get(key);
    if (!state) {
      state = { active: 0, exclusive: false, queue: [] };
      this.states.set(key, state);
    }
    const current = state;
    const drain = () => {
      if (current.exclusive) return;
      while (current.queue.length) {
        if (current.queue[0].exclusive && current.active > 0) return;
        const next = current.queue.shift()!;
        current.active += 1;
        current.exclusive = next.exclusive;
        let released = false;
        next.resolve(() => {
          if (released) return;
          released = true;
          current.active -= 1;
          if (next.exclusive) current.exclusive = false;
          drain();
          if (!current.active && !current.queue.length && this.states.get(key) === current) this.states.delete(key);
        });
        if (next.exclusive) return;
      }
    };
    return new Promise((resolve) => { current.queue.push({ exclusive, resolve }); drain(); });
  }
}

export const agentInstallationGate = new AgentInstallationGate();

export async function claimAgentInstallation(hostId: number, installationId: string) {
  const result = await withDatabaseTransaction(async () => {
    const suffix = getDatabaseKind() === "sqlite" ? "" : " FOR UPDATE";
    const host = (await queryRaw(`SELECT ${q("agentInstallationId")} FROM ${q("hosts")} WHERE ${q("id")} = ?${suffix}`, [hostId]))[0];
    if (!host) throw new Error("Agent host not found");
    const previous = String(host.agentInstallationId || "");
    if (!installationId) return { accepted: !previous, changed: false, replaced: false };
    if (installationId === previous) return { accepted: true, changed: false, replaced: false };
    const seen = await queryRaw(`SELECT ${q("id")} FROM ${q("agent_installations")} WHERE ${q("hostId")} = ? AND ${q("installationId")} = ?`, [hostId, installationId]);
    if (seen.length) return { accepted: false, changed: false, replaced: false };
    if (previous) {
      const previousRecord = await queryRaw(`SELECT ${q("id")} FROM ${q("agent_installations")} WHERE ${q("hostId")} = ? AND ${q("installationId")} = ?`, [hostId, previous]);
      if (!previousRecord.length) await insertAndGetId("agent_installations", { hostId, installationId: previous, createdAt: new Date() });
    }
    await insertAndGetId("agent_installations", { hostId, installationId, createdAt: new Date() });
    await executeRaw(`UPDATE ${q("hosts")} SET ${q("agentInstallationId")} = ? WHERE ${q("id")} = ?`, [installationId, hostId]);
    return { accepted: true, changed: true, replaced: !!previous };
  });
  if (result.changed) invalidateAgentAuthTokenCandidates();
  return result;
}
