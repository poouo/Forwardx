import type { ComponentType, CSSProperties, ReactNode } from "react";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export type SlidingTabItem<T extends string = string> = {
  value: T;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  badge?: ReactNode;
  disabled?: boolean;
};

const slidingTabTriggerClass = "group relative z-10 h-9 min-w-0 justify-center gap-1.5 rounded-full border-0 bg-transparent px-3 text-sm font-medium text-muted-foreground shadow-none ring-0 transition-colors duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-transparent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/35 data-[state=active]:border-transparent data-[state=active]:bg-transparent data-[state=active]:text-primary-foreground data-[state=active]:shadow-none data-[state=active]:ring-0 [&>svg]:shrink-0";

type SlidingTabsListProps<T extends string> = {
  items: readonly SlidingTabItem<T>[];
  activeValue: T;
  ariaLabel?: string;
  className?: string;
  listClassName?: string;
  triggerClassName?: string;
  iconClassName?: string;
  badgeClassName?: string;
  minItemWidthRem?: number;
};

export function SlidingTabsList<T extends string>({
  items,
  activeValue,
  ariaLabel,
  className,
  listClassName,
  triggerClassName,
  iconClassName,
  badgeClassName,
  minItemWidthRem = 7.25,
}: SlidingTabsListProps<T>) {
  const count = Math.max(1, items.length);
  const activeIndex = Math.max(0, items.findIndex((item) => item.value === activeValue));
  const gapRem = 0.25;
  const indicatorStyle: CSSProperties = {
    left: "0.375rem",
    width: `calc((100% - 0.75rem - ${(count - 1) * gapRem}rem) / ${count})`,
    transform: `translateX(calc(${activeIndex} * (100% + ${gapRem}rem)))`,
  };
  const listStyle: CSSProperties = {
    gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`,
    minWidth: `max(${Math.max(count * minItemWidthRem, minItemWidthRem)}rem, 100%)`,
  };

  return (
    <div className={cn("w-full overflow-x-auto pb-1", className)}>
      <TabsList
        aria-label={ariaLabel}
        className={cn(
          "relative grid h-auto gap-1 overflow-hidden rounded-full border border-border/70 bg-background/90 p-1.5 text-muted-foreground shadow-[0_1px_1px_rgba(14,17,22,0.04),0_20px_40px_-24px_rgba(14,17,22,0.18)] backdrop-blur-md",
          listClassName,
        )}
        style={listStyle}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-1.5 top-1.5 rounded-full bg-primary shadow-[0_1px_1px_rgba(14,17,22,0.06),0_8px_18px_-10px_rgba(14,17,22,0.35)] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
          style={indicatorStyle}
        />
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <TabsTrigger
              key={item.value}
              value={item.value}
              disabled={item.disabled}
              className={cn(slidingTabTriggerClass, triggerClassName)}
            >
              {Icon && <Icon className={cn("h-3.5 w-3.5", iconClassName)} />}
              {item.label}
              {item.badge !== undefined && item.badge !== null && (
                <span className={cn(
                  "ml-0.5 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-muted px-1.5 text-[10px] font-semibold leading-none text-muted-foreground transition-colors group-data-[state=active]:bg-primary-foreground/20 group-data-[state=active]:text-primary-foreground",
                  badgeClassName,
                )}>
                  {item.badge}
                </span>
              )}
            </TabsTrigger>
          );
        })}
      </TabsList>
    </div>
  );
}
