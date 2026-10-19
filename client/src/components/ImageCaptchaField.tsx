import { t } from "@/i18n";
import { Loader2, RefreshCw } from "lucide-react";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export default function ImageCaptchaField(props: {
  id: string;
  value: string;
  imageDataUrl?: string;
  loading: boolean;
  refreshDisabled: boolean;
  refreshTitle: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={props.id}>{t("图片验证码")}</Label>
      <div className="flex min-w-0 items-stretch gap-2">
        <button type="button" onClick={props.onRefresh} disabled={props.disabled || props.refreshDisabled} title={props.refreshTitle} aria-label={props.refreshTitle}
          className="flex h-[72px] min-w-0 flex-1 items-center justify-center overflow-hidden rounded-md border bg-slate-50 disabled:cursor-not-allowed">
          {props.imageDataUrl
            ? <img src={props.imageDataUrl} alt={t("图片验证码")} className="h-full w-full select-none object-contain" draggable={false} />
            : props.loading ? <Loader2 className="h-5 w-5 animate-spin text-slate-500" />
            : <span className="text-sm text-slate-500">{t("验证码暂不可用")}</span>}
        </button>
        <button type="button" onClick={props.onRefresh} disabled={props.disabled || props.refreshDisabled} title={props.refreshTitle} aria-label={props.refreshTitle}
          className="flex w-11 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${props.loading ? "animate-spin" : ""}`} />
        </button>
      </div>
      <Input id={props.id} type="text" inputMode="text" autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={6}
        placeholder={t("请输入图片中的字符")} value={props.value} onChange={event => props.onChange(event.target.value)} disabled={props.disabled || !props.imageDataUrl} />
    </div>
  );
}
