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

type OptimisticSwitchProps = Omit<SwitchProps, "checked" | "defaultChecked" | "onCheckedChange"> & {
  checked: boolean;
  onCheckedChangeAsync: (checked: boolean) => Promise<unknown>;
  onToggleSuccess?: (checked: boolean) => void;
  onToggleError?: (error: unknown, checked: boolean) => void;
};

const OptimisticSwitch = React.forwardRef<React.ComponentRef<typeof SwitchPrimitives.Root>, OptimisticSwitchProps>(
  ({ checked, disabled, onCheckedChangeAsync, onToggleSuccess, onToggleError, ...props }, ref) => {
    const [visualChecked, setVisualChecked] = React.useState(checked);
    const [isPending, setIsPending] = React.useState(false);
    const confirmedRef = React.useRef(checked);
    const desiredRef = React.useRef(checked);
    const runningRef = React.useRef(false);
    const mountedRef = React.useRef(true);
    const externalCheckedRef = React.useRef(checked);
    const callbacksRef = React.useRef({ onCheckedChangeAsync, onToggleSuccess, onToggleError });
    externalCheckedRef.current = checked;
    callbacksRef.current = { onCheckedChangeAsync, onToggleSuccess, onToggleError };

    React.useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
      };
    }, []);

    React.useEffect(() => {
      if (runningRef.current) return;
      confirmedRef.current = checked;
      desiredRef.current = checked;
      setVisualChecked(checked);
    }, [checked]);

    const runQueue = React.useCallback(async () => {
      if (runningRef.current) return;
      runningRef.current = true;
      if (mountedRef.current) setIsPending(true);
      try {
        while (desiredRef.current !== confirmedRef.current) {
          const nextChecked = desiredRef.current;
          try {
            await callbacksRef.current.onCheckedChangeAsync(nextChecked);
          } catch (error) {
            if (desiredRef.current === nextChecked) {
              desiredRef.current = confirmedRef.current;
              if (mountedRef.current) setVisualChecked(confirmedRef.current);
            }
            callbacksRef.current.onToggleError?.(error, nextChecked);
            continue;
          }

          confirmedRef.current = nextChecked;
          if (desiredRef.current === nextChecked) {
            callbacksRef.current.onToggleSuccess?.(nextChecked);
          }
        }
      } finally {
        runningRef.current = false;
        if (mountedRef.current) {
          setIsPending(false);
          if (externalCheckedRef.current === confirmedRef.current) {
            setVisualChecked(externalCheckedRef.current);
          }
        }
      }
    }, []);

    return (
      <Switch
        {...props}
        ref={ref}
        checked={visualChecked}
        disabled={disabled}
        aria-busy={isPending || undefined}
        data-pending={isPending ? "true" : "false"}
        onCheckedChange={(nextChecked) => {
          desiredRef.current = nextChecked;
          setVisualChecked(nextChecked);
          void runQueue();
        }}
      />
    );
  },
)
OptimisticSwitch.displayName = "OptimisticSwitch"

export { OptimisticSwitch, Switch }
