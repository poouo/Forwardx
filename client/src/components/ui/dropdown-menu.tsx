import * as React from "react"
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu"
import { cn } from "@/lib/utils"
import { useOverlayContainer } from "@/components/ui/overlay-root"

const DropdownMenu = DropdownMenuPrimitive.Root
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger
const DropdownMenuGroup = DropdownMenuPrimitive.Group
const DropdownMenuPortal = ({ container, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) => {
  const overlayContainer = useOverlayContainer()
  return <DropdownMenuPrimitive.Portal container={container ?? overlayContainer} {...props} />
}
DropdownMenuPortal.displayName = DropdownMenuPrimitive.Portal.displayName
const DropdownMenuSub = DropdownMenuPrimitive.Sub
const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup

const DropdownMenuContent = React.forwardRef<React.ComponentRef<typeof DropdownMenuPrimitive.Content>, React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>>(({ className, sideOffset = 6, ...props }, ref) => (
  <DropdownMenuPortal>
    <DropdownMenuPrimitive.Content ref={ref} sideOffset={sideOffset} className={cn("action-menu-content z-50 min-w-48 overflow-hidden rounded-lg border p-2 text-popover-foreground shadow-xl backdrop-blur-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2", className)} {...props} />
  </DropdownMenuPortal>
))
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName

type DropdownMenuItemProps = React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean;
  variant?: "default" | "destructive";
};

const DropdownMenuItem = React.forwardRef<React.ComponentRef<typeof DropdownMenuPrimitive.Item>, DropdownMenuItemProps>(({ className, inset, variant = "default", ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      "action-menu-item relative flex min-h-9 cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium leading-5 outline-none",
      "active:scale-[0.99] data-[highlighted]:font-semibold data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
      variant === "destructive" && "action-menu-item-destructive",
      inset && "pl-8",
      className,
    )}
    {...props}
  />
))
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName

const DropdownMenuSeparator = React.forwardRef<React.ComponentRef<typeof DropdownMenuPrimitive.Separator>, React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator ref={ref} className={cn("-mx-2 my-2 h-px bg-border/70", className)} {...props} />
))
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName

const DropdownMenuLabel = React.forwardRef<React.ComponentRef<typeof DropdownMenuPrimitive.Label>, React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & { inset?: boolean }>(({ className, inset, ...props }, ref) => (
  <DropdownMenuPrimitive.Label ref={ref} className={cn("px-2.5 py-1.5 text-xs font-semibold text-muted-foreground", inset && "pl-8", className)} {...props} />
))
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName

export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel, DropdownMenuGroup, DropdownMenuPortal, DropdownMenuSub, DropdownMenuRadioGroup }
