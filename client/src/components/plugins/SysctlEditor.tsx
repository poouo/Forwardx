import { useId, useMemo, useState } from "react";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { BBR_FQ_PRESET, parseSysctlConfig, SYSCTL_GUI_FIELDS, updateSysctlConfig } from "@shared/sysctlConfig";

export default function SysctlEditor({ value, onChange, disabled = false }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const [mode, setMode] = useState<"visual" | "text">("visual");
  const editorId = useId();
  const parsed = useMemo(() => {
    try { return { entries: parseSysctlConfig(value), error: "" }; }
    catch (error) { return { entries: new Map<string, string>(), error: (error as Error).message }; }
  }, [value]);
  const textMode = mode === "text" || !!parsed.error;
  const field = (definition: typeof SYSCTL_GUI_FIELDS[number]) => {
    const current = parsed.entries.get(definition.key) || "";
    const id = `${editorId}-sysctl-${definition.key}`;
    return <div key={definition.key} className="min-w-0 space-y-1.5">
      <Label htmlFor={id} className="text-xs" title={definition.key}>{t(definition.label)}</Label>
      {"options" in definition ? <select id={id} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" value={current} disabled={disabled} onChange={event => onChange(updateSysctlConfig(value, definition.key, event.target.value))}>
        <option value="">{t("不修改")}</option>
        {current && !(definition.options as readonly string[]).includes(current) && <option value={current}>{current}</option>}
        {definition.options.map(option => <option key={option} value={option}>{option}</option>)}
      </select> : <Input id={id} value={current} disabled={disabled} placeholder={t(definition.placeholder)} className="h-9 font-mono text-xs" onChange={event => onChange(updateSysctlConfig(value, definition.key, event.target.value))} />}
    </div>;
  };
  return <div className="min-w-0 space-y-3" data-sysctl-editor="">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="inline-flex rounded-md border p-0.5" role="group" aria-label={t("配置模式")}>
        <Button type="button" size="sm" variant={!textMode ? "secondary" : "ghost"} aria-pressed={!textMode} disabled={disabled || !!parsed.error} onClick={() => setMode("visual")}>{t("图形化")}</Button>
        <Button type="button" size="sm" variant={textMode ? "secondary" : "ghost"} aria-pressed={textMode} disabled={disabled} onClick={() => setMode("text")}>{t("高级文本")}</Button>
      </div>
      <Button type="button" size="sm" variant="outline" disabled={disabled} title={t("替换编辑内容，保存后才下发")} onClick={() => onChange(BBR_FQ_PRESET)}>BBR + FQ</Button>
    </div>
    {textMode ? <Textarea aria-label={t("sysctl 配置")} value={value} disabled={disabled} spellCheck={false} className="min-h-64 whitespace-pre font-mono text-xs leading-6" onChange={event => onChange(event.target.value)} /> : <>
      <div className="grid grid-cols-2 gap-3">{SYSCTL_GUI_FIELDS.slice(0, 2).map(field)}</div>
      <details className="rounded-md border border-border/50 p-3"><summary className="cursor-pointer text-xs font-medium">{t("更多 TCP 参数")}</summary><div className="mt-3 grid grid-cols-1 gap-3 min-[400px]:grid-cols-2">{SYSCTL_GUI_FIELDS.slice(2).map(field)}</div></details>
      <p className="text-xs text-muted-foreground">{t("自定义参数和注释在切换模式时保留；支持的算法以 Agent 内核为准。")}</p>
    </>}
    {parsed.error && <p role="alert" className="text-xs text-destructive">{t(parsed.error)}</p>}
  </div>;
}
