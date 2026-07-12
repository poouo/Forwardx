import { boolLiteral, quoteIdentifier } from "./dbCompat";
import { executeRaw, queryRaw } from "./dbRuntime";
import { mapWithConcurrency } from "./asyncPool";

export type PortForwardTemplateHostRow = {
  ruleId: number;
  storedHostId: number;
  groupId: number;
  memberId: number;
  memberHostId: number;
  memberPriority: number;
};

export function portForwardTemplateHostRepairs(rows: PortForwardTemplateHostRow[]) {
  const ordered = [...rows].sort((left, right) => (
    Number(left.ruleId) - Number(right.ruleId)
    || Number(left.memberPriority) - Number(right.memberPriority)
    || Number(left.memberId) - Number(right.memberId)
  ));
  const repairs: Array<{ ruleId: number; groupId: number; fromHostId: number; toHostId: number }> = [];
  const seenRuleIds = new Set<number>();
  for (const row of ordered) {
    const ruleId = Number(row.ruleId || 0);
    const fromHostId = Number(row.storedHostId || 0);
    const toHostId = Number(row.memberHostId || 0);
    if (!ruleId || !toHostId || seenRuleIds.has(ruleId)) continue;
    seenRuleIds.add(ruleId);
    if (fromHostId !== toHostId) {
      repairs.push({ ruleId, groupId: Number(row.groupId || 0), fromHostId, toHostId });
    }
  }
  return repairs;
}

export async function repairPortForwardRuleHostReferences(groupIdValue?: unknown) {
  const groupId = Number(groupIdValue || 0);
  const q = quoteIdentifier;
  const groupFilter = Number.isInteger(groupId) && groupId > 0 ? ` AND g.${q("id")} = ?` : "";
  const rows = await queryRaw<PortForwardTemplateHostRow>(
    `SELECT
        r.${q("id")} AS ${q("ruleId")},
        r.${q("hostId")} AS ${q("storedHostId")},
        g.${q("id")} AS ${q("groupId")},
        m.${q("id")} AS ${q("memberId")},
        m.${q("hostId")} AS ${q("memberHostId")},
        m.${q("priority")} AS ${q("memberPriority")}
       FROM ${q("forward_rules")} r
       INNER JOIN ${q("forward_groups")} g ON g.${q("id")} = r.${q("forwardGroupId")}
       INNER JOIN ${q("forward_group_members")} m ON m.${q("groupId")} = g.${q("id")}
      WHERE g.${q("groupMode")} = 'port'
        AND m.${q("memberType")} = 'host'
        AND m.${q("hostId")} IS NOT NULL
        AND r.${q("isForwardGroupTemplate")} = ${boolLiteral(true)}
        AND r.${q("pendingDelete")} = ${boolLiteral(false)}${groupFilter}
      ORDER BY r.${q("id")} ASC, m.${q("priority")} ASC, m.${q("id")} ASC`,
    groupFilter ? [groupId] : [],
  );
  const repairs = portForwardTemplateHostRepairs(rows);
  const updatedAt = Math.floor(Date.now() / 1000);
  await mapWithConcurrency(repairs, 12, (repair) => executeRaw(
    `UPDATE ${q("forward_rules")}
        SET ${q("hostId")} = ?, ${q("isRunning")} = ${boolLiteral(false)}, ${q("updatedAt")} = ?
      WHERE ${q("id")} = ?`,
    [repair.toHostId, updatedAt, repair.ruleId],
  ));
  return repairs;
}
