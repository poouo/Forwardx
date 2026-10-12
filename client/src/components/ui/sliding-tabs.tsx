import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type CSSProperties, type ReactNode } from "react";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useMotionEnabled } from "@/components/MotionPolicy";

/** Only reveal the clipped tab, without scrolling the entire page vertically. */
export function tabScrollTarget(scrollLeft: number, viewportWidth: number, scrollWidth: number, tabLeft: number, tabWidth: number) {
  const next = tabWidth > viewportWidth || tabLeft < scrollLeft
    ? tabLeft
    : tabLeft + tabWidth > scrollLeft + viewportWidth ? tabLeft + tabWidth - viewportWidth : scrollLeft;
  return Math.max(0, Math.min(next, scrollWidth - viewportWidth));
}

/** Fold overflowing navigation only in a narrow content area, not by device type. */
export function shouldUseCompactTabs(availableWidth: number, requiredWidth: number) {
  return availableWidth > 0 && availableWidth < 768 && requiredWidth > availableWidth + 1;
}

export type SlidingTabItem<T extends string = string> = {
  value: T;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  badge?: ReactNode;
  disabled?: boolean;
};

const slidingTabTriggerClass = "group relative z-10 h-9 min-w-max whitespace-nowrap justify-center gap-1.5 rounded-full border-0 bg-transparent px-3 text-sm font-medium text-muted-foreground shadow-none ring-0 transition-colors duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-transparent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/35 data-[state=active]:border-transparent data-[state=active]:bg-transparent data-[state=active]:font-medium data-[state=active]:text-primary data-[state=active]:shadow-none data-[state=active]:ring-0 [&>svg]:shrink-0";

type SlidingTabsListProps<T extends string> = {
  items: readonly SlidingTabItem<T>[];
  activeValue: T;
  onValueChange: (value: T) => void;
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
  onValueChange,
  ariaLabel,
  className,
  listClassName,
  triggerClassName,
  iconClassName,
  badgeClassName,
  minItemWidthRem = 7.25,
}: SlidingTabsListProps<T>) {
  const count = Math.max(1, items.length);
  const motionEnabled = useMotionEnabled();
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });
  const [compact, setCompact] = useState(false);
  const selectedItem = items.find(item => item.value === activeValue);
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
    const container = containerRef.current;
    if (!list || !container) return;
    const measure = () => {
      // The max-content grid already includes every label/badge. scrollWidth
      // can also include the indicator's stale transform after a resize.
      const nextCompact = shouldUseCompactTabs(container.clientWidth, list.offsetWidth);
      setCompact(previous => previous === nextCompact ? previous : nextCompact);
      if (nextCompact) return;
      const activeTab = list.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
      const next = activeTab ? { left: activeTab.offsetLeft, width: activeTab.offsetWidth } : { left: 0, width: 0 };
      setIndicator(previous => previous.left === next.left && previous.width === next.width ? previous : next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(list);
    list.querySelectorAll('[role="tab"]').forEach(tab => observer.observe(tab));
    return () => observer.disconnect();
  }, [activeValue, items]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const activeTab = scroller?.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
    if (compact || !scroller || !activeTab || scroller.clientWidth <= 0) return;
    const tab = activeTab.getBoundingClientRect();
    const tabLeft = tab.left - scroller.getBoundingClientRect().left - scroller.clientLeft + scroller.scrollLeft;
    const left = tabScrollTarget(scroller.scrollLeft, scroller.clientWidth, scroller.scrollWidth, tabLeft, tab.width);
    if (Math.abs(left - scroller.scrollLeft) > 1) {
      scroller.scrollTo({ left, behavior: motionEnabled ? "smooth" : "instant" });
    }
  }, [activeValue, items.length, indicator.left, indicator.width, motionEnabled, compact]);

  const renderCompactLabel = (item: SlidingTabItem<T>) => {
    const Icon = item.icon;
    return <span className="flex min-w-0 items-center gap-2 text-left">
      {Icon && <Icon className={cn("h-4 w-4 shrink-0 text-current", iconClassName)} />}
      <span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">{item.label}</span>
      {item.badge !== undefined && item.badge !== null && (
        <span className={cn("inline-flex shrink-0 items-center rounded-full bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground", badgeClassName)}>{item.badge}</span>
      )}
    </span>;
  };

  return (
    <div ref={containerRef} data-responsive-tabs="true" data-compact={compact} className={cn("relative min-w-0 w-full max-w-full", className)}>
      {compact && (
        <Select value={activeValue} onValueChange={value => {
          if (value !== activeValue && items.some(item => item.value === value && !item.disabled)) onValueChange(value as T);
        }}>
          <SelectTrigger aria-label={ariaLabel} className="h-auto min-h-11 w-full py-2.5 [&>span]:line-clamp-none">
            <SelectValue>{selectedItem && renderCompactLabel(selectedItem)}</SelectValue>
          </SelectTrigger>
          <SelectContent className="max-h-[min(24rem,var(--radix-select-content-available-height))] max-w-[calc(100vw-2rem)]">
            {items.map(item => (
              <SelectItem key={item.value} value={item.value} textValue={item.label} disabled={item.disabled} className="min-h-11 py-2">
                {renderCompactLabel(item)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {/* Keep the strip measurable while folded so resizing/translation changes
          can restore tabs without a second state or a resize polling loop. */}
      <div ref={scrollerRef} aria-hidden={compact || undefined} inert={compact || undefined} className={cn(
        "min-w-0 w-full max-w-full overflow-x-auto overscroll-x-contain pb-1",
        compact && "pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden pb-0",
      )}>
      <TabsList
        ref={listRef}
        data-sliding-tabs="true"
        aria-label={ariaLabel}
        className={cn(
          "relative grid h-auto gap-1 overflow-hidden rounded-full border border-border/70 bg-muted/70 p-1.5 text-muted-foreground shadow-[0_1px_1px_rgba(14,17,22,0.04),0_20px_40px_-24px_rgba(14,17,22,0.18)]",
          listClassName,
        )}
        style={listStyle}
      >
        <span
          aria-hidden="true"
          className="pearl-tab-indicator pointer-events-none absolute bottom-1.5 top-1.5 rounded-full bg-primary shadow-[0_1px_1px_rgba(14,17,22,0.06),0_8px_18px_-10px_rgba(14,17,22,0.35)] transition-[transform,width] duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
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
                  "ml-0.5 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-muted px-1.5 text-[10px] font-semibold leading-none text-muted-foreground transition-colors group-data-[state=active]:bg-primary/10 group-data-[state=active]:text-primary",
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
    </div>
  );
}
