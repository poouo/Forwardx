import { withKeyedTaskLock } from "./keyedTaskLock";

type PendingQuota = {
  rules: number;
  ports: number;
};

export type RuleQuotaReservation = {
  release: () => Promise<void>;
};

const pendingByUser = new Map<number, PendingQuota>();

export async function reserveRuleCreateQuota(input: {
  userId: number;
  maxRules: number;
  maxPorts: number;
  getRuleCount: () => Promise<number>;
  getPortCount: () => Promise<number>;
}): Promise<RuleQuotaReservation> {
  const userId = Number(input.userId);
  const maxRules = Math.max(0, Number(input.maxRules) || 0);
  const maxPorts = Math.max(0, Number(input.maxPorts) || 0);
  if (maxRules === 0 && maxPorts === 0) return { release: async () => undefined };

  return withKeyedTaskLock(`rule-create-quota:${userId}`, async () => {
    const pending = pendingByUser.get(userId) || { rules: 0, ports: 0 };
    const [ruleCount, portCount] = await Promise.all([
      maxRules > 0 ? input.getRuleCount() : Promise.resolve(0),
      maxPorts > 0 ? input.getPortCount() : Promise.resolve(0),
    ]);
    if (maxRules > 0 && Number(ruleCount) + pending.rules >= maxRules) {
      throw new Error(`您已达到最大规则数量限制（${maxRules} 条）`);
    }
    if (maxPorts > 0 && Number(portCount) + pending.ports >= maxPorts) {
      throw new Error(`您已达到最大端口数量限制（${maxPorts} 个）`);
    }

    pendingByUser.set(userId, {
      rules: pending.rules + (maxRules > 0 ? 1 : 0),
      ports: pending.ports + (maxPorts > 0 ? 1 : 0),
    });
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await withKeyedTaskLock(`rule-create-quota:${userId}`, async () => {
          const current = pendingByUser.get(userId);
          if (!current) return;
          const next = {
            rules: Math.max(0, current.rules - (maxRules > 0 ? 1 : 0)),
            ports: Math.max(0, current.ports - (maxPorts > 0 ? 1 : 0)),
          };
          if (next.rules === 0 && next.ports === 0) pendingByUser.delete(userId);
          else pendingByUser.set(userId, next);
        });
      },
    };
  });
}

export function clearRuleQuotaReservationsForTest() {
  pendingByUser.clear();
}
