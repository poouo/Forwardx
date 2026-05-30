import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowDown, GripVertical, Server, Trash2 } from "lucide-react";

interface Host {
  id: number;
  name: string;
  ip?: string | null;
  ipv4?: string | null;
  ipv6?: string | null;
  entryIp?: string | null;
  tunnelEntryIp?: string | null;
}

interface HopEntry {
  hostId: number;
  hostName: string;
  useTunnelEntryIp: boolean;
}

type HopRole = "entry" | "mid" | "exit";

interface MultiHopEditorProps {
  hosts: Host[];
  initialHopIds?: number[];
  initialHopConnectHosts?: Array<string | null>;
  maxHops?: number;
  onChange?: (hopHostIds: number[]) => void;
  onConnectHostsChange?: (hopConnectHosts: Array<string | null>) => void;
}

const ROLE_COLORS: Record<HopRole, string> = {
  entry: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600",
  mid: "border-amber-500/40 bg-amber-500/10 text-amber-600",
  exit: "border-blue-500/40 bg-blue-500/10 text-blue-600",
};

const ROLE_LABELS: Record<HopRole, string> = {
  entry: "入口",
  mid: "中转",
  exit: "出口",
};

function reorder<T>(arr: T[], fromIdx: number, toIdx: number): T[] {
  if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0 || fromIdx >= arr.length || toIdx >= arr.length) {
    return arr;
  }
  const next = [...arr];
  const [moved] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, moved);
  return next;
}

