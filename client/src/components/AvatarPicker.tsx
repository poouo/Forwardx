import { ChangeEvent, useRef } from "react";
import { Image, Shuffle, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/UserAvatar";
import { DEFAULT_AVATAR_SEEDS, avatarPreset, fileToImageDataUrl } from "@/lib/avatar";
import { cn } from "@/lib/utils";

type AvatarPickerProps = {
  value: string;
  onChange: (value: string) => void;
  fallback?: string | number | null;
  disabled?: boolean;
  randomDisabled?: boolean;
  randomLoading?: boolean;
  onRandom?: () => void;
  className?: string;
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
  className,
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
      onError?.(error?.message || "头像处理失败");
    }
  };

  const randomPreset = () => {
    if (onRandom) {
      onRandom();
      return;
    }
    const seed = DEFAULT_AVATAR_SEEDS[Math.floor(Math.random() * DEFAULT_AVATAR_SEEDS.length)] || "nova";
    onChange(avatarPreset(`${seed}-${Math.random().toString(36).slice(2, 8)}`));
  };

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex items-center gap-3">
        <UserAvatar user={{ id: fallback, username: String(fallback || ""), avatar: value }} className="h-14 w-14" />
        <div className="flex min-w-0 flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => inputRef.current?.click()} disabled={disabled}>
            <Upload className="h-4 w-4" />
            上传
          </Button>
          <Button type="button" variant="outline" size="sm" className="gap-2" onClick={randomPreset} disabled={disabled || randomDisabled || randomLoading}>
            <Shuffle className="h-4 w-4" />
            {randomLoading ? "随机中..." : "随机"}
          </Button>
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
      <div className="grid grid-cols-6 gap-2 sm:grid-cols-8">
        {DEFAULT_AVATAR_SEEDS.map((seed) => {
          const preset = avatarPreset(seed);
          const selected = value === preset;
          return (
            <button
              type="button"
              key={seed}
              className={cn(
                "flex aspect-square items-center justify-center rounded-full border bg-background transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected ? "border-primary ring-2 ring-primary/30" : "border-border/50 hover:border-primary/50",
              )}
              onClick={() => onChange(preset)}
              disabled={disabled}
              title={seed}
            >
              <UserAvatar user={{ id: seed, username: seed, avatar: preset }} className="h-full w-full border-0" />
            </button>
          );
        })}
        <button
          type="button"
          className="flex aspect-square items-center justify-center rounded-full border border-dashed border-border/70 bg-muted/20 text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          title="上传头像"
        >
          <Image className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
