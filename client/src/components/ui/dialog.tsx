import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { cn } from "@/lib/utils"
import { X } from "lucide-react"

const LOCK_RELEASE_DELAY_MS = 360
const MOTION_LOCK_RELEASE_DELAY_MS = 520

const Dialog = ({ open, defaultOpen, onOpenChange, modal = true, ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) => {
  const [internalOpen, setInternalOpen] = React.useState(Boolean(defaultOpen))
  const isOpen = open ?? internalOpen
  const lockActiveRef = React.useRef(false)
  const releaseTimerRef = React.useRef<number | null>(null)
  const motionReleaseTimerRef = React.useRef<number | null>(null)

  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    setInternalOpen(nextOpen)
    onOpenChange?.(nextOpen)
  }, [onOpenChange])

  const markMotionLocked = React.useCallback(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return
    if (motionReleaseTimerRef.current !== null) {
      window.clearTimeout(motionReleaseTimerRef.current)
      motionReleaseTimerRef.current = null
    }
    document.body.dataset.dialogMotionLock = "true"
    document.body.dataset.dialogMotionLockUntil = String(Date.now() + MOTION_LOCK_RELEASE_DELAY_MS)
  }, [])

  const releaseMotionLock = React.useCallback(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return
    document.body.dataset.dialogMotionLockUntil = String(Date.now() + MOTION_LOCK_RELEASE_DELAY_MS)
    if (motionReleaseTimerRef.current !== null) window.clearTimeout(motionReleaseTimerRef.current)
    motionReleaseTimerRef.current = window.setTimeout(() => {
      motionReleaseTimerRef.current = null
      const lockUntil = Number(document.body.dataset.dialogMotionLockUntil || "0")
      if (Date.now() >= lockUntil && !document.body.dataset.dialogScrollLock) {
        delete document.body.dataset.dialogMotionLock
        delete document.body.dataset.dialogMotionLockUntil
      }
    }, MOTION_LOCK_RELEASE_DELAY_MS)
  }, [])

  const releaseScrollLock = React.useCallback(() => {
    if (!lockActiveRef.current || typeof document === "undefined") return
    const nextCount = Number(document.body.dataset.dialogScrollLock || "1") - 1
    if (nextCount > 0) {
      document.body.dataset.dialogScrollLock = String(nextCount)
    } else {
      delete document.body.dataset.dialogScrollLock
      delete document.body.dataset.dialogHadScrollbar
      releaseMotionLock()
      document.body.style.removeProperty("--fx-dialog-lock-width")
      document.documentElement.style.removeProperty("--fx-dialog-lock-width")
    }
    lockActiveRef.current = false
  }, [releaseMotionLock])

  React.useLayoutEffect(() => {
    if (!modal || typeof document === "undefined") return
    if (isOpen) {
      markMotionLocked()
      if (releaseTimerRef.current !== null) {
        window.clearTimeout(releaseTimerRef.current)
        releaseTimerRef.current = null
      }
      if (!lockActiveRef.current) {
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth
        const layoutWidth = document.documentElement.clientWidth || viewportWidth
        if (!document.body.dataset.dialogScrollLock) {
          const hasVisibleScrollbar = viewportWidth - layoutWidth > 1
          const lockWidth = `${Math.min(viewportWidth, layoutWidth)}px`
          document.body.dataset.dialogHadScrollbar = hasVisibleScrollbar ? "true" : "false"
          document.body.style.setProperty("--fx-dialog-lock-width", lockWidth)
          document.documentElement.style.setProperty("--fx-dialog-lock-width", lockWidth)
        }
        const count = Number(document.body.dataset.dialogScrollLock || "0") + 1
        document.body.dataset.dialogScrollLock = String(count)
        lockActiveRef.current = true
      }
      return
    }
    if (lockActiveRef.current && releaseTimerRef.current === null) {
      releaseTimerRef.current = window.setTimeout(() => {
        releaseTimerRef.current = null
        releaseScrollLock()
      }, LOCK_RELEASE_DELAY_MS)
    }
  }, [isOpen, markMotionLocked, modal, releaseScrollLock])

  React.useLayoutEffect(() => () => {
    if (releaseTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(releaseTimerRef.current)
      releaseTimerRef.current = null
    }
    if (motionReleaseTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(motionReleaseTimerRef.current)
      motionReleaseTimerRef.current = null
    }
    releaseScrollLock()
    releaseMotionLock()
  }, [releaseMotionLock, releaseScrollLock])

  return <DialogPrimitive.Root open={open} defaultOpen={defaultOpen} onOpenChange={handleOpenChange} modal={modal} {...props} />
}
Dialog.displayName = DialogPrimitive.Root.displayName
const DialogTrigger = DialogPrimitive.Trigger
const DialogPortal = DialogPrimitive.Portal
const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<React.ComponentRef<typeof DialogPrimitive.Overlay>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay ref={ref} className={cn("dialog-overlay fixed inset-0 z-50 overflow-hidden", className)} {...props} />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<React.ComponentRef<typeof DialogPrimitive.Content>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content ref={ref} className={cn("dialog-panel fixed left-[50%] top-[50%] z-50 grid max-h-[92svh] w-[calc(100vw-1.5rem)] max-w-lg gap-4 overflow-x-hidden overflow-y-auto overscroll-contain rounded-md p-4 pr-5 sm:w-full sm:p-6 sm:pr-7", className)} {...props}>
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground opacity-70 ring-offset-background transition-colors hover:bg-destructive/10 hover:text-destructive hover:opacity-100 focus:bg-destructive/10 focus:text-destructive focus:outline-none focus:ring-2 focus:ring-destructive/40 focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)} {...props} />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)} {...props} />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<React.ComponentRef<typeof DialogPrimitive.Title>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-lg font-semibold leading-none tracking-tight", className)} {...props} />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<React.ComponentRef<typeof DialogPrimitive.Description>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export { Dialog, DialogPortal, DialogOverlay, DialogClose, DialogTrigger, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription }