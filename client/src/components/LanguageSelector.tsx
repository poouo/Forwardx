import { Languages } from "lucide-react";
import { getLanguagePreference, initializeLanguage, setLanguagePreference, t, type LanguagePreference } from "@/i18n";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "@/lib/localizedToast";

export default function LanguageSelector({ compact = false, setup = false, onLanguageChange }: { compact?: boolean; setup?: boolean; onLanguageChange?: () => void }) {
  const confirm = useConfirmDialog();
  const change = async (value: string) => {
    const next = value as LanguagePreference;
    if (next === getLanguagePreference()) return;
    if (!setup && !await confirm({ title: t("语言"), description: t("切换语言将刷新页面，未保存的修改会丢失。是否继续？") })) return;
    if (!setLanguagePreference(next)) {
      toast.error(t("浏览器禁止保存语言偏好，请允许本地存储后重试。"));
      return;
    }
    if (setup) {
      await initializeLanguage();
      onLanguageChange?.();
    } else {
      window.location.reload();
    }
  };
  return (
    <label className={`flex items-center gap-2 ${compact ? "px-2.5 py-2 text-sm" : "text-sm"}`}>
      <Languages className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className={compact ? "sr-only" : ""}>{t("语言")}</span>
      <select aria-label={t("语言")} className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-foreground" value={getLanguagePreference()} onChange={event => void change(event.target.value)}>
        <option value="auto">{t(setup ? "自动（安装参数 / 浏览器 / IP）" : "自动（浏览器 / IP）")}</option>
        <option value="zh-CN">简体中文</option>
        <option value="en">English</option>
      </select>
    </label>
  );
}
