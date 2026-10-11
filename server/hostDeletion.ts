import { boolLiteral, quoteIdentifier as q } from "./dbCompat";
import { getDb, queryRaw, withDatabaseTransaction } from "./dbRuntime";
import { appendPanelLog } from "./_core/panelLogger";
import { deleteHost, getHostById, releaseHostPendingRuleCleanup } from "./repositories/hostRepository";
import { repairForwardGroupRuleIntegrity } from "./forwardGroupRuleIntegrity";
import { repairForwardGroupTemplateHostReferencesForHost } from "./repositories/forwardGroupRepository";
import { pushAgentRefresh } from "./agentEvents";

type Reference = { id: number; name: string };
function referenceList(rows: Reference[]) {
  return { count: rows.length, items: rows.slice(0, 50).map((row) => ({ id: Number(row.id), name: String(row.name || `#${row.id}`) })) };
}

/** Read-only preview: template host IDs are metadata; members define actual usage. */
export async function getHostDeletionImpact(hostId: number) {
  if (!(await getDb())) throw new Error("Database unavailable");
  const host = await getHostById(hostId);
  if (!host) throw new Error("主机不存在");
  const [rules, groups, tunnels, pending] = await Promise.all([
    queryRaw<Reference>(`SELECT DISTINCT r.${q("id")} AS ${q("id")}, r.${q("name")} AS ${q("name")}
      FROM ${q("forward_rules")} r
      WHERE r.${q("pendingDelete")} = ${boolLiteral(false)}
        AND r.${q("isForwardGroupTemplate")} = ${boolLiteral(false)}
        AND (r.${q("hostId")} = ? OR EXISTS (
          SELECT 1 FROM ${q("forward_rule_tunnel_exits")} e
          WHERE e.${q("ruleId")} = r.${q("id")} AND e.${q("exitHostId")} = ?))
      ORDER BY r.${q("id")}`, [hostId, hostId]),
    queryRaw<Reference>(`SELECT DISTINCT g.${q("id")} AS ${q("id")}, g.${q("name")} AS ${q("name")}
      FROM ${q("forward_groups")} g
      INNER JOIN ${q("forward_group_members")} m ON m.${q("groupId")} = g.${q("id")}
      WHERE m.${q("memberType")} = 'host' AND m.${q("hostId")} = ? ORDER BY g.${q("id")}`, [hostId]),
    queryRaw<Reference>(`SELECT DISTINCT t.${q("id")} AS ${q("id")}, t.${q("name")} AS ${q("name")}
      FROM ${q("tunnels")} t WHERE t.${q("entryHostId")} = ? OR t.${q("exitHostId")} = ?
        OR EXISTS (SELECT 1 FROM ${q("tunnel_hops")} h WHERE h.${q("tunnelId")} = t.${q("id")} AND h.${q("hostId")} = ?)
        OR EXISTS (SELECT 1 FROM ${q("tunnel_exit_nodes")} e WHERE e.${q("tunnelId")} = t.${q("id")} AND e.${q("hostId")} = ?)
      ORDER BY t.${q("id")}`, [hostId, hostId, hostId, hostId]),
    queryRaw<{ count: number }>(`SELECT COUNT(*) AS ${q("count")} FROM ${q("forward_rules")}
      WHERE ${q("hostId")} = ? AND ${q("pendingDelete")} = ${boolLiteral(true)} AND ${q("isRunning")} = ${boolLiteral(true)}`, [hostId]),
  ]);
  const ruleRefs = referenceList(rules);
  const groupRefs = referenceList(groups);
  const tunnelRefs = referenceList(tunnels);
  return {
    hostId, hostName: host.name, online: !!host.isOnline,
    rules: ruleRefs, groups: groupRefs, tunnels: tunnelRefs,
    blocked: ruleRefs.count + groupRefs.count + tunnelRefs.count > 0,
    pendingCleanupCount: Number(pending[0]?.count || 0),
  };
}

export async function prepareHostDeletion(hostId: number) {
  // Do not re-save user's rules or rebuild healthy runtimes to fix stale metadata.
  await repairForwardGroupRuleIntegrity(hostId);
  await repairForwardGroupTemplateHostReferencesForHost(hostId);
  const impact = await getHostDeletionImpact(hostId);
  if (impact.online && impact.pendingCleanupCount > 0) {
    pushAgentRefresh(hostId, "host-delete-pending-cleanup", { urgent: true });
  }
  return impact;
}

export async function deleteHostWithImpact(hostId: number, confirmOfflineCleanup = false) {
  await prepareHostDeletion(hostId);
  return withDatabaseTransaction(async () => {
    const impact = await getHostDeletionImpact(hostId);
    if (impact.blocked) {
      const names = [...impact.rules.items, ...impact.groups.items, ...impact.tunnels.items]
        .slice(0, 5).map((item) => `${item.name} (#${item.id})`).join("、");
      throw new Error(`主机仍有关联配置，请先移除引用：${names}`);
    }
    if (impact.pendingCleanupCount > 0) {
      if (impact.online) throw new Error("主机正在清理已移除的规则，请稍后重试，不需要重新保存规则");
      if (!confirmOfflineCleanup) throw new Error("主机离线，无法确认规则已停止，请确认离线移除风险后重试");
      await releaseHostPendingRuleCleanup(hostId);
    }
    await deleteHost(hostId);
    appendPanelLog("info", `[Host] deleted host=${hostId} offlineCleanup=${impact.pendingCleanupCount > 0} pending=${impact.pendingCleanupCount}`);
    return { success: true };
  });
}
