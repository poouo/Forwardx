import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"
import { cn } from "@/lib/utils"
import { useOverlayContainer } from "@/components/ui/overlay-root"

const TooltipProvider = TooltipPrimitive.Provider
const Tooltip = TooltipPrimitive.Root
const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipPortal = ({ container, ...props }: React.ComponentProps<typeof TooltipPrimitive.Portal>) => {
  const overlayContainer = useOverlayContainer()
  return <TooltipPrimitive.Portal container={container ?? overlayContainer} {...props} />
}
TooltipPortal.displayName = TooltipPrimitive.Portal.displayName

const TooltipContent = React.forwardRef<React.ComponentRef<typeof TooltipPrimitive.Content>, React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPortal>
    <TooltipPrimitive.Content ref={ref} sideOffset={sideOffset} className={cn("z-50 overflow-hidden rounded-md border bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2", className)} {...props} />
  </TooltipPortal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, TooltipPortal }
