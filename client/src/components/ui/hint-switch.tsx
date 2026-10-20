import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef, type ReactNode } from "react";
import { Switch } from "./switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";
import { cn } from "@/lib/utils";

export function SwitchHint({ hint, disabled, children }: {
  hint?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  if (!hint) return <>{children}</>;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn("inline-flex shrink-0 align-middle rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50", disabled && "cursor-not-allowed [&>button]:pointer-events-none")}
            tabIndex={disabled ? 0 : undefined}
            role={disabled ? "group" : undefined}
            aria-label={disabled ? hint : undefined}
          >
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent collisionPadding={12} className="max-w-[280px] whitespace-pre-line text-xs">{hint}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

const HintSwitch = forwardRef<ComponentRef<typeof Switch>, ComponentPropsWithoutRef<typeof Switch> & { hint: string }>(
  ({ hint, ...props }, ref) => <SwitchHint hint={hint} disabled={props.disabled}><Switch {...props} ref={ref} /></SwitchHint>,
);
HintSwitch.displayName = "HintSwitch";
export { HintSwitch };
