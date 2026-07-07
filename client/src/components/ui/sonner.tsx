import * as React from "react"
import { useTheme } from "@/contexts/ThemeContext"
import { useOverlayContainer } from "@/components/ui/overlay-root"
import { cn } from "@/lib/utils"
import { createPortal } from "react-dom"
import { Toaster as Sonner } from "sonner"

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = ({ className, style, toastOptions, ...props }: ToasterProps) => {
  const { resolvedTheme } = useTheme()
  const overlayContainer = useOverlayContainer()

  const toaster = (
    <Sonner
      theme={resolvedTheme}
      position="bottom-right"
      className={cn("toaster group", className)}
      style={{ zIndex: 200, ...style }}
      toastOptions={{
        ...toastOptions,
        classNames: {
          toast: "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
          ...toastOptions?.classNames,
        },
      }}
      {...props}
    />
  )

  return overlayContainer ? createPortal(toaster, overlayContainer) : toaster
}

export { Toaster }
