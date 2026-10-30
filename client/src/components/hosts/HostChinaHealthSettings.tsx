import { t } from "@/i18n";
import type { ReactNode } from "react";
import { Activity, BellRing, ShieldCheck } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { defaultHostChinaHealth, hostChinaHealthSchema, type HostChinaHealthConfig, type IpSwitchHook } from "@shared/hostChinaHealth";

export type ChinaHealthDraft = Omit<HostChinaHealthConfig, "hook"> & {
  hookConfigured: boolean; hookLoaded: boolean; hookUrl: string; hookMethod: "GET" | "POST" | "PUT";
  hookHeaders: string; hookBody: string; successPath: string; successValue: string; ipPath: string;
  successMode: "http" | "json";
  updateAddress: "none" | "entry" | "entry_and_tunnel";
  hookTimeoutSeconds: number;
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
  return { ...settings, hookConfigured: !!health?.hookConfigured, hookLoaded: false, hookUrl: "", hookMethod: "GET", hookHeaders: "{}", hookBody: "", successMode: "http", successPath: "success", successValue: "true", ipPath: "", updateAddress: "none", hookTimeoutSeconds: 15 };
}
export function applyChinaHealthHook(draft: ChinaHealthDraft, hook: IpSwitchHook | null): ChinaHealthDraft {
  if (!hook) return { ...draft, hookConfigured: false, hookLoaded: true };
  return { ...draft, hookConfigured: true, hookLoaded: true, hookUrl: hook.url, hookMethod: hook.method,
    hookHeaders: JSON.stringify(hook.headers, null, 2), hookBody: hook.body, successMode: hook.successMode,
    successPath: hook.successPath ?? "", successValue: hook.successValue === undefined ? "" : JSON.stringify(hook.successValue),
    ipPath: hook.ipPath ?? "", updateAddress: hook.updateAddress, hookTimeoutSeconds: hook.timeoutSeconds };
}
export function chinaHealthPayload(draft: ChinaHealthDraft) {
  const { hookConfigured, hookLoaded, hookUrl, hookMethod, hookHeaders, hookBody, successMode, successPath, successValue, ipPath, updateAddress, hookTimeoutSeconds, ...config } = draft;
  let hook: HostChinaHealthConfig["hook"];
  if ((hookLoaded || !hookConfigured) && (hookUrl || config.enabled && config.autoSwitch)) {
    let headers: unknown;
    try { headers = JSON.parse(hookHeaders || "{}"); } catch { throw new Error(t("接口请求头必须是 JSON 对象")); }
    let expected: unknown;
    try { expected = JSON.parse(successValue); } catch { expected = successValue; }
    hook = { url: hookUrl.trim(), method: hookMethod, headers: headers as Record<string, string>, body: hookMethod === "GET" ? "" : hookBody,
      successMode, ...(successMode === "json" ? { successPath, successValue: expected as string | boolean | number } : {}), ...(ipPath.trim() ? { ipPath: ipPath.trim() } : {}), updateAddress, timeoutSeconds: hookTimeoutSeconds };
  }
  return hostChinaHealthSchema.parse({ ...config, ...(hook ? { hook } : {}) });
}
export function ChinaHealthStatus({ health }: { health: any }) {
  if (!health?.enabled) return null;
  const labels: Record<string, string> = { unknown: "等待健康上报", healthy: "国内连通正常", suspect: "疑似异常，持续观察", unhealthy: "国内连通异常", recovering: "连通恢复中" };
  const phase = health.state?.phase || "unknown";
  return <div className="space-y-1"><span className={`block text-xs ${health.state?.stale || ["suspect", "unhealthy"].includes(phase) ? "text-amber-600 dark:text-amber-400" : phase === "healthy" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>{t("国内健康检测")} · {health.state?.stale ? t("采样已过期") : t(labels[phase] || labels.unknown)}</span>{health.autoSwitch && !health.agentReady && <span className="block text-xs text-amber-600 dark:text-amber-400">{t("自动换 IP 暂不可用，请检查 Agent 在线状态并升级 Agent")}</span>}</div>;
}
export default function HostChinaHealthSettings({ value, onChange, hookLoading = false, hookError = false, onRetryHook, onReplaceHook }: { value: ChinaHealthDraft; onChange: (value: ChinaHealthDraft) => void; hookLoading?: boolean; hookError?: boolean; onRetryHook?: () => void; onReplaceHook?: () => void }) {
  const patch = (next: Partial<ChinaHealthDraft>) => onChange({ ...value, ...next });
  if (!value.enabled) return null;
  return <section className="space-y-3 rounded-lg border border-sky-500/25 bg-sky-500/5 p-3">
      <div className="grid min-w-0 grid-cols-2 gap-2.5 [&>*]:min-w-0">{([
        ["failureThreshold", "失败次数", 2, 20], ["failureSeconds", "失败时长（秒）", 30, 3600],
        ["recoveryThreshold", "恢复次数", 2, 20], ["cooldownSeconds", "商家换 IP 间隔（分钟）", 5, 1440],
        ["maxSwitchesPerDay", "24h 换 IP 上限", 1, 10],
      ] as const).map(([key, label, min, max]) => <div className="space-y-1" key={key}><Label className="text-xs" htmlFor={`china-${key}`}>{t(label)}</Label><Input className="h-9 sm:h-8" id={`china-${key}`} type="number" min={min} max={max} value={key === "cooldownSeconds" ? value[key] / 60 : value[key]} onChange={event => patch({ [key]: key === "cooldownSeconds" ? Math.round(Number(event.target.value) * 60) : Number(event.target.value) })} /></div>)}</div>
      <Label className="flex items-center justify-between gap-3">{t("通知管理员")}<Switch checked={value.notify} onCheckedChange={notify => patch({ notify })} /></Label>
      <Label className="flex items-center justify-between gap-3">{t("自动切换 IP")}<Switch checked={value.autoSwitch} onCheckedChange={autoSwitch => patch({ autoSwitch })} /></Label>
      {value.autoSwitch && <p className="text-xs text-muted-foreground">{t("可能收费或重启；已接收或结果不明的请求不自动重试。")}</p>}
      {hookLoading && <p role="status" className="text-xs text-muted-foreground">{t("正在读取换 IP 参数…")}</p>}
      {hookError && <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">{t("无法读取已保存的换 IP 参数")}{onRetryHook && <Button type="button" size="sm" variant="outline" onClick={onRetryHook}>{t("重试")}</Button>}{onReplaceHook && <Button type="button" size="sm" variant="outline" onClick={onReplaceHook}>{t("重新配置接口")}</Button>}</div>}
      <fieldset disabled={hookLoading || hookError || value.hookConfigured && !value.hookLoaded} className="min-w-0 space-y-3 border-t pt-3 disabled:opacity-60">
        <div className="space-y-1.5"><Label htmlFor="china-hook-url">{t("商家换 IP 接口地址")}</Label><Input id="china-hook-url" type="text" autoComplete="off" spellCheck={false} value={value.hookUrl} onChange={event => patch({ hookUrl: event.target.value })} placeholder="http://10.x.x.x/api/changeip?token=xxx" /></div>
        <p className="text-xs text-muted-foreground">{t("由 Agent 请求；内网可用 HTTP，公网请用 HTTPS。")}</p>
        <div className="space-y-1.5"><Label>{t("请求方法")}</Label><Select value={value.hookMethod} onValueChange={method => patch({ hookMethod: method as ChinaHealthDraft["hookMethod"] })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["GET", "POST", "PUT"].map(method => <SelectItem key={method} value={method}>{method}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1.5"><Label htmlFor="china-hook-timeout">{t("请求超时（秒）")}</Label><Input id="china-hook-timeout" type="number" min={5} max={30} value={value.hookTimeoutSeconds} onChange={event => patch({ hookTimeoutSeconds: Number(event.target.value) })} /></div>
        <div className="space-y-1.5"><Label htmlFor="china-hook-headers">{t("请求头（JSON）")}</Label><Textarea id="china-hook-headers" autoComplete="off" value={value.hookHeaders} onChange={event => patch({ hookHeaders: event.target.value })} placeholder={'{"Authorization":"Bearer ...","Content-Type":"application/json"}'} className="font-mono text-xs" /></div>
        {value.hookMethod !== "GET" && <div className="space-y-1.5"><Label htmlFor="china-hook-body">{t("请求体")}</Label><Textarea id="china-hook-body" autoComplete="off" value={value.hookBody} onChange={event => patch({ hookBody: event.target.value })} className="font-mono text-xs" /></div>}
        <div className="space-y-1.5"><Label>{t("接口结果判断")}</Label><Select value={value.successMode} onValueChange={successMode => patch({ successMode: successMode as ChinaHealthDraft["successMode"] })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="http">{t("HTTP 2xx：请求已接收")}</SelectItem><SelectItem value="json">{t("JSON 字段严格匹配")}</SelectItem></SelectContent></Select></div>
        {value.successMode === "json" && <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><Label htmlFor="china-success-path">{t("成功字段 JSON 路径")}</Label><Input id="china-success-path" value={value.successPath} onChange={event => patch({ successPath: event.target.value })} placeholder="data.success" /></div><div className="space-y-1.5"><Label htmlFor="china-success-value">{t("成功字段预期值")}</Label><Input id="china-success-value" value={value.successValue} onChange={event => patch({ successValue: event.target.value })} placeholder="true" /></div></div>}
        {value.successMode === "http" && <p className="text-xs text-muted-foreground">{t("2xx 仅代表已接收，不代表换 IP 成功。")}</p>}
        <div className="space-y-1.5"><Label htmlFor="china-ip-path">{t("新 IP 字段 JSON 路径（可选）")}</Label><Input id="china-ip-path" value={value.ipPath} onChange={event => patch({ ipPath: event.target.value })} placeholder="data.ip" /></div>
        <div className="space-y-1.5"><Label>{t("成功后同步面板地址")}</Label><Select value={value.updateAddress} onValueChange={updateAddress => patch({ updateAddress: updateAddress as ChinaHealthDraft["updateAddress"] })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">{t("不修改面板地址")}</SelectItem><SelectItem value="entry">{t("更新主机入口地址")}</SelectItem><SelectItem value="entry_and_tunnel">{t("更新主机入口与隧道入口地址")}</SelectItem></SelectContent></Select></div>
      </fieldset>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none hover:text-foreground">{t("使用说明")}</summary>
        <div className="mt-2 space-y-2 leading-relaxed">
          <p>{t("从选定主机探测国内固定公网 IP。连续失败后自动执行已启用的后续操作，无需人工回复；探测失败仅表示疑似连通异常，不能确认被墙。")}</p>
          <p>{t("通知发送给已绑定所选 Telegram / Discord 渠道的管理员；关闭后仍记录日志。")}</p>
          {(value.autoSwitch || value.hookConfigured || value.hookUrl) && <>
            <p>{t("由被检测主机的 Agent 请求，支持商家内网 HTTP / HTTPS 管理接口。HTTP 仅建议用于可信内网，公网请使用 HTTPS。需要升级支持此功能的 Agent。")}</p>
            <p className="break-all">{t("可用变量：{{hostId}}、{{serviceId}}、{{ip}}、{{incidentId}}。凭据加密保存，管理员可在编辑窗口查看修改；保存不会调用接口。")}</p>
            <p>{t("HTTP 2xx 只表示请求已接收，不代表 IP 已换好；有响应文档时建议使用 JSON 严格匹配，预期值按 JSON 类型匹配。")}</p>
            <p>{t("同步地址需要接口返回有效的新公网 IP，并刷新关联链路。商家异步接口可先不修改地址，等待 Agent 重新上报；不自动轮询商家任务。")}</p>
            <p>{t("商家换 IP 间隔默认 60 分钟，请按商家限制配置。同一主机共用请求历史，重启或重新添加服务不会清空间隔；明确未执行的任务可在间隔结束后重试。")}</p>
          </>}
        </div>
      </details>
  </section>;
}
