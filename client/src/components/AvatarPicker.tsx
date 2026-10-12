import { getLanguage, t as translateText } from "@/i18n";
import { ChangeEvent, ReactNode, useRef } from "react";
import { Shuffle, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/UserAvatar";
import { BUILTIN_AVATARS, builtinAvatarPath, builtinAvatarValue, fileToImageDataUrl, migrateLegacyAvatarValue, randomBuiltinAvatarValue } from "@/lib/avatar";
import { cn } from "@/lib/utils";

type AvatarPickerProps = {
  value: string;
  onChange: (value: string) => void;
  fallback?: string | number | null;
  disabled?: boolean;
  randomDisabled?: boolean;
  randomLoading?: boolean;
  onRandom?: () => void;
  actions?: ReactNode;
  className?: string;
  controlsClassName?: string;
  gridClassName?: string;
  previewClassName?: string;
  onError?: (message: string) => void;
};

export function AvatarPicker({
  value,
  onChange,
  fallback,
  disabled,
  randomDisabled,
  randomLoading,
  onRandom,
  actions,
  className,
  controlsClassName,
  gridClassName,
  previewClassName,
  onError,
}: AvatarPickerProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      onChange(await fileToImageDataUrl(file));
    } catch (error: any) {
      onError?.(error?.message || translateText("头像处理失败"));
    }
  };

  const randomPreset = () => {
    if (onRandom) {
      onRandom();
      return;
    }
    onChange(randomBuiltinAvatarValue(migrateLegacyAvatarValue(value, fallback)));
  };

  return (
    <div className={cn("space-y-3", className)}>
      <div className={cn("flex items-center gap-3", controlsClassName)}>
        <UserAvatar user={{ id: fallback, username: String(fallback || ""), avatar: value }} className={cn("h-14 w-14", previewClassName)} />
        <div className="flex min-w-0 flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => inputRef.current?.click()} disabled={disabled}>
            <Upload className="h-4 w-4" />{translateText("上传")}</Button>
          <Button type="button" variant="outline" size="sm" className="gap-2" onClick={randomPreset} disabled={disabled || randomDisabled || randomLoading}>
            <Shuffle className="h-4 w-4" />
            {randomLoading ? translateText("随机中...") : translateText("随机")}
          </Button>
          {actions}
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={handleUpload}
        disabled={disabled}
      />
      <div className={cn("grid grid-cols-5 gap-2 sm:gap-3", gridClassName)}>
        {BUILTIN_AVATARS.map((avatar) => {
          const preset = builtinAvatarValue(avatar.id);
          const selected = migrateLegacyAvatarValue(value, fallback) === preset;
          const label = getLanguage() === "en" ? avatar.nameEn : avatar.name;
          return (
            <button
              type="button"
              key={avatar.id}
              className={cn(
                "flex aspect-square items-center justify-center overflow-hidden rounded-full border bg-background transition-[transform,box-shadow,border-color] duration-200 motion-safe:hover:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                selected ? "border-primary ring-2 ring-primary/30" : "border-border/50 hover:border-primary/50",
              )}
              onClick={() => onChange(preset)}
              disabled={disabled}
              title={label}
              aria-label={label}
              aria-pressed={selected}
            >
              <img src={builtinAvatarPath(preset)} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
