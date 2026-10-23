import * as React from "react"
import { cn } from "@/lib/utils"

type CardProps = React.HTMLAttributes<HTMLDivElement> & {
  enterIndex?: number
  disableEnterAnimation?: boolean
  variant?: "default" | "featured"
  /** Border/shadow feedback only: safe for sortable cards and nested controls. */
  interactive?: boolean
  /** Gentle lift for standalone overview/product cards, not sortable/form containers. */
  hoverable?: boolean
}

function isDialogMotionLocked() {
  if (typeof document === "undefined") return false
  const lockUntil = Number(document.body.dataset.dialogMotionLockUntil || "0")
  return document.body.hasAttribute("data-dialog-motion-lock")
    || document.body.hasAttribute("data-dialog-scroll-lock")
    || document.body.hasAttribute("data-scroll-locked")
    || Date.now() < lockUntil
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(({ className, style, enterIndex, disableEnterAnimation, variant = "default", interactive = false, hoverable = false, ...props }, ref) => {
  const [animateEnter, setAnimateEnter] = React.useState(() => !disableEnterAnimation && !isDialogMotionLocked())
  const enterStyle = enterIndex === undefined
    ? style
    : ({
        ...style,
        "--card-enter-delay": `${Math.min(Math.max(enterIndex, 0), 12) * 45}ms`,
      } as React.CSSProperties)

  React.useEffect(() => {
    if (!animateEnter) return
    const delay = Math.min(Math.max(enterIndex ?? 0, 0), 12) * 45
    // The stylesheet can stagger unspecified indices by up to 360ms.
    const timer = window.setTimeout(() => setAnimateEnter(false), (enterIndex === undefined ? 360 : delay) + 420)
    return () => window.clearTimeout(timer)
  }, [animateEnter, enterIndex])

  return (
    <div
      ref={ref}
      className={cn(
        "glass-panel pearl-card rounded-2xl transition-[border-color,box-shadow,transform] duration-300",
        variant === "featured" && "pearl-card-featured",
        interactive && "pearl-card-interactive",
        hoverable && "pearl-hover-card",
        animateEnter && "stagger-card",
        className,
      )}
      style={enterStyle}
      {...props}
    />
  )
})
Card.displayName = "Card"

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("pearl-card-header flex min-w-0 flex-col space-y-1.5", className)} {...props} />
))
CardHeader.displayName = "CardHeader"

const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("min-w-0 break-words [&>svg]:shrink-0 text-lg font-semibold leading-snug tracking-tight", className)} {...props} />
))
CardTitle.displayName = "CardTitle"

const CardDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("min-w-0 [overflow-wrap:anywhere] text-sm leading-relaxed text-muted-foreground", className)} {...props} />
))
CardDescription.displayName = "CardDescription"

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("pearl-card-content min-w-0", className)} {...props} />
))
CardContent.displayName = "CardContent"

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("pearl-card-footer flex min-w-0 items-center", className)} {...props} />
))
CardFooter.displayName = "CardFooter"

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent }
