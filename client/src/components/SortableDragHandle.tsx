import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type CollisionDetection,
  type Modifier,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  type SortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";
import { cn } from "@/lib/utils";

export type SortableId = string | number;

type SortableHandleProps = HTMLAttributes<HTMLElement> & {
  disabled?: boolean;
  ref?: Ref<HTMLElement>;
};

const sortableMeasuring = {
  droppable: {
    strategy: MeasuringStrategy.Always,
  },
};

function sortableKey(id: SortableId | UniqueIdentifier | null | undefined) {
  return id === null || id === undefined ? "" : String(id);
}

/**
 * Keeps one array reference for as long as the ids themselves do not change.
 *
 * `SortableContext` memoizes its item list by reference, and `useSortable`
 * detects reordering with an identity check (`items !== previous.items`). A
 * freshly built array on every render therefore reads as "the list changed",
 * which makes dnd-kit drop to a zero-duration transition and skip the displace
 * transforms — the neighbouring cards jump instead of sliding out of the way.
 * Background polling re-renders these pages mid-drag, so the jump appeared at
 * random. Comparing by content keeps the reference stable across those renders.
 */
function useStableSortableIds(ids: Array<SortableId | UniqueIdentifier | null | undefined>) {
  const stableRef = useRef<string[]>([]);
  const next = ids.map((id) => sortableKey(id)).filter(Boolean);
  const previous = stableRef.current;
  if (previous.length === next.length && previous.every((id, index) => id === next[index])) {
    return previous;
  }
  stableRef.current = next;
  return next;
}

/**
 * Keeps a completed drop visible while its server order is saved and refetched.
 * The override only applies to the exact same item set, so stale page or filter
 * data can never leak into a newly selected scope.
 */
export function useOptimisticSortableOrder<T>({
  items,
  getId,
}: {
  items: T[];
  getId: (item: T) => SortableId;
}) {
  const [order, setOrder] = useState<string[] | null>(null);
  const requestIdRef = useRef(0);

  const orderedItems = useMemo(() => {
    if (!order) return items;
    const byId = new Map<string, T>();
    for (const item of items) {
      const key = sortableKey(getId(item));
      if (!key || byId.has(key)) return items;
      byId.set(key, item);
    }
    if (order.length !== byId.size || order.some((key) => !byId.has(key))) return items;
    return order.map((key) => byId.get(key) as T);
  }, [getId, items, order]);

  const begin = useCallback((nextItems: T[]) => {
    requestIdRef.current += 1;
    setOrder(nextItems.map((item) => sortableKey(getId(item))));
    return requestIdRef.current;
  }, [getId]);

  const release = useCallback((requestId: number) => {
    if (requestIdRef.current !== requestId) return;
    setOrder(null);
  }, []);

  const resync = useCallback((requestId: number, refresh: () => Promise<unknown> | unknown) => {
    void (async () => {
      try {
        await refresh();
        // Query consumers may copy fresh data into stable view state from an
        // effect. Let that state commit before removing the visual override.
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
      } catch {
        // Keep mutation errors in the page-level toast; a failed refresh should
        // still release the temporary order and leave the cached list usable.
      } finally {
        release(requestId);
      }
    })();
  }, [release]);

  return { begin, items: orderedItems, release, resync };
}

export function useSortableReorder<T>({
  items,
  getId,
  onReorder,
  disabled = false,
}: {
  items: T[];
  getId: (item: T) => SortableId;
  onReorder: (items: T[]) => void;
  disabled?: boolean;
}) {
  const [activeId, setActiveId] = useState<SortableId | null>(null);
  const [overId, setOverId] = useState<SortableId | null>(null);
  const itemsRef = useRef(items);
  const activeKeyRef = useRef<string | null>(null);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const ids = useStableSortableIds(items.map((item) => getId(item)));

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const clear = useCallback(() => {
    activeKeyRef.current = null;
    setActiveId(null);
    setOverId(null);
  }, []);

  useEffect(() => {
    if (disabled && activeId) clear();
  }, [activeId, clear, disabled]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const key = sortableKey(event.active.id);
    itemsRef.current = items;
    activeKeyRef.current = key;
    setActiveId(key);
    setOverId(key);
  }, [items]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    setOverId(sortableKey(event.over?.id));
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const activeKey = sortableKey(event.active.id);
    const overKey = sortableKey(event.over?.id);
    const currentItems = itemsRef.current;
    clear();
    if (disabled || !activeKey) return;

    if (!overKey || activeKey === overKey) return;
    const oldIndex = currentItems.findIndex((item) => sortableKey(getId(item)) === activeKey);
    const newIndex = currentItems.findIndex((item) => sortableKey(getId(item)) === overKey);
    if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;
    onReorder(arrayMove(currentItems, oldIndex, newIndex));
  }, [clear, disabled, getId, onReorder]);

  const handleDragCancel = useCallback(() => {
    clear();
  }, [clear]);

  const getItemState = useCallback((item: T) => {
    const key = sortableKey(getId(item));
    return {
      isDragging: key === sortableKey(activeId),
      isDropTarget: !!activeId && key === sortableKey(overId) && key !== sortableKey(activeId),
    };
  }, [activeId, getId, overId]);

  return {
    activeId,
    disabled,
    handleDragCancel,
    handleDragEnd,
    handleDragOver,
    handleDragStart,
    ids,
    sensors,
    getItemState,
  };
}

