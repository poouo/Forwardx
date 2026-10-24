import { t } from "@/i18n";
import type { ReactNode } from "react";
import { Activity, BellRing, ShieldCheck } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import UserSelect from "@/components/UserSelect";
import { defaultHostChinaHealth, hostChinaHealthSchema, type HostChinaHealthConfig } from "@shared/hostChinaHealth";

export type ChinaHealthDraft = Omit<HostChinaHealthConfig, "hook"> & {
  hookConfigured: boolean; replaceHook: boolean; hookUrl: string; hookMethod: "GET" | "POST" | "PUT";
  hookHeaders: string; hookBody: string; successPath: string; successValue: string; ipPath: string;
  successMode: "http" | "json";
  updateAddress: "none" | "entry" | "entry_and_tunnel";
};
export type HostProbeServiceMode = "standard" | "china" | "resource";

export function applyHostProbeServiceMode<T extends {
  health: ChinaHealthDraft;
  hostScope: "all" | "exclude" | "specific";
  hostIds: number[];
  intervalSeconds: number;
}>(form: T, mode: HostProbeServiceMode): T {
  // Resource alerts are configured independently of probe-service settings.
  // Opening that tab must not silently disable a China health check.
  if (mode === "resource") return form;
  const enabled = mode === "china";
  return {
    ...form,
    health: { ...form.health, enabled },
    ...(enabled ? { hostScope: "specific" as const, hostIds: form.hostIds.slice(0, 1), intervalSeconds: Math.min(300, form.intervalSeconds) } : {}),
  };
}

export function HostProbeServiceModeTabs({ mode, onModeChange, children }: {
  mode: HostProbeServiceMode;
  onModeChange: (mode: HostProbeServiceMode) => void;
  children: ReactNode;
}) {
  return <Tabs value={mode} onValueChange={value => onModeChange(value === "china" || value === "resource" ? value : "standard")} className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3 overflow-hidden">
    <TabsList aria-label={t("服务模式")} className="grid h-auto w-full shrink-0 grid-cols-3 gap-1 rounded-md bg-muted/50 p-1">
      <TabsTrigger value="standard" className="min-w-0 gap-1.5 px-1.5 py-1.5 text-xs sm:gap-2 sm:px-3 sm:text-sm"><Activity className="h-4 w-4 shrink-0" />{t("常规探测")}</TabsTrigger>
      <TabsTrigger value="china" className="min-w-0 gap-1.5 px-1.5 py-1.5 text-xs sm:gap-2 sm:px-3 sm:text-sm"><ShieldCheck className="h-4 w-4 shrink-0" />{t("国内健康检测")}</TabsTrigger>
      <TabsTrigger value="resource" className="min-w-0 gap-1.5 px-1.5 py-1.5 text-xs sm:gap-2 sm:px-3 sm:text-sm"><BellRing className="h-4 w-4 shrink-0" />{t("资源告警")}</TabsTrigger>
    </TabsList>
    <TabsContent value={mode} className="m-0 min-h-0 touch-pan-y space-y-3 overflow-y-auto overscroll-contain pb-1 pr-1 !animate-none">{children}</TabsContent>
  </Tabs>;
}

