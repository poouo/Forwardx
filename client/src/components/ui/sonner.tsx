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
          // Sonner owns these theme variables. Using the panel's foreground
          // token here can override them when the portal is outside `.dark`,
          // producing black text on a dark toast (and the reverse in light mode).
          toast: "group toast group-[.toaster]:bg-[var(--normal-bg)] group-[.toaster]:text-[var(--normal-text)] group-[.toaster]:border-[var(--normal-border)] group-[.toaster]:shadow-lg",
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
