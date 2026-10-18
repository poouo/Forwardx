import { Languages } from "lucide-react";
import { getLanguage, getLanguagePreference, initializeLanguage, setLanguagePreference, t, type Language } from "@/i18n";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "@/lib/localizedToast";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function LanguageSelector({ compact = false, setup = false, onLanguageChange }: { compact?: boolean; setup?: boolean; onLanguageChange?: () => void }) {
  const confirm = useConfirmDialog();
  const change = async (value: string) => {
    if (value !== "zh-CN" && value !== "en") return;
    const next: Language = value;
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
    <div data-language-selector className={`flex items-center gap-2 ${compact ? "px-2.5 py-2 text-sm" : "text-sm"}`}>
      <Languages className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className={compact ? "sr-only" : ""}>{t("语言")}</span>
      <Select value={getLanguage()} onValueChange={value => void change(value)}>
        <SelectTrigger aria-label={t("语言")} className="h-9 w-auto min-w-[6.5rem] rounded-full px-3">
          <SelectValue>{getLanguage() === "en" ? "English" : "简体中文"}</SelectValue>
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value="zh-CN">简体中文</SelectItem>
          <SelectItem value="en">English</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
