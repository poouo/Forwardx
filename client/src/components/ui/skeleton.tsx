import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("pearl-skeleton animate-pulse rounded-md bg-muted motion-reduce:animate-none", className)} {...props} />
}

export { Skeleton }
