import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, GripVertical, ArrowDown } from "lucide-react";

interface Host {
  id: number;
  name: string;
}

interface HopEntry {
  hostId: number;
  hostName: string;
}

interface MultiHopEditorProps {
  hosts: Host[];
  initialHopIds?: number[];
  onChange?: (hopHostIds: number[]) => void;
}

const ROLE_LABELS: Record<number, string> = { 0: "入口", "-1": "出口" };
const ROLE_COLORS: Record<string, string> = {
  first: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600",
  mid: "border-amber-500/40 bg-amber-500/10 text-amber-600",
  last: "border-blue-500/40 bg-blue-500/10 text-blue-600",
};

export default function MultiHopEditor({ hosts, initialHopIds, onChange }: MultiHopEditorProps) {
  const [hops, setHops] = useState<HopEntry[]>(() => {
    if (!initialHopIds?.length) return [];
    return initialHopIds
      .map((id) => hosts.find((h) => h.id === id))
      .filter(Boolean)
      .map((h) => ({ hostId: h!.id, hostName: h!.name }));
  });

  const prevRef = useRef<string>("");
  const hostById = new Map(hosts.map((h) => [h.id, h]));

  // Sync initialHopIds when editing existing tunnel
  useEffect(() => {
    const json = JSON.stringify(initialHopIds || []);
    const currentJson = JSON.stringify(hops.map((h) => h.hostId));
    if (json !== prevRef.current && initialHopIds?.length && currentJson !== json) {
      prevRef.current = json;
      const restored = initialHopIds
        .map((id) => hosts.find((h) => h.id === id))
        .filter(Boolean)
        .map((h) => ({ hostId: h!.id, hostName: h!.name }));
      setHops(restored);
    }
  }, [initialHopIds, hosts, hops]);

  // Notify parent of changes
  useEffect(() => {
    const ids = hops.map((h) => h.hostId);
    const json = JSON.stringify(ids);
    if (json !== prevRef.current && ids.length > 0) {
      prevRef.current = json;
      onChange?.(ids);
    }
  }, [hops, onChange]);

  const selectedIds = new Set(hops.map((h) => h.hostId));
  const availableHosts = hosts.filter((h) => !selectedIds.has(h.id));

  const addHop = (hostId: string) => {
    const id = Number(hostId);
    if (!id || selectedIds.has(id)) return;
    const host = hostById.get(id);
    if (!host) return;
    setHops((prev) => [...prev, { hostId: host.id, hostName: host.name }]);
  };

  const removeHop = (idx: number) => {
    setHops((prev) => prev.filter((_, i) => i !== idx));
  };

  const moveHop = (fromIdx: number, toIdx: number) => {
    if (toIdx < 0 || toIdx >= hops.length) return;
    setHops((prev) => {
      const next = [...prev];
      const [item] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, item);
      return next;
    });
  };

  // HTML5 drag-and-drop handlers
  const dragIdxRef = useRef<number>(-1);
  const onDragStart = (idx: number) => (e: React.DragEvent) => {
    dragIdxRef.current = idx;
    e.dataTransfer.effectAllowed = "move";
  };
  const onDragOver = (idx: number) => (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  const onDrop = (idx: number) => () => {
    const from = dragIdxRef.current;
    if (from >= 0 && from !== idx) moveHop(from, idx);
    dragIdxRef.current = -1;
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">多级隧道链路</span>
        <span className="text-xs text-muted-foreground">上到下依次为 入口 → 中转 → 出口</span>
      </div>

      {/* Add host selector */}
      <div className="flex items-center gap-2">
        <Select value="" onValueChange={addHop}>
          <SelectTrigger className="h-9 text-sm">
            <SelectValue placeholder="添加主机到链路..." />
          </SelectTrigger>
          <SelectContent>
            {availableHosts.length === 0 && (
              <div className="px-2 py-4 text-center text-xs text-muted-foreground">已全部添加</div>
            )}
            {availableHosts.map((host) => (
              <SelectItem key={host.id} value={String(host.id)}>
                {host.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hops.length > 0 && (
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {hops.length} 台主机
          </span>
        )}
      </div>

      {/* Hop list with drag-to-reorder */}
      {hops.length === 0 ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed border-border py-8 text-sm text-muted-foreground">
          从上方下拉框添加主机到链路
        </div>
      ) : (
        <div className="space-y-1 rounded-lg border border-border bg-card p-2">
          {hops.map((hop, i) => {
            const isFirst = i === 0;
            const isLast = i === hops.length - 1;
            const role = isFirst ? "入口" : isLast ? "出口" : "中转";
            const roleColor = isFirst ? "first" : isLast ? "last" : "mid";

            return (
              <div
                key={`${hop.hostId}-${i}`}
                className="flex items-center gap-2 rounded-md border border-border/50 bg-background px-3 py-2 transition-colors hover:border-border"
                draggable
                onDragStart={onDragStart(i)}
                onDragOver={onDragOver(i)}
                onDrop={onDrop(i)}
              >
                {/* Drag handle */}
                <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing" />

                {/* Sequence badge */}
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
                  {i + 1}
                </span>

                {/* Host name */}
                <span className="flex-1 truncate text-sm font-medium">{hop.hostName}</span>

                {/* Role badge */}
                <Badge variant="outline" className={`text-[10px] px-1.5 py-0 shrink-0 ${ROLE_COLORS[roleColor]}`}>
                  {role}
                </Badge>

                {/* Move up */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  disabled={isFirst}
                  onClick={() => moveHop(i, i - 1)}
                  title="上移"
                >
                  <ArrowDown className="h-3 w-3 rotate-180" />
                </Button>

                {/* Move down */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  disabled={isLast}
                  onClick={() => moveHop(i, i + 1)}
                  title="下移"
                >
                  <ArrowDown className="h-3 w-3" />
                </Button>

                {/* Delete */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => removeHop(i)}
                  title="移除"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