export default function MultiHopEditor({
  hosts,
  initialHopIds,
  initialHopConnectHosts,
  maxHops = 5,
  onChange,
  onConnectHostsChange,
}: MultiHopEditorProps) {
  const hostById = useMemo(() => new Map(hosts.map((host) => [host.id, host])), [hosts]);
  const [hops, setHops] = useState<HopEntry[]>([]);
  const [dragSourceIdx, setDragSourceIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; name: string; role: HopRole; index: number } | null>(null);

  const prevIdsRef = useRef<string>("");
  const prevConnectRef = useRef<string>("");
  const onChangeRef = useRef<typeof onChange>(onChange);
  const onConnectHostsChangeRef = useRef<typeof onConnectHostsChange>(onConnectHostsChange);
  const syncingFromPropsRef = useRef(false);
  const emptyDragImageRef = useRef<HTMLImageElement | null>(null);

  const getRole = (idx: number, total: number): HopRole => {
    if (idx === 0) return "entry";
    if (idx === total - 1) return "exit";
    return "mid";
  };

  const serializeIds = (list: HopEntry[]) => JSON.stringify(list.map((hop) => hop.hostId));
  const serializeConnectHosts = (list: HopEntry[]) => JSON.stringify(
    list.map((hop, idx) => {
      if (idx === 0) return null;
      const host = hostById.get(hop.hostId);
      const publicAddr = String(host?.entryIp || host?.ipv4 || host?.ipv6 || host?.ip || "").trim();
      const privateAddr = String(host?.tunnelEntryIp || "").trim();
      return hop.useTunnelEntryIp ? (privateAddr || publicAddr || null) : (publicAddr || null);
    }),
  );

  const buildHopsFromProps = () => {
    if (!initialHopIds?.length) return [] as HopEntry[];
    return initialHopIds
      .map((id, idx) => {
        const host = hostById.get(id);
        if (!host) return null;
        return {
          hostId: host.id,
          hostName: host.name,
          useTunnelEntryIp: (() => {
            if (idx === 0) return false;
            const initialConnectHost = String(initialHopConnectHosts?.[idx] || "").trim();
            const tunnelEntryIp = String(host.tunnelEntryIp || "").trim();
            return !!initialConnectHost && !!tunnelEntryIp && initialConnectHost === tunnelEntryIp;
          })(),
        };
      })
      .filter(Boolean) as HopEntry[];
  };

  const clearDragState = () => {
    setDragSourceIdx(null);
    setDragOverIdx(null);
    setGhost(null);
  };

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onConnectHostsChangeRef.current = onConnectHostsChange;
  }, [onConnectHostsChange]);

  useEffect(() => {
    const restored = buildHopsFromProps();
    setHops((prev) => {
      if (serializeIds(prev) === serializeIds(restored) && serializeConnectHosts(prev) === serializeConnectHosts(restored)) {
        return prev;
      }
      syncingFromPropsRef.current = true;
      return restored;
    });
  }, [hostById, initialHopIds, initialHopConnectHosts]);

  useEffect(() => {
    if (dragSourceIdx !== null) return;
    if (syncingFromPropsRef.current) {
      syncingFromPropsRef.current = false;
      prevIdsRef.current = serializeIds(hops);
      prevConnectRef.current = serializeConnectHosts(hops);
      return;
    }

    const ids = hops.map((hop) => hop.hostId);
    const idsText = JSON.stringify(ids);
    if (idsText !== prevIdsRef.current) {
      prevIdsRef.current = idsText;
      onChangeRef.current?.(ids);
    }

    const connectHosts = hops.map((hop, idx) => {
      if (idx === 0) return null;
      const host = hostById.get(hop.hostId);
      const publicAddr = String(host?.entryIp || host?.ipv4 || host?.ipv6 || host?.ip || "").trim();
      const privateAddr = String(host?.tunnelEntryIp || "").trim();
      return hop.useTunnelEntryIp ? (privateAddr || publicAddr || null) : (publicAddr || null);
    });
    const connectText = JSON.stringify(connectHosts);
    if (connectText !== prevConnectRef.current) {
      prevConnectRef.current = connectText;
      onConnectHostsChangeRef.current?.(connectHosts);
    }
  }, [hops, dragSourceIdx]);

  useEffect(() => {
    const handleWindowDragEnd = () => clearDragState();
    window.addEventListener("dragend", handleWindowDragEnd);
    window.addEventListener("drop", handleWindowDragEnd);
    window.addEventListener("mouseup", handleWindowDragEnd);
    return () => {
      window.removeEventListener("dragend", handleWindowDragEnd);
      window.removeEventListener("drop", handleWindowDragEnd);
      window.removeEventListener("mouseup", handleWindowDragEnd);
    };
  }, []);

  const selectedIds = new Set(hops.map((hop) => hop.hostId));
  const reachedMaxHops = hops.length >= maxHops;
  const availableHosts = reachedMaxHops ? [] : hosts.filter((host) => !selectedIds.has(host.id));

  const addHop = (hostId: string) => {
    if (reachedMaxHops) return;
    const id = Number(hostId);
    if (!id || selectedIds.has(id)) return;
    const host = hostById.get(id);
    if (!host) return;
    setHops((prev) => [...prev, { hostId: host.id, hostName: host.name, useTunnelEntryIp: false }]);
  };

  const removeHop = (idx: number) => {
    setHops((prev) => prev.filter((_, i) => i !== idx));
    clearDragState();
  };

  const moveHop = (fromIdx: number, toIdx: number) => {
    setHops((prev) => reorder(prev, fromIdx, toIdx));
  };

  const updateUseTunnelEntryIp = (idx: number, enabled: boolean) => {
    setHops((prev) => prev.map((hop, i) => (i === idx ? { ...hop, useTunnelEntryIp: enabled } : hop)));
  };

  const onDragStart = (idx: number) => (e: React.DragEvent) => {
    if (!emptyDragImageRef.current) {
      const img = new Image();
      img.src = "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=";
      emptyDragImageRef.current = img;
    }
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(idx));
    e.dataTransfer.setDragImage(emptyDragImageRef.current, 0, 0);
    setDragSourceIdx(idx);
    setDragOverIdx(idx);
    setGhost({
      x: e.clientX,
      y: e.clientY,
      name: hops[idx]?.hostName || "",
      role: getRole(idx, hops.length),
      index: idx + 1,
    });
  };

  const onDragOverContainer = (e: React.DragEvent) => {
    if (dragSourceIdx === null) return;
    e.preventDefault();
    setGhost((prev) => (prev ? { ...prev, x: e.clientX, y: e.clientY } : prev));
  };

  const onDragEnterRow = (idx: number) => (e: React.DragEvent) => {
    if (dragSourceIdx === null) return;
    e.preventDefault();
    setDragOverIdx(idx);
    setGhost((prev) => (prev ? { ...prev, role: getRole(idx, hops.length), index: idx + 1 } : prev));
  };

  const onDropRow = (idx: number) => (e: React.DragEvent) => {
    e.preventDefault();
    if (dragSourceIdx === null) {
      clearDragState();
      return;
    }
    if (dragSourceIdx !== idx) {
      setHops((prev) => reorder(prev, dragSourceIdx, idx));
    }
    clearDragState();
  };

  const onDragEnd = () => clearDragState();

  return (
    <div className="space-y-3" onDragOver={onDragOverContainer} onDrop={(e) => e.preventDefault()}>
      <div className="flex items-center justify-end">
        <span className="text-xs text-muted-foreground">上到下为链路顺序，拖动时卡片会跟随鼠标移动</span>
      </div>

      <div className="flex items-center gap-2">
        <Select value="" onValueChange={addHop} disabled={reachedMaxHops}>
          <SelectTrigger className="h-9 text-sm">
            <SelectValue placeholder={reachedMaxHops ? `最多 ${maxHops} 级` : "添加主机到链路..."} />
          </SelectTrigger>
          <SelectContent>
            {reachedMaxHops ? (
              <div className="px-2 py-4 text-center text-xs text-muted-foreground">最多支持 {maxHops} 级隧道</div>
            ) : availableHosts.length === 0 && (
              <div className="px-2 py-4 text-center text-xs text-muted-foreground">已全部添加</div>
            )}
            {availableHosts.map((host) => (
              <SelectItem key={host.id} value={String(host.id)}>
                <span className="inline-flex items-center gap-2">
                  <Server className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>{host.name}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hops.length > 0 && (
          <span className="whitespace-nowrap text-xs text-muted-foreground">{hops.length} / {maxHops} 台主机</span>
        )}
      </div>

      {hops.length === 0 ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed border-border py-8 text-sm text-muted-foreground">
          从上方选择主机来创建链路
        </div>
      ) : (
        <div className="space-y-2 rounded-lg border border-border bg-card p-2">
          {hops.map((hop, idx) => {
            const role = getRole(idx, hops.length);
            const isFirst = role === "entry";
            const isLast = role === "exit";
            const isDragging = dragSourceIdx === idx;
            const isDropTarget = dragSourceIdx !== null && dragOverIdx === idx;
            return (
              <div
                key={hop.hostId}
                className={`flex items-center gap-2 rounded-md border border-border/50 bg-background px-3 py-2 transition-colors duration-150 ${
                  isDragging ? "opacity-55" : "opacity-100"
                } ${isDropTarget ? "ring-1 ring-primary/40" : ""}`}
                draggable
                onDragStart={onDragStart(idx)}
                onDragEnter={onDragEnterRow(idx)}
                onDragOver={(e) => {
                  e.preventDefault();
                  setGhost((prev) => (prev ? { ...prev, x: e.clientX, y: e.clientY } : prev));
                }}
                onDrop={onDropRow(idx)}
                onDragEnd={onDragEnd}
              >
                <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing" />
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
                  {idx + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{hop.hostName}</span>

                <div className="ml-2 flex h-8 w-[190px] shrink-0 items-center justify-end gap-2">
                  {!isFirst ? (
                    <>
                      <span className="whitespace-nowrap text-xs text-muted-foreground">使用内网IP</span>
                      <Switch
                        checked={hop.useTunnelEntryIp}
                        onCheckedChange={(checked) => updateUseTunnelEntryIp(idx, !!checked)}
                        aria-label={`为${hop.hostName}使用内网IP`}
                      />
                    </>
                  ) : (
                    <span className="invisible text-xs">占位</span>
                  )}
                </div>

                <Badge variant="outline" className={`shrink-0 px-1.5 py-0 text-[10px] ${ROLE_COLORS[role]}`}>
                  {ROLE_LABELS[role]}
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
            );
          })}
        </div>
      )}

      {ghost && (
        <div
          className="pointer-events-none fixed z-[120] -translate-x-1/2 -translate-y-1/2 rounded-md border border-primary/40 bg-card px-3 py-2 text-sm shadow-2xl transition-transform duration-75"
          style={{ left: `${ghost.x}px`, top: `${ghost.y}px` }}
        >
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
              {ghost.index}
            </span>
            <span className="max-w-[220px] truncate font-medium">{ghost.name}</span>
            <Badge variant="outline" className={`shrink-0 px-1.5 py-0 text-[10px] ${ROLE_COLORS[ghost.role]}`}>
              {ROLE_LABELS[ghost.role]}
            </Badge>
          </div>
        </div>
      )}
    </div>
  );
}
