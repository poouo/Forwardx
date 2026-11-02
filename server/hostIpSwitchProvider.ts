import { ipSwitchHookSchema, type IpSwitchHook } from "../shared/hostChinaHealth";
import { enqueueIpSwitchAgentTask, type IpSwitchAgentResult } from "./agentIpSwitchTasks";

export type IpSwitchContext = { hostId: number; serviceId: number; ip: string; incidentId: string };
function template(value: string, context: IpSwitchContext, kind: "url" | "body" | "header") {
  return value.replace(/\{\{(hostId|serviceId|ip|incidentId)\}\}/g, (_, key: keyof IpSwitchContext) => {
    const text = String(context[key]);
    return kind === "url" ? encodeURIComponent(text) : kind === "body" ? JSON.stringify(text).slice(1, -1) : text;
  });
}
/** Only the monitored Agent makes this request, never the panel or a shell. */
export function requestIpSwitch(hook: IpSwitchHook, context: IpSwitchContext): Promise<IpSwitchAgentResult> {
  const request = ipSwitchHookSchema.parse(hook);
  return enqueueIpSwitchAgentTask(context.hostId, {
    taskId: context.incidentId, serviceId: context.serviceId, expectedIp: context.ip,
    request: { ...request, url: template(request.url, context, "url"),
      headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, template(value, context, "header")])),
      body: template(request.body, context, "body") },
  });
}
