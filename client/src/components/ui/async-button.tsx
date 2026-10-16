import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button, type ButtonProps } from "./button";
import { usePendingFeedback } from "@/hooks/usePendingFeedback";
import { cn } from "@/lib/utils";

export interface AsyncButtonProps extends Omit<ButtonProps, "asChild"> {
  pending: boolean;
}

export const AsyncButton = React.forwardRef<HTMLButtonElement, AsyncButtonProps>(
  ({ pending, disabled, className, children, type = "button", ...props }, ref) => {
    const visible = usePendingFeedback(pending);
    const busy = pending || visible;
    return <Button {...props} ref={ref} type={type} disabled={disabled || busy}
      aria-busy={busy} data-pending={busy || undefined} data-loading={visible || undefined}
      className={cn("pearl-async-button relative data-[pending=true]:disabled:opacity-100", className)}>
      <span className={cn("inline-flex items-center justify-center gap-[inherit] transition-opacity duration-150 motion-reduce:transition-none", visible && "opacity-0")}>{children}</span>
      <span aria-hidden="true" className={cn("pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity duration-150 motion-reduce:transition-none", visible ? "opacity-100" : "opacity-0")}>
        <Loader2 className={cn("size-4", visible && "animate-spin motion-reduce:animate-none")} />
      </span>
    </Button>;
  },
);
AsyncButton.displayName = "AsyncButton";
