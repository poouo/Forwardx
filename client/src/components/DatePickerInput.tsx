import { Button } from "@/components/ui/button";
import { useOverlayContainer } from "@/components/ui/overlay-root";
import { cn } from "@/lib/utils";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

function padDatePart(value: number) {
  return String(value).padStart(2, "0");
}

export function formatDateInputValue(value: unknown) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(String(value));
  const time = date.getTime();
  if (!Number.isFinite(time) || time <= 0) return "";
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
}

export function parseDateInputValue(value: string) {
  const text = String(value || "").trim();
  if (!text) return null;
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

function formatPickerLabel(value: string) {
  const date = parseDateInputValue(value);
  if (!date) return "";
  return `${date.getFullYear()}年${padDatePart(date.getMonth() + 1)}月${padDatePart(date.getDate())}日`;
}

function sameDateOnly(a: Date | null, b: Date) {
  return !!a && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const PANEL_WIDTH = 320;
const PANEL_HEIGHT = 360;

type DatePickerInputProps = {
  value: string;
  onChange: (value: string) => void;
  align?: "start" | "end";
  className?: string;
  placeholder?: string;
};

export default function DatePickerInput({
  value,
  onChange,
  align = "start",
  className,
  placeholder = "年/月/日",
}: DatePickerInputProps) {
  const selected = useMemo(() => parseDateInputValue(value), [value]);
  const selectedTime = selected?.getTime() ?? null;
  const [open, setOpen] = useState(false);
  const [viewDate, setViewDate] = useState(() => selected || new Date());
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});
  const [panelSide, setPanelSide] = useState<"top" | "bottom">("bottom");
  const overlayContainer = useOverlayContainer();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const updatePanelPosition = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect || typeof window === "undefined") return;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 640;
    const containerRect = triggerRef.current?.closest(".dialog-panel")?.getBoundingClientRect();
    const padding = 16;
    const gap = 8;
    const boundaryLeft = Math.max(padding, (containerRect?.left ?? 0) + padding);
    const boundaryRight = Math.min(viewportWidth - padding, (containerRect?.right ?? viewportWidth) - padding);
    const boundaryTop = padding;
    const boundaryBottom = viewportHeight - padding;
    const availableWidth = Math.max(288, boundaryRight - boundaryLeft);
    const width = Math.min(PANEL_WIDTH, availableWidth);
    const panelHeight = PANEL_HEIGHT;
    const spaceBelow = boundaryBottom - rect.bottom;
    const spaceAbove = rect.top - boundaryTop;
    const side = spaceBelow >= panelHeight || spaceBelow >= spaceAbove ? "bottom" : "top";
    const desiredTop = side === "bottom" ? rect.bottom + gap : rect.top - panelHeight - gap;
    const desiredLeft = align === "end" ? rect.right - width : rect.left;
    setPanelSide(side);
    setPanelStyle({
      top: Math.max(boundaryTop, Math.min(desiredTop, boundaryBottom - panelHeight)),
      left: Math.max(boundaryLeft, Math.min(desiredLeft, boundaryRight - width)),
      width,
      height: panelHeight,
      overflowY: "hidden",
    });
  };

  useEffect(() => {
    if (open) setViewDate(selected || new Date());
  }, [open, selectedTime, selected]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePanelPosition();
    const frame = window.requestAnimationFrame(updatePanelPosition);
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const handleReposition = () => updatePanelPosition();
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
    };
  }, [open, align, selectedTime]);

  const monthStart = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);
  const calendarOffset = (monthStart.getDay() + 6) % 7;
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(viewDate.getFullYear(), viewDate.getMonth(), index - calendarOffset + 1);
    return {
      date,
      inMonth: date.getMonth() === viewDate.getMonth(),
      isToday: sameDateOnly(new Date(), date),
      isSelected: sameDateOnly(selected, date),
    };
  });

  const commitDate = (date: Date) => {
    const next = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
    onChange(formatDateInputValue(next));
    setViewDate(next);
    setOpen(false);
  };

  const shiftMonth = (offset: number) => {
    setViewDate((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1));
  };

  const label = formatPickerLabel(value);
  const panelOrigin = panelSide === "top"
    ? align === "end" ? "origin-bottom-right" : "origin-bottom-left"
    : align === "end" ? "origin-top-right" : "origin-top-left";
  const panelClosedTranslate = panelSide === "top" ? "translate-y-1.5" : "-translate-y-1.5";
  const panel = (
    <div
      ref={panelRef}
      aria-hidden={!open}
      style={panelStyle}
      className={`fixed z-[70] overflow-hidden rounded-lg border border-border/80 bg-background shadow-[0_20px_60px_rgba(15,23,42,0.22)] ring-1 ring-black/5 transition-all duration-200 ease-out ${panelOrigin} ${open ? "pointer-events-auto translate-y-0 scale-100 opacity-100" : `pointer-events-none ${panelClosedTranslate} scale-[0.98] opacity-0`}`}
    >
      <div className="p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <button type="button" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" onClick={() => shiftMonth(-1)} aria-label="上个月">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="text-sm font-semibold">{viewDate.getFullYear()}年{padDatePart(viewDate.getMonth() + 1)}月</div>
          <button type="button" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" onClick={() => shiftMonth(1)} aria-label="下个月">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium text-muted-foreground">
          {["一", "二", "三", "四", "五", "六", "日"].map((day) => <div key={day} className="py-1">{day}</div>)}
        </div>
        <div className="mt-1 grid grid-cols-7 gap-1">
          {days.map((day) => (
            <button
              key={day.date.toISOString()}
              type="button"
              className={`h-8 rounded-md text-sm transition-colors ${day.isSelected ? "bg-primary text-primary-foreground shadow-sm" : day.inMonth ? "text-foreground hover:bg-primary/10" : "text-muted-foreground/55 hover:bg-muted/70"} ${day.isToday && !day.isSelected ? "ring-1 ring-primary/40" : ""}`}
              onClick={() => commitDate(day.date)}
            >
              {day.date.getDate()}
            </button>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button type="button" size="sm" variant="outline" className="h-8 border-input bg-background" onClick={() => commitDate(new Date())}>今天</Button>
          <Button type="button" size="sm" variant="outline" className="h-8 border-input bg-background text-muted-foreground" onClick={() => { onChange(""); setOpen(false); }}>清除</Button>
        </div>
      </div>
    </div>
  );

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        className="flex h-8 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-sm transition-colors hover:border-primary/40 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        onClick={() => {
          if (!open) updatePanelPosition();
          setOpen((next) => !next);
        }}
        aria-expanded={open}
      >
        <span className={label ? "truncate text-foreground" : "truncate text-muted-foreground"}>{label || placeholder}</span>
        <CalendarDays className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
      {overlayContainer ? createPortal(panel, overlayContainer) : panel}
    </div>
  );
}
