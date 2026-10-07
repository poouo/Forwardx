import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type CSSProperties, type ReactNode } from "react";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export type SlidingTabItem<T extends string = string> = {
  value: T;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  badge?: ReactNode;
  disabled?: boolean;
};

const slidingTabTriggerClass = "group relative z-10 h-9 min-w-max whitespace-nowrap justify-center gap-1.5 rounded-full border-0 bg-transparent px-3 text-sm font-medium text-muted-foreground shadow-none ring-0 transition-colors duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-transparent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/35 data-[state=active]:border-transparent data-[state=active]:bg-transparent data-[state=active]:font-medium data-[state=active]:text-primary-foreground data-[state=active]:shadow-none data-[state=active]:ring-0 [&>svg]:shrink-0";

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
  const scrollerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });
  const indicatorStyle: CSSProperties = {
    left: 0,
    width: indicator.width,
    transform: `translateX(${indicator.left}px)`,
    opacity: indicator.width > 0 ? 1 : 0,
  };
  const listStyle: CSSProperties = {
    // Intrinsic label/icon/badge widths are the floor, not a Chinese-sized
    // fixed column. Overflow stays inside the horizontal tab scroller.
    gridTemplateColumns: `repeat(${count}, minmax(max-content, auto))`,
    width: "max-content",
    minWidth: `max(${Math.max(count * minItemWidthRem, minItemWidthRem)}rem, 100%)`,
  };

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const activeTab = list.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
      const next = activeTab ? { left: activeTab.offsetLeft, width: activeTab.offsetWidth } : { left: 0, width: 0 };
      setIndicator(previous => previous.left === next.left && previous.width === next.width ? previous : next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    list.querySelectorAll('[role="tab"]').forEach(tab => observer.observe(tab));
    return () => observer.disconnect();
  }, [activeValue, items]);

  useEffect(() => {
    const activeTab = scrollerRef.current?.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
    activeTab?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [activeValue, items.length]);

  return (
    <div ref={scrollerRef} className={cn("min-w-0 w-full max-w-full overflow-x-auto pb-1", className)}>
      <TabsList
        ref={listRef}
        data-sliding-tabs="true"
        aria-label={ariaLabel}
        className={cn(
          "relative grid h-auto gap-1 overflow-hidden rounded-full border border-border/70 bg-background/90 p-1.5 text-muted-foreground shadow-[0_1px_1px_rgba(14,17,22,0.04),0_20px_40px_-24px_rgba(14,17,22,0.18)] backdrop-blur-md",
          listClassName,
        )}
        style={listStyle}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-1.5 top-1.5 rounded-full bg-primary shadow-[0_1px_1px_rgba(14,17,22,0.06),0_8px_18px_-10px_rgba(14,17,22,0.35)] transition-[transform,width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
          style={indicatorStyle}
        />
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <TabsTrigger
              key={item.value}
              value={item.value}
              disabled={item.disabled}
              style={{ minWidth: `${minItemWidthRem}rem` }}
              className={cn(slidingTabTriggerClass, triggerClassName)}
            >
              {Icon && <Icon className={cn("h-3.5 w-3.5 text-current", iconClassName)} />}
              <span className="whitespace-nowrap">{item.label}</span>
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
