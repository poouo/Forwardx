import * as React from "react"
import * as SelectPrimitive from "@radix-ui/react-select"
import { Check, ChevronDown, ChevronUp } from "lucide-react"
import { cn } from "@/lib/utils"
import { useOverlayContainer } from "@/components/ui/overlay-root"

const SELECT_OPEN_ATTR = "forwardxSelectOpen"

function markSelectOpen() {
  if (typeof document === "undefined" || typeof window === "undefined") return () => {}
  const count = Number(document.body.dataset[SELECT_OPEN_ATTR] || "0") + 1
  document.body.dataset[SELECT_OPEN_ATTR] = String(count)
  return () => {
    const nextCount = Number(document.body.dataset[SELECT_OPEN_ATTR] || "1") - 1
    if (nextCount > 0) {
      document.body.dataset[SELECT_OPEN_ATTR] = String(nextCount)
    } else {
      delete document.body.dataset[SELECT_OPEN_ATTR]
    }
  }
}

const Select = ({ open, defaultOpen, onOpenChange, ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) => {
  const [internalOpen, setInternalOpen] = React.useState(Boolean(defaultOpen))
  const isOpen = open ?? internalOpen

  React.useEffect(() => {
    if (!isOpen) return
    return markSelectOpen()
  }, [isOpen])

  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    setInternalOpen(nextOpen)
    onOpenChange?.(nextOpen)
  }, [onOpenChange])

  return <SelectPrimitive.Root open={open} defaultOpen={defaultOpen} onOpenChange={handleOpenChange} {...props} />
}
Select.displayName = SelectPrimitive.Root.displayName
const SelectGroup = SelectPrimitive.Group
const SelectValue = SelectPrimitive.Value

const SelectTrigger = React.forwardRef<React.ComponentRef<typeof SelectPrimitive.Trigger>, React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger ref={ref} className={cn("flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-inset focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1", className)} {...props}>
    {children}
    <SelectPrimitive.Icon asChild><ChevronDown className="h-4 w-4 opacity-50" /></SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
))
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName

const SelectPortal = ({ container, ...props }: React.ComponentProps<typeof SelectPrimitive.Portal>) => {
  const overlayContainer = useOverlayContainer()
  return <SelectPrimitive.Portal container={container ?? overlayContainer} {...props} />
}
SelectPortal.displayName = SelectPrimitive.Portal.displayName

const SelectContent = React.forwardRef<React.ComponentRef<typeof SelectPrimitive.Content>, React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>>(({ className, children, position = "popper", ...props }, ref) => (
  <SelectPortal>
    <SelectPrimitive.Content ref={ref} className={cn("relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2", position === "popper" && "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1", className)} position={position} {...props}>
      <SelectPrimitive.Viewport className={cn("p-1", position === "popper" && "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]")}>{children}</SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPortal>
))
SelectContent.displayName = SelectPrimitive.Content.displayName

const SelectItem = React.forwardRef<React.ComponentRef<typeof SelectPrimitive.Item>, React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item ref={ref} className={cn("relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50", className)} {...props}>
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center"><SelectPrimitive.ItemIndicator><Check className="h-4 w-4" /></SelectPrimitive.ItemIndicator></span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
))
SelectItem.displayName = SelectPrimitive.Item.displayName

export { Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectItem, SelectPortal }