export function SortableReorderContext<T>({
  sortable,
  children,
  ids,
  strategy = "rect",
  restrictToList = false,
}: {
  sortable: ReturnType<typeof useSortableReorder<T>>;
  children: ReactNode;
  ids?: SortableId[];
  strategy?: "rect" | "vertical" | SortingStrategy;
  restrictToList?: boolean;
}) {
  const sortingStrategy = strategy === "rect"
    ? rectSortingStrategy
    : strategy === "vertical"
      ? verticalListSortingStrategy
      : strategy;
  const collisionDetection: CollisionDetection = useCallback((args) => {
    const pointerCollisions = pointerWithin(args);
    return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(args);
  }, []);
  // Callers build this array inline on every render, so stabilize it before it
  // reaches SortableContext's reference-based change detection.
  const stableIds = useStableSortableIds(ids ?? []);
  const sortableItems = ids ? stableIds : sortable.ids;

  return (
    <DndContext
      sensors={sortable.sensors}
      collisionDetection={collisionDetection}
      modifiers={restrictToList ? sortableListModifiers : sortableBoundedModifiers}
      measuring={sortableMeasuring}
      autoScroll={false}
      onDragStart={sortable.handleDragStart}
      onDragOver={sortable.handleDragOver}
      onDragEnd={sortable.handleDragEnd}
      onDragCancel={sortable.handleDragCancel}
    >
      <SortableContext items={sortableItems} strategy={sortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

const restrictToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});

const restrictToContainerBounds: Modifier = ({ activeNodeRect, containerNodeRect, transform, windowRect }) => {
  const bounds = containerNodeRect || windowRect;
  if (!activeNodeRect || !bounds) return transform;
  const minX = bounds.left - activeNodeRect.left;
  const maxX = bounds.right - activeNodeRect.right;
  const minY = bounds.top - activeNodeRect.top;
  const maxY = bounds.bottom - activeNodeRect.bottom;
  if (minX > maxX || minY > maxY) return { ...transform, x: 0, y: 0 };
  return {
    ...transform,
    x: Math.min(Math.max(transform.x, minX), maxX),
    y: Math.min(Math.max(transform.y, minY), maxY),
  };
};

const sortableBoundedModifiers: Modifier[] = [
  restrictToContainerBounds,
];

const sortableListModifiers: Modifier[] = [
  restrictToVerticalAxis,
  restrictToContainerBounds,
];

export function SortableItem({
  id,
  disabled,
  itemKind = "block",
  children,
}: {
  id: SortableId;
  disabled?: boolean;
  itemKind?: "block" | "row";
  children: (state: {
    itemProps: HTMLAttributes<HTMLElement> & {
      ref: Ref<any>;
      style: CSSProperties;
    };
    handleProps: SortableHandleProps;
    isDragging: boolean;
    isDropTarget: boolean;
  }) => ReactNode;
}) {
  const {
    attributes,
    isDragging,
    isOver,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    id: sortableKey(id),
    disabled,
  });

  const style: CSSProperties = {
    transform: transform ? CSS.Translate.toString(transform) : undefined,
    transition: isDragging ? "none" : transition,
    zIndex: isDragging ? 20 : undefined,
    position: isDragging ? "relative" : undefined,
    display: itemKind === "row" ? "table-row" : undefined,
    willChange: "transform",
  };

  return (
    <>
      {children({
        itemProps: {
          ref: setNodeRef as Ref<any>,
          style,
        },
        handleProps: {
          ...attributes,
          ...listeners,
          ref: setActivatorNodeRef as Ref<HTMLElement>,
          disabled,
          style: { touchAction: "none" },
        },
        isDragging,
        isDropTarget: isOver && !isDragging,
      })}
    </>
  );
}

export function SortableDragHandle({
  dragHandleProps,
  visible,
  busy,
  className,
}: {
  dragHandleProps: SortableHandleProps;
  visible?: boolean;
  /**
   * Sorting is temporarily blocked while the previous order is being saved.
   * The handle stays where it is instead of collapsing to `opacity-0`, because
   * the pointer is still resting on it right after a drop.
   */
  busy?: boolean;
  className?: string;
}) {
  const { ref, disabled, style, ...props } = dragHandleProps;
  const unavailable = !!disabled && !busy;
  return (
    <button
      ref={ref as Ref<HTMLButtonElement>}
      type="button"
      aria-label="拖动排序"
      title={busy ? "正在保存排序" : disabled ? "至少需要两个项目才能排序" : "拖动排序"}
      disabled={disabled}
      {...props}
      className={cn(
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-all duration-200",
        "opacity-40 hover:opacity-100 focus-visible:opacity-100 sm:opacity-0 sm:group-hover/sortable:opacity-100",
        visible && "pointer-events-auto opacity-100",
        unavailable ? "pointer-events-none cursor-default opacity-0" : "cursor-grab hover:bg-muted/70 hover:text-foreground active:scale-95 active:cursor-grabbing",
        busy && "cursor-progress",
        className,
      )}
      style={style}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <GripVertical className="h-4 w-4" />
    </button>
  );
}
