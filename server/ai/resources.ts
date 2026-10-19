import * as db from "../db";
import { canUseForwardRuleResource, getLinkAccessScope } from "../linkAccessView";
import { gateForwardRulesForUserSurface } from "../forwardRuleVisibility";

export async function readPanelResources(kind: "rules" | "hosts", actor: { id: number; role: string }) {
  if (kind === "rules") {
    const rows = await db.getForwardRules(actor.role === "admin" ? undefined : actor.id);
    if (actor.role === "admin") return rows;
    const scope = await getLinkAccessScope(actor);
    return gateForwardRulesForUserSurface(rows, row => canUseForwardRuleResource(row, scope));
  }
  if (actor.role === "admin") return db.getHosts();
  const [ids, billing, hosts] = await Promise.all([db.getUserEffectiveAllowedHostIds(actor.id), db.getUserUsableTrafficBillingResourceIds(actor.id), db.getHosts()]);
  const allowed = new Set([...(ids || []), ...(billing?.hostIds || [])].map(Number));
  return hosts.filter((host: any) => host.userId === actor.id || allowed.has(host.id));
}
