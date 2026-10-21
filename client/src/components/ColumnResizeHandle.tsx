import { useEffect, useRef, type PointerEvent } from "react";
import { t } from "@/i18n";
import type { TableColumn } from "@shared/tableLayout";

export default function ColumnResizeHandle({ column, onResize, onReset }: {
  column: TableColumn; onResize: (width: number) => void; onReset: () => void;
}) {
  const drag = useRef<{ table: HTMLTableElement; handle: HTMLSpanElement; startX: number; startWidth: number; renderedWidth: number; width: number; previous: string; pointer: number; initial: string } | null>(null);
  const variable = `--list-col-${column.id}`;
  const clamp = (width: number) => Math.max(column.min, Math.min(column.max, Math.round(width)));
  const cancel = () => {
    const current = drag.current;
    if (!current) return;
    current.table.style.setProperty(variable, current.initial);
    current.table.style.userSelect = current.previous;
    current.handle.setAttribute("aria-valuenow", String(current.startWidth));
    drag.current = null;
  };
  useEffect(() => cancel, [variable]);
  const start = (event: PointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0 || drag.current) return;
    const table = event.currentTarget.closest("table");
    if (!table) return;
    event.preventDefault(); event.stopPropagation();
    // The last column may be wider than its saved preference while filling the viewport.
    const renderedWidth = event.currentTarget.closest("th")?.getBoundingClientRect().width ?? column.width;
    drag.current = { table, handle: event.currentTarget, startX: event.clientX, startWidth: column.width, renderedWidth, width: column.width, previous: table.style.userSelect, pointer: event.pointerId, initial: table.style.getPropertyValue(variable) };
    table.style.userSelect = "none";
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  return <span role="separator" tabIndex={0} aria-orientation="vertical" aria-label={t("调整{0}列宽", [t(column.label)])}
    aria-valuemin={column.min} aria-valuemax={column.max} aria-valuenow={column.width}
    title={t("拖动调整列宽，双击恢复默认")}
    className="absolute inset-y-0 right-0 z-10 flex w-2.5 touch-none cursor-col-resize items-center justify-center rounded-sm hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
    onPointerDown={start}
    onPointerMove={event => {
      const current = drag.current;
      if (!current || current.pointer !== event.pointerId) return;
      current.width = clamp(current.renderedWidth + event.clientX - current.startX);
      // Update CSS only while dragging. Do not rerender the list or save on every move.
      current.table.style.setProperty(variable, `${current.width}px`);
      event.currentTarget.setAttribute("aria-valuenow", String(current.width));
    }}
    onPointerUp={event => {
      const current = drag.current;
      if (!current || current.pointer !== event.pointerId) return;
      drag.current = null;
      current.table.style.userSelect = current.previous;
      event.currentTarget.releasePointerCapture(event.pointerId);
      onResize(current.width);
    }}
    onPointerCancel={cancel} onLostPointerCapture={cancel}
    onDoubleClick={onReset}
    onKeyDown={event => {
      if (event.key === "Home") { event.preventDefault(); onReset(); }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const renderedWidth = event.currentTarget.closest("th")?.getBoundingClientRect().width ?? column.width;
        event.preventDefault(); onResize(clamp(renderedWidth + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 32 : 8)));
      }
    }}><span aria-hidden="true" className="h-4 w-px bg-border" /></span>;
}
