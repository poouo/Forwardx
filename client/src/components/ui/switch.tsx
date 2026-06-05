import * as React from "react"
import * as SwitchPrimitives from "@radix-ui/react-switch"
import { cn } from "@/lib/utils"

type SwitchProps = React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root> & {
  instant?: boolean;
};

const Switch = React.forwardRef<React.ComponentRef<typeof SwitchPrimitives.Root>, SwitchProps>(({ className, instant = false, ...props }, ref) => (
  <SwitchPrimitives.Root className={cn("peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-border/70 bg-muted/80 shadow-inner focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 data-[state=checked]:border-primary/70 data-[state=checked]:bg-primary data-[state=unchecked]:border-border/70 data-[state=unchecked]:bg-muted/80 dark:data-[state=unchecked]:border-slate-500 dark:data-[state=unchecked]:bg-slate-700/90", instant ? "" : "transition-colors", className)} {...props} ref={ref}>
    <SwitchPrimitives.Thumb className={cn("pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 data-[state=checked]:translate-x-5 data-[state=checked]:bg-primary-foreground data-[state=unchecked]:translate-x-0 data-[state=unchecked]:bg-background dark:data-[state=unchecked]:bg-slate-100", instant ? "" : "transition-transform")} />
  </SwitchPrimitives.Root>
))
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch }
