import * as Popover from "@radix-ui/react-popover";
import { Columns3, LockKeyhole, RotateCcw } from "lucide-react";
import { t } from "@/i18n";
import { Button } from "./ui/button";
import { useOverlayContainer } from "./ui/overlay-root";
import { SortableDragHandle, SortableItem, SortableReorderContext, useSortableReorder } from "./SortableDragHandle";
import type { TableColumn, TableLayout } from "@shared/tableLayout";

type ListSettingsProps<Id extends string> = {
  columns: TableColumn<Id>[]; layout: TableLayout<Id>; onChange: (layout: TableLayout<Id>) => void; onReset: () => void;
};

export function ListSettingsContent<Id extends string>({ columns, layout, onChange, onReset }: ListSettingsProps<Id>) {
  const sortable = useSortableReorder({ items: columns, getId: column => column.id, onReorder: next => {
    // Keep admin-only columns in the stored layout without exposing them to users.
    const reordered = [...next];
    onChange({ ...layout, order: layout.order.map(id => columns.some(column => column.id === id) ? reordered.shift()!.id : id) });
  } });
  return <>
    <div className="shrink-0 px-1 pb-2"><h3 className="text-sm font-semibold">{t("列表设置")}</h3></div>
    <SortableReorderContext sortable={sortable} strategy="vertical" restrictToList>
      <div data-list-settings-options="" className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain">
        {columns.map(column => <SortableItem key={column.id} id={column.id}>{({ itemProps, handleProps }) => <div {...itemProps} className="group/sortable flex min-w-0 items-center gap-1 rounded-md px-1 py-1 hover:bg-muted/50">
          <SortableDragHandle dragHandleProps={handleProps} visible className="h-7 w-6" />
          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" className="h-3.5 w-3.5 shrink-0 accent-primary" checked={!layout.hidden.includes(column.id)} disabled={column.required} onChange={event => onChange({ ...layout, hidden: event.target.checked ? layout.hidden.filter(id => id !== column.id) : [...layout.hidden, column.id] })} />
            <span className="truncate">{t(column.label)}</span>
            {column.required && <LockKeyhole className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={t("此列必须保留")} />}
          </label>
        </div>}</SortableItem>)}
      </div>
    </SortableReorderContext>
    <div className="mt-2 shrink-0 border-t pt-2"><Button type="button" variant="ghost" size="sm" className="w-full gap-2" onClick={onReset}><RotateCcw className="h-3.5 w-3.5" />{t("恢复默认")}</Button></div>
  </>;
}

export default function ListSettings<Id extends string>(props: ListSettingsProps<Id>) {
  const container = useOverlayContainer();
  return <Popover.Root>
    <Popover.Trigger asChild><button type="button" aria-label={t("列表设置")} title={t("列表设置")} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-primary/10 data-[state=open]:text-primary"><Columns3 className="h-3.5 w-3.5" aria-hidden="true" /></button></Popover.Trigger>
    <Popover.Portal container={container}><Popover.Content align="start" sideOffset={8} collisionPadding={12} aria-label={t("列表设置")} className="action-menu-content z-50 flex max-h-[min(36rem,var(--radix-popover-content-available-height,calc(100dvh-1.5rem)))] w-56 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl border p-3 text-popover-foreground shadow-xl">
      <ListSettingsContent {...props} />
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
