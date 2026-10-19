import { t } from "@/i18n";
import { Switch } from "./ui/switch";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import type { AuthCaptchaProvider } from "@shared/authCaptcha";

export default function AuthCaptchaSettingsFields({ enabled, provider, onEnabledChange, onProviderChange }: {
  enabled: boolean;
  provider: AuthCaptchaProvider;
  onEnabledChange: (enabled: boolean) => void;
  onProviderChange: (provider: AuthCaptchaProvider) => void;
}) {
  return (
    <div className="grid min-w-0 gap-4 md:grid-cols-2">
      <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border/40 bg-muted/20 p-3">
        <div className="min-w-0">
          <Label htmlFor="auth-captcha-enabled">{t("启用人机验证")}</Label>
          <p className="mt-1 text-xs text-muted-foreground">{t("关闭后仅停用人机验证，其他安全校验不变。")}</p>
        </div>
        <Switch id="auth-captcha-enabled" aria-label={t("启用人机验证")} className="shrink-0" checked={enabled} onCheckedChange={onEnabledChange} />
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-border/40 bg-muted/20 p-3">
        <div className="min-w-0">
          <Label htmlFor="auth-captcha-provider">{t("验证方式")}</Label>
          <p className="mt-1 text-xs text-muted-foreground">{provider === "image" ? t("输入图片字符，不区分大小写。") : t("点击完成验证，建议使用 HTTPS。")}</p>
        </div>
        <Select value={provider} onValueChange={value => onProviderChange(value as AuthCaptchaProvider)}>
          <SelectTrigger id="auth-captcha-provider" className="w-40 max-w-full shrink-0" aria-label={t("验证方式")}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="cap">{t("点击验证（Cap）")}</SelectItem>
            <SelectItem value="image">{t("图片验证码")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
