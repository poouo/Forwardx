import { type ForwardType } from "../shared/forwardTypes";
import { getAgentToolAvailability } from "./agentToolInventory";
import { hostPolicyBool } from "../shared/hostTrafficPolicy";

export function portForwardToolPreflight(hosts: any[], forwardType: ForwardType) {
  return hosts.map((host) => ({
    hostId:Number(host.id),hostName:String(host.name || ""),forwardType,
    ...(hostPolicyBool(host.isOnline) ? getAgentToolAvailability(Number(host.id), forwardType) : {status:"unknown" as const,checkedAt:null}),
  }));
}

export function missingPortForwardToolMessage(rows: ReturnType<typeof portForwardToolPreflight>, type: ForwardType) {
  const missing = rows.filter((row) => row.status === "missing");
  return missing.length ? `所选入口缺少转发工具 ${type}：${missing.map((row) => row.hostName || `#${row.hostId}`).join("、")}` : null;
}
