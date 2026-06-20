import * as React from "react"
import { cn } from "@/lib/utils"

type CardProps = React.HTMLAttributes<HTMLDivElement> & {
  enterIndex?: number
  disableEnterAnimation?: boolean
}

function isDialogMotionLocked() {
  if (typeof document === "undefined") return false
  const lockUntil = Number(document.body.dataset.dialogMotionLockUntil || "0")
  return document.body.hasAttribute("data-dialog-motion-lock")
    || document.body.hasAttribute("data-dialog-scroll-lock")
    || document.body.hasAttribute("data-scroll-locked")
    || Date.now() < lockUntil
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(({ className, style, enterIndex, disableEnterAnimation, ...props }, ref) => {
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
    const timer = window.setTimeout(() => setAnimateEnter(false), delay + 420)
    return () => window.clearTimeout(timer)
  }, [animateEnter, enterIndex])

  return (
    <div
      ref={ref}
      className={cn(
        "glass-panel rounded-lg transition-[border-color,box-shadow,transform] duration-300",
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
  <div ref={ref} className={cn("flex flex-col space-y-1.5 p-6", className)} {...props} />
))
CardHeader.displayName = "CardHeader"

const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("text-2xl font-semibold leading-none tracking-tight", className)} {...props} />
))
CardTitle.displayName = "CardTitle"

const CardDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
))
CardDescription.displayName = "CardDescription"

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
))
CardContent.displayName = "CardContent"

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("flex items-center p-6 pt-0", className)} {...props} />
))
CardFooter.displayName = "CardFooter"

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent }
