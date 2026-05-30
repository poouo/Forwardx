import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowDown, GripVertical, Trash2 } from "lucide-react";

interface Host {
  id: number;
  name: string;
}

interface HopEntry {
  hostId: number;
  hostName: string;
  connectHost: string;
}

interface MultiHopEditorProps {
  hosts: Host[];
  initialHopIds?: number[];
  initialHopConnectHosts?: Array<string | null>;
  onChange?: (hopHostIds: number[]) => void;
  onConnectHostsChange?: (hopConnectHosts: Array<string | null>) => void;
}

const ROLE_COLORS: Record<string, string> = {
  first: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600",
  mid: "border-amber-500/40 bg-amber-500/10 text-amber-600",
  last: "border-blue-500/40 bg-blue-500/10 text-blue-600",
};

export default function MultiHopEditor({
  hosts,
  initialHopIds,
  initialHopConnectHosts,
  onChange,
  onConnectHostsChange,
}: MultiHopEditorProps) {
  const hostById = useMemo(() => new Map(hosts.map((host) => [host.id, host])), [hosts]);
  const [hops, setHops] = useState<HopEntry[]>(() => {
    if (!initialHopIds?.length) return [];
    return initialHopIds
      .map((id, idx) => {
        const host = hostById.get(id);
        if (!host) return null;
        return {
          hostId: host.id,
          hostName: host.name,
          connectHost: String(initialHopConnectHosts?.[idx] || ""),
        };
      })
      .filter(Boolean) as HopEntry[];
  });
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; name: string } | null>(null);
  const prevRef = useRef<string>("");
  const emptyDragImageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    const currentIds = JSON.stringify(hops.map((hop) => hop.hostId));
    const nextIds = JSON.stringify(initialHopIds || []);
    if (!initialHopIds) return;
    if (currentIds === nextIds) return;
    const restored = initialHopIds
      .map((id, idx) => {
        const host = hostById.get(id);
        if (!host) return null;
        return {
          hostId: host.id,
          hostName: host.name,
          connectHost: String(initialHopConnectHosts?.[idx] || ""),
        };
      })
      .filter(Boolean) as HopEntry[];
    setHops(restored);
  }, [hostById, initialHopIds, initialHopConnectHosts, hops]);

  useEffect(() => {
    const ids = hops.map((hop) => hop.hostId);
    const next = JSON.stringify(ids);
    if (next === prevRef.current) return;
    prevRef.current = next;
    onChange?.(ids);
  }, [hops, onChange]);

  useEffect(() => {
    onConnectHostsChange?.(hops.map((hop, idx) => (idx === 0 ? null : (hop.connectHost.trim() || null))));
  }, [hops, onConnectHostsChange]);

  const selectedIds = new Set(hops.map((hop) => hop.hostId));
  const availableHosts = hosts.filter((host) => !selectedIds.has(host.id));

  const addHop = (hostId: string) => {
    const id = Number(hostId);
    if (!id || selectedIds.has(id)) return;
    const host = hostById.get(id);
    if (!host) return;
    setHops((prev) => [...prev, { hostId: host.id, hostName: host.name, connectHost: "" }]);
  };

  const removeHop = (idx: number) => {
    setHops((prev) => prev.filter((_, i) => i !== idx));
  };

  const moveHop = (fromIdx: number, toIdx: number) => {
    if (toIdx < 0 || toIdx >= hops.length || fromIdx === toIdx) return;
    setHops((prev) => {
      const next = [...prev];
      const [item] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, item);
      return next;
    });
  };

  const updateConnectHost = (idx: number, value: string) => {
    setHops((prev) => prev.map((hop, i) => (i === idx ? { ...hop, connectHost: value } : hop)));
  };

  const onDragStart = (idx: number) => (e: React.DragEvent) => {
    if (!emptyDragImageRef.current) {
      const img = new Image();
      img.src = "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=";
      emptyDragImageRef.current = img;
    }
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setDragImage(emptyDragImageRef.current, 0, 0);
    setDraggingIdx(idx);
    setGhost({ x: e.clientX, y: e.clientY, name: hops[idx]?.hostName || "" });
  };

  const onDragOverRow = (idx: number) => (e: React.DragEvent) => {
    e.preventDefault();
    setGhost((prev) => (prev ? { ...prev, x: e.clientX, y: e.clientY } : prev));
    if (draggingIdx === null || draggingIdx === idx) return;
    moveHop(draggingIdx, idx);
    setDraggingIdx(idx);
  };

  const onDragOverContainer = (e: React.DragEvent) => {
    if (draggingIdx === null) return;
    e.preventDefault();
    setGhost((prev) => (prev ? { ...prev, x: e.clientX, y: e.clientY } : prev));
  };

  const onDragEnd = () => {
    setDraggingIdx(null);
    setGhost(null);
  };

  return (
    <div className="space-y-3" onDragOver={onDragOverContainer}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">主机链路</span>
        <span className="text-xs text-muted-foreground">上到下为链路顺序，可拖动调整</span>
      </div>

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
          <span className="whitespace-nowrap text-xs text-muted-foreground">{hops.length} 台主机</span>
        )}
      </div>

      {hops.length === 0 ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed border-border py-8 text-sm text-muted-foreground">
          从上方选择主机来创建链路
        </div>
      ) : (
        <div className="space-y-2 rounded-lg border border-border bg-card p-2">
          {hops.map((hop, idx) => {
            const isFirst = idx === 0;
            const isLast = idx === hops.length - 1;
            const role = isFirst ? "入口" : isLast ? "出口" : "中转";
            const roleColor = isFirst ? "first" : isLast ? "last" : "mid";
            const isDragging = draggingIdx === idx;
            return (
              <div key={`${hop.hostId}-${idx}`} className="space-y-2">
                <div
                  className={`flex items-center gap-2 rounded-md border border-border/50 bg-background px-3 py-2 transition-all duration-150 ${
                    isDragging ? "opacity-40 scale-[0.98]" : "opacity-100"
                  }`}
                  draggable
                  onDragStart={onDragStart(idx)}
                  onDragOver={onDragOverRow(idx)}
                  onDragEnd={onDragEnd}
                >
                  <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing" />
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
                    {idx + 1}
                  </span>
                  <span className="flex-1 truncate text-sm font-medium">{hop.hostName}</span>
                  <Badge variant="outline" className={`shrink-0 px-1.5 py-0 text-[10px] ${ROLE_COLORS[roleColor]}`}>
                    {role}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    disabled={isFirst}
                    onClick={() => moveHop(idx, idx - 1)}
                    title="上移"
                  >
                    <ArrowDown className="h-3 w-3 rotate-180" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    disabled={isLast}
                    onClick={() => moveHop(idx, idx + 1)}
                    title="下移"
                  >
                    <ArrowDown className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => removeHop(idx)}
                    title="移除"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {!isFirst && (
                  <div className="rounded-md border border-border/50 bg-muted/20 px-2 py-2">
                    <p className="mb-1 text-xs text-muted-foreground">指定该跳入口 IP/域名（可填内网地址）</p>
                    <Input
                      value={hop.connectHost}
                      onChange={(e) => updateConnectHost(idx, e.target.value)}
                      placeholder="留空则使用主机默认入口地址"
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {ghost && (
        <div
          className="pointer-events-none fixed z-[120] -translate-x-1/2 -translate-y-1/2 rounded-md border border-primary/30 bg-card px-3 py-2 text-sm font-medium shadow-lg shadow-primary/20"
          style={{ left: `${ghost.x}px`, top: `${ghost.y}px` }}
        >
          {ghost.name}
        </div>
      )}
    </div>
  );
}
