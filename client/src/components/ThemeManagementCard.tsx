import { useRef, useState } from "react";
import { CheckCircle2, Download, Loader2, Palette, RotateCcw, Trash2, Upload } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";
import { toast } from "@/lib/localizedToast";
import { downloadBlobFile } from "@/lib/fileDownload";
import ThemeFieldReference from "./themes/ThemeFieldReference";
import { getPersonalizationThemePreset } from "@shared/personalization";
import { THEME_LIMITS } from "@shared/themes";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { useConfirmDialog } from "./ui/confirm-dialog";

export default function ThemeManagementCard() {
  const utils = trpc.useUtils();
  const confirm = useConfirmDialog();
  const list = trpc.themes.list.useQuery();
  const input = useRef<HTMLInputElement>(null);
  const [replace, setReplace] = useState(false);
  const [reading, setReading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const refresh = () => Promise.all([utils.themes.list.invalidate(), utils.system.publicInfo.invalidate(), utils.system.getSettings.invalidate()]);
  const activate = trpc.themes.activate.useMutation({
    onSuccess: async () => { await refresh(); toast.success(t("全站主题已切换")); },
    onError: error => toast.error(error.message),
  });
  const install = trpc.themes.install.useMutation({
    onSuccess: async () => { await utils.themes.list.invalidate(); toast.success(t("主题已安装，可点击应用主题启用")); },
    onError: error => toast.error(error.message),
  });
  const importLink = trpc.themes.importUrl.useMutation({
    onSuccess: async () => { setImportUrl(""); await utils.themes.list.invalidate(); toast.success(t("主题已安装，可点击应用主题启用")); },
    onError: error => toast.error(error.message),
  });
  const remove = trpc.themes.remove.useMutation({
    onSuccess: async () => { await utils.themes.list.invalidate(); toast.success(t("主题已删除")); },
    onError: error => toast.error(error.message),
  });
  const busy = reading || install.isPending || importLink.isPending || activate.isPending || remove.isPending;

  async function upload(file: File | undefined) {
    if (!file) return;
    if (file.size > THEME_LIMITS.archiveBytes) { toast.error(t("请选择不超过 {0}MB 的主题压缩包", [THEME_LIMITS.archiveBytes / 1024 ** 2])); return; }
    setReading(true);
    try {
      const encoded = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
        reader.onerror = () => reject(new Error(t("主题文件读取失败")));
        reader.readAsDataURL(file);
      });
      await install.mutateAsync({ archiveBase64: encoded, replace });
    } catch (error) {
      // The mutation reports API errors; file reader errors need their own feedback.
      if (!(error && typeof error === "object" && "data" in error)) toast.error(error instanceof Error ? error.message : t("主题文件读取失败"));
    } finally { setReading(false); }
  }

  async function downloadTemplate() {
    setDownloading(true);
    try {
      const result = await utils.themes.template.fetch({ base: list.data?.active.base || "teal" });
      const bytes = Uint8Array.from(atob(result.archiveBase64), character => character.charCodeAt(0));
      downloadBlobFile(result.filename, new Blob([bytes], { type: "application/zip" }));
    } catch (error) { toast.error(error instanceof Error ? error.message : t("下载失败")); }
    finally { setDownloading(false); }
  }

  return <Card id="theme-management" className="border-border/40 bg-card/60 backdrop-blur-md">
    <CardHeader>
      <CardTitle className="flex items-center gap-2 text-base"><Palette className="h-4 w-4 text-primary" />{t("主题管理")}</CardTitle>
      <CardDescription>{t("管理员设置全站主题，所有用户跟随。自定义主题可调整布局、组件、字体和明暗配色。")}</CardDescription>
    </CardHeader>
    <CardContent className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" disabled={busy || !list.data} onClick={() => input.current?.click()} className="gap-2">{reading || install.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}{t("上传主题压缩包")}</Button>
        <Button type="button" variant="outline" disabled={downloading} onClick={downloadTemplate} className="gap-2">{downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}{t("下载开发模板")}</Button>
        <Button type="button" variant="outline" disabled={busy || !list.data || list.data.active.id === "ink"} onClick={() => activate.mutate({ id: "ink" })} className="gap-2"><RotateCcw className="h-4 w-4" />{t("恢复默认主题")}</Button>
        <ThemeFieldReference />
        <input ref={input} type="file" accept=".zip,.rar,.tar,.tar.gz,.tgz,application/zip,application/vnd.rar,application/gzip,application/x-tar" className="hidden" aria-label={t("上传主题压缩包")} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void upload(file); }} />
      </div>
      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={event => { event.preventDefault(); if (!busy && importUrl.trim()) importLink.mutate({ url: importUrl.trim(), replace }); }}>
        <Input type="url" value={importUrl} onChange={event => setImportUrl(event.target.value)} placeholder={t("主题压缩包直链（HTTP/HTTPS）")} aria-label={t("主题压缩包直链（HTTP/HTTPS）")} disabled={busy} maxLength={2048} required />
        <Button type="submit" variant="outline" className="shrink-0 gap-2" disabled={busy || !list.data || !importUrl.trim()}>{importLink.isPending && <Loader2 className="h-4 w-4 animate-spin" />}{t("从链接导入")}</Button>
      </form>
      <label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={replace} disabled={busy} onChange={event => setReplace(event.target.checked)} />{t("替换相同 ID 的已安装主题（需先停用）")}</label>
      <p className="text-xs leading-5 text-muted-foreground">{t("支持 ZIP、RAR、TAR、TAR.GZ、TGZ，最大 {0}MB，单个图片或字体不超过 {1}MB；根目录需包含 theme.json 和样式表，安装后不会自动启用。", [THEME_LIMITS.archiveBytes / 1024 ** 2, THEME_LIMITS.fileBytes / 1024 ** 2])}</p>
      {list.isLoading && <p role="status" className="text-sm text-muted-foreground">{t("正在加载主题")}</p>}
      {list.error && <div role="alert" className="flex items-center gap-3 text-sm text-destructive"><span>{list.error.message}</span><Button variant="outline" size="sm" onClick={() => list.refetch()}>{t("重试")}</Button></div>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {list.data?.themes.map(theme => {
          const active = theme.id === list.data.active.id;
          const preset = getPersonalizationThemePreset(theme.base);
          return <div key={theme.id} className={`flex min-w-0 flex-col gap-3 rounded-xl border p-4 ${active ? "border-primary bg-primary/5 ring-1 ring-primary/15" : "border-border/50 bg-background/40"}`}>
            <div className="flex items-center justify-between gap-2"><div className="flex min-w-0 items-center gap-2"><span className="truncate font-medium" title={theme.name}>{theme.builtin ? t(theme.name) : theme.name}</span>{active && <CheckCircle2 aria-label={t("当前主题")} className="h-4 w-4 shrink-0 text-primary" />}</div><Badge variant="secondary">{t(theme.builtin ? "内置" : "自定义")}</Badge></div>
            <p className="min-h-10 break-words text-xs leading-5 text-muted-foreground">{theme.builtin ? t(theme.description) : theme.description}</p>
            <div className="flex items-center gap-2">{preset.swatches.map(color => <span key={color} className="h-6 w-6 rounded-full border border-border/50" style={{ backgroundColor: color }} />)}<span className="ml-auto truncate text-xs text-muted-foreground" title={theme.author}>{theme.author} · {theme.version}</span></div>
            <div className="mt-auto flex flex-wrap gap-2">
              <Button type="button" size="sm" variant={active ? "secondary" : "default"} disabled={busy || active} onClick={() => activate.mutate({ id: theme.id })}>{activate.isPending && activate.variables?.id === theme.id && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}{t(active ? "使用中" : "应用主题")}</Button>
              {!theme.builtin && <Button type="button" size="sm" variant="ghost" disabled={busy || active} aria-label={`${t("删除主题")} ${theme.name}`} onClick={async () => {
                if (await confirm({ title: t("删除主题"), description: `${t("确认删除此主题？")} ${theme.name}`, tone: "destructive" })) remove.mutate({ id: theme.id });
              }}><Trash2 className="h-3.5 w-3.5" /></Button>}
            </div>
          </div>;
        })}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{t("主题异常时，在面板地址后加 ?themeSafe=1 可进入安全模式，再恢复默认主题。开发接口与规范见教程「主题开发与接口」。")}</p>
    </CardContent>
  </Card>;
}
