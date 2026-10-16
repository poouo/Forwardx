import * as React from "react";
import { Check, Copy } from "lucide-react";
import { copyTextToClipboard } from "@/lib/clipboard";
import { toast } from "@/lib/localizedToast";
import { t as translateText } from "@/i18n";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface CopyButtonProps extends Omit<ButtonProps, "onClick"> {
  value: string;
  successMessage?: string;
  onCopied?: () => void;
  iconClassName?: string;
}

export const CopyButton = React.forwardRef<HTMLButtonElement, CopyButtonProps>(
  (
    {
      value,
      successMessage,
      onCopied,
      className,
      iconClassName,
      variant = "ghost",
      size = "icon",
      children,
      ...props
    },
    ref
  ) => {
    const [copied, setCopied] = React.useState(false);

    const handleCopy = async (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      e.preventDefault();
      if (!value) return;

      const success = await copyTextToClipboard(value);
      if (success) {
        setCopied(true);
        toast.success(successMessage || translateText("已复制"));
        onCopied?.();
        setTimeout(() => setCopied(false), 2000);
      } else {
        toast.error(translateText("复制失败，请手动复制"));
      }
    };

    return (
      <Button
        ref={ref}
        type="button"
        variant={variant}
        size={size}
        onClick={handleCopy}
        className={cn(
          "transition-all duration-200 active:scale-95",
          copied && "text-emerald-500 hover:text-emerald-600",
          className
        )}
        title={copied ? translateText("已复制") : translateText("复制")}
        aria-label={copied ? translateText("已复制") : translateText("复制")}
        {...props}
      >
        {copied ? (
          <Check
            className={cn(
              "h-4 w-4 shrink-0 transition-transform duration-200 animate-in zoom-in-50",
              iconClassName
            )}
          />
        ) : (
          <Copy
            className={cn(
              "h-4 w-4 shrink-0 transition-transform duration-200",
              iconClassName
            )}
          />
        )}
        {children}
      </Button>
    );
  }
);

CopyButton.displayName = "CopyButton";