export function createChinaHealthDraft(health?: any): ChinaHealthDraft {
  const { hook: _hook, ...settings } = hostChinaHealthSchema.parse(health ? Object.fromEntries(Object.keys(defaultHostChinaHealth).map(key => [key, health[key]])) : {});
  return { ...settings, hookConfigured: !!health?.hookConfigured, replaceHook: false, hookUrl: "", hookMethod: "GET", hookHeaders: "{}", hookBody: "", successMode: "http", successPath: "success", successValue: "true", ipPath: "", updateAddress: "none" };
}
export function chinaHealthPayload(draft: ChinaHealthDraft) {
  const { hookConfigured, replaceHook, hookUrl, hookMethod, hookHeaders, hookBody, successMode, successPath, successValue, ipPath, updateAddress, ...config } = draft;
  let hook: HostChinaHealthConfig["hook"];
  if (config.enabled && (replaceHook || !hookConfigured && (config.autoSwitch || hookUrl))) {
    let headers: unknown;
    try { headers = JSON.parse(hookHeaders || "{}"); } catch { throw new Error(t("接口请求头必须是 JSON 对象")); }
    let expected: unknown;
    try { expected = JSON.parse(successValue); } catch { expected = successValue; }
    hook = { url: hookUrl.trim(), method: hookMethod, headers: headers as Record<string, string>, body: hookMethod === "GET" ? "" : hookBody,
      successMode, ...(successMode === "json" ? { successPath, successValue: expected as string | boolean | number } : {}), ...(ipPath.trim() ? { ipPath: ipPath.trim() } : {}), updateAddress, timeoutSeconds: 15 };
  }
  return hostChinaHealthSchema.parse({ ...config, ...(hook ? { hook } : {}) });
}
export function ChinaHealthStatus({ health }: { health: any }) {
  if (!health?.enabled) return null;
  const labels: Record<string, string> = { unknown: "等待健康上报", healthy: "国内连通正常", suspect: "疑似异常，持续观察", unhealthy: "国内连通异常", recovering: "连通恢复中" };
  const phase = health.state?.phase || "unknown";
  return <div className="space-y-1"><span className={`block text-xs ${health.state?.stale || ["suspect", "unhealthy"].includes(phase) ? "text-amber-600 dark:text-amber-400" : phase === "healthy" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>{t("国内健康检测")} · {health.state?.stale ? t("采样已过期") : t(labels[phase] || labels.unknown)}</span>{health.autoSwitch && !health.agentReady && <span className="block text-xs text-amber-600 dark:text-amber-400">{t("自动换 IP 暂不可用，请检查 Agent 在线状态并升级 Agent")}</span>}</div>;
}
export default function HostChinaHealthSettings({ value, onChange }: { value: ChinaHealthDraft; onChange: (value: ChinaHealthDraft) => void }) {
  const patch = (next: Partial<ChinaHealthDraft>) => onChange({ ...value, ...next });
  const showHook = value.replaceHook || !value.hookConfigured && value.autoSwitch;
  if (!value.enabled) return null;
  return <section className="space-y-3 rounded-lg border border-sky-500/25 bg-sky-500/5 p-3">
      <div className="grid min-w-0 grid-cols-2 gap-2.5 [&>*]:min-w-0">{([
        ["failureThreshold", "失败次数", 2, 20], ["failureSeconds", "失败时长（秒）", 30, 3600],
        ["recoveryThreshold", "恢复次数", 2, 20], ["cooldownSeconds", "换 IP 冷却（秒）", 300, 86400],
        ["maxSwitchesPerDay", "24h 换 IP 上限", 1, 10],
      ] as const).map(([key, label, min, max]) => <div className="space-y-1" key={key}><Label className="text-xs" htmlFor={`china-${key}`}>{t(label)}</Label><Input className="h-9 sm:h-8" id={`china-${key}`} type="number" min={min} max={max} value={value[key]} onChange={event => patch({ [key]: Number(event.target.value) })} /></div>)}</div>
      <Label className="flex items-center justify-between gap-3">{t("通知用户")}<Switch checked={value.notify} onCheckedChange={notify => patch({ notify })} /></Label>
      {value.notify && <UserSelect className="h-9 sm:h-8" value={value.notifyUserId ? String(value.notifyUserId) : "owner"} specialOptions={[{ value: "owner", label: t("主机所有者") }]} onValueChange={id => patch({ notifyUserId: id === "owner" ? null : Number(id) })} />}
      <Label className="flex items-center justify-between gap-3">{t("自动切换 IP")}<Switch checked={value.autoSwitch} onCheckedChange={autoSwitch => patch({ autoSwitch })} /></Label>
      {value.autoSwitch && <p className="text-xs text-muted-foreground">{t("可能收费或重启；每次故障仅请求一次，结果不明不重试。")}</p>}
      {value.hookConfigured && <Label className="flex items-center justify-between gap-3 text-xs">{t("替换已存接口")}<Switch checked={value.replaceHook} onCheckedChange={replaceHook => patch({ replaceHook })} /></Label>}
      {showHook && <div className="space-y-3 border-t pt-3">
        <div className="space-y-1.5"><Label htmlFor="china-hook-url">{t("商家换 IP 接口地址")}</Label><Input id="china-hook-url" type="password" autoComplete="new-password" value={value.hookUrl} onChange={event => patch({ hookUrl: event.target.value })} placeholder="http://10.x.x.x/api/changeip?token=xxx" /></div>
        <p className="text-xs text-muted-foreground">{t("由 Agent 请求；内网可用 HTTP，公网请用 HTTPS。")}</p>
        <div className="space-y-1.5"><Label>{t("请求方法")}</Label><Select value={value.hookMethod} onValueChange={method => patch({ hookMethod: method as ChinaHealthDraft["hookMethod"] })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["GET", "POST", "PUT"].map(method => <SelectItem key={method} value={method}>{method}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1.5"><Label htmlFor="china-hook-headers">{t("请求头（JSON）")}</Label><Textarea id="china-hook-headers" autoComplete="off" value={value.hookHeaders} onChange={event => patch({ hookHeaders: event.target.value })} placeholder={'{"Authorization":"Bearer ...","Content-Type":"application/json"}'} className="font-mono text-xs" /></div>
        {value.hookMethod !== "GET" && <div className="space-y-1.5"><Label htmlFor="china-hook-body">{t("请求体")}</Label><Textarea id="china-hook-body" autoComplete="off" value={value.hookBody} onChange={event => patch({ hookBody: event.target.value })} className="font-mono text-xs" /></div>}
        <div className="space-y-1.5"><Label>{t("接口结果判断")}</Label><Select value={value.successMode} onValueChange={successMode => patch({ successMode: successMode as ChinaHealthDraft["successMode"] })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="http">{t("HTTP 2xx：请求已接收")}</SelectItem><SelectItem value="json">{t("JSON 字段严格匹配")}</SelectItem></SelectContent></Select></div>
        {value.successMode === "json" && <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><Label htmlFor="china-success-path">{t("成功字段 JSON 路径")}</Label><Input id="china-success-path" value={value.successPath} onChange={event => patch({ successPath: event.target.value })} placeholder="data.success" /></div><div className="space-y-1.5"><Label htmlFor="china-success-value">{t("成功字段预期值")}</Label><Input id="china-success-value" value={value.successValue} onChange={event => patch({ successValue: event.target.value })} placeholder="true" /></div></div>}
        {value.successMode === "http" && <p className="text-xs text-muted-foreground">{t("2xx 仅代表已接收，不代表换 IP 成功。")}</p>}
        <div className="space-y-1.5"><Label htmlFor="china-ip-path">{t("新 IP 字段 JSON 路径（可选）")}</Label><Input id="china-ip-path" value={value.ipPath} onChange={event => patch({ ipPath: event.target.value })} placeholder="data.ip" /></div>
        <div className="space-y-1.5"><Label>{t("成功后同步面板地址")}</Label><Select value={value.updateAddress} onValueChange={updateAddress => patch({ updateAddress: updateAddress as ChinaHealthDraft["updateAddress"] })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">{t("不修改面板地址")}</SelectItem><SelectItem value="entry">{t("更新主机入口地址")}</SelectItem><SelectItem value="entry_and_tunnel">{t("更新主机入口与隧道入口地址")}</SelectItem></SelectContent></Select></div>
      </div>}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none hover:text-foreground">{t("使用说明")}</summary>
        <div className="mt-2 space-y-2 leading-relaxed">
          <p>{t("从选定主机探测国内固定公网 IP。连续失败后自动执行已启用的后续操作，无需人工回复；探测失败仅表示疑似连通异常，不能确认被墙。")}</p>
          <p>{t("通知发送给所选用户和服务创建者，使用已配置的 Telegram / Discord 渠道；用户需要绑定对应账号。")}</p>
          {(value.autoSwitch || value.replaceHook) && <>
            <p>{t("由被检测主机的 Agent 请求，支持商家内网 HTTP / HTTPS 管理接口。HTTP 仅建议用于可信内网，公网请使用 HTTPS。需要升级支持此功能的 Agent。")}</p>
            <p className="break-all">{t("可用变量：{{hostId}}、{{serviceId}}、{{ip}}、{{incidentId}}。凭据加密保存且不回显，仅通过加密任务交给对应 Agent；保存不会调用接口。")}</p>
            <p>{t("HTTP 2xx 只表示请求已接收，不代表 IP 已换好；有响应文档时建议使用 JSON 严格匹配，预期值按 JSON 类型匹配。")}</p>
            <p>{t("同步地址需要接口返回有效的新公网 IP，并刷新关联链路。商家异步接口可先不修改地址，等待 Agent 重新上报；不自动轮询商家任务。")}</p>
          </>}
        </div>
      </details>
  </section>;
}
