import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import HostStatusLabel from "@/components/HostStatusLabel";
import { SortableDragHandle, SortableItem, SortableReorderContext, useSortableReorder } from "@/components/SortableDragHandle";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowDown, GripVertical, Trash2 } from "lucide-react";
import { segmentedControlClassName, segmentedOptionClassName } from "@/components/ui/segmented";
import type { TunnelRelayMode } from "@shared/tunnelRelay";

interface Host {
  id: number;
  name: string;
  isOnline?: boolean | null;
  lastHeartbeat?: Date | string | number | null;
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
  useIpv6: boolean;
}

type HopRole = "entry" | "mid" | "exit";

interface MultiHopEditorProps {
  hosts: Host[];
  headerLabel?: string;
  initialHopIds?: number[];
  initialHopConnectHosts?: Array<string | null>;
  maxHops?: number;
  onChange?: (hopHostIds: number[]) => void;
  onConnectHostsChange?: (hopConnectHosts: Array<string | null>) => void;
  fixedExitHostIds?: number[];
  excludedHostIds?: number[];
  externalEntry?: boolean;
  externalExit?: boolean;
  relayMode?: TunnelRelayMode;
  relayModeSupported?: boolean;
  onRelayModeChange?: (mode: TunnelRelayMode) => void;
}

const missingTunnelEntryIpTip = "请先配置内网IP";
const missingIpv6Tip = "该主机暂无IPv6";
const ROLE_COLORS: Record<HopRole, string> = {
  entry: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600",
  mid: "border-amber-500/40 bg-amber-500/10 text-amber-600",
  exit: "border-teal-500/35 bg-teal-500/10 text-teal-700",
};

const ROLE_LABELS: Record<HopRole, string> = {
  entry: "入口",
  mid: "中转",
  exit: "出口",
};

function addressKey(value: unknown) {
  const text = String(value || "").trim();
  const unwrapped = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1).trim() : text;
  return unwrapped.toLowerCase();
}

function sameAddress(a: unknown, b: unknown) {
  const left = addressKey(a);
  const right = addressKey(b);
  return !!left && !!right && left === right;
}

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
  headerLabel,
  initialHopIds,
  initialHopConnectHosts,
  maxHops = 5,
  onChange,
  onConnectHostsChange,
  fixedExitHostIds = [],
  excludedHostIds = [],
  externalEntry = false,
  externalExit = false,
  relayMode = "chain",
  relayModeSupported = false,
  onRelayModeChange,
}: MultiHopEditorProps) {
  const hostById = useMemo(() => new Map(hosts.map((host) => [host.id, host])), [hosts]);
  const [hops, setHops] = useState<HopEntry[]>([]);

  const prevIdsRef = useRef<string>("");
  const prevConnectRef = useRef<string>("");
  const onChangeRef = useRef<typeof onChange>(onChange);
  const onConnectHostsChangeRef = useRef<typeof onConnectHostsChange>(onConnectHostsChange);
  const syncingFromPropsRef = useRef(false);

  const getRole = (idx: number, total: number): HopRole => {
    if (externalEntry && externalExit) return "mid";
    if (externalEntry) return idx === total - 1 ? "exit" : "mid";
    if (externalExit) return idx === 0 ? "entry" : "mid";
    if (idx === 0) return "entry";
    if (idx === total - 1) return "exit";
    return "mid";
  };

  const serializeIds = (list: HopEntry[]) => JSON.stringify(list.map((hop) => hop.hostId));
  const serializeConnectHosts = (list: HopEntry[]) => JSON.stringify(
    list.map((hop, idx) => {
      if (idx === 0 && !externalEntry) return null;
      const host = hostById.get(hop.hostId);
      const privateAddr = String(host?.tunnelEntryIp || "").trim();
      const ipv6Addr = String(host?.ipv6 || "").trim();
      if (hop.useTunnelEntryIp && privateAddr) return privateAddr;
      if (hop.useIpv6 && ipv6Addr) return ipv6Addr;
      const publicAddr = String(host?.entryIp || host?.ipv4 || host?.ipv6 || host?.ip || "").trim();
      return publicAddr || null;
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
            if (idx === 0 && !externalEntry) return false;
            const initialConnectHost = String(initialHopConnectHosts?.[idx] || "").trim();
            const tunnelEntryIp = String(host.tunnelEntryIp || "").trim();
            return !!initialConnectHost && !!tunnelEntryIp && sameAddress(initialConnectHost, tunnelEntryIp);
          })(),
          useIpv6: (() => {
            if (idx === 0 && !externalEntry) return false;
            const initialConnectHost = String(initialHopConnectHosts?.[idx] || "").trim();
            const tunnelEntryIp = String(host.tunnelEntryIp || "").trim();
            const ipv6Addr = String(host.ipv6 || "").trim();
            return !!initialConnectHost && !!ipv6Addr && sameAddress(initialConnectHost, ipv6Addr) && !sameAddress(initialConnectHost, tunnelEntryIp);
          })(),
        };
      })
      .filter(Boolean) as HopEntry[];
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
  }, [hostById, initialHopIds, initialHopConnectHosts, externalEntry]);

  useEffect(() => {
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
      if (idx === 0 && !externalEntry) return null;
      const host = hostById.get(hop.hostId);
      const privateAddr = String(host?.tunnelEntryIp || "").trim();
      const ipv6Addr = String(host?.ipv6 || "").trim();
      if (hop.useTunnelEntryIp && privateAddr) return privateAddr;
      if (hop.useIpv6 && ipv6Addr) return ipv6Addr;
      const publicAddr = String(host?.entryIp || host?.ipv4 || host?.ipv6 || host?.ip || "").trim();
      return publicAddr || null;
    });
    const connectText = JSON.stringify(connectHosts);
    if (connectText !== prevConnectRef.current) {
      prevConnectRef.current = connectText;
      onConnectHostsChangeRef.current?.(connectHosts);
    }
  }, [hops]);

  const selectedIds = new Set(hops.map((hop) => hop.hostId));
  const fixedExitIds = useMemo(() => new Set(fixedExitHostIds.map((id) => Number(id || 0)).filter((id) => id > 0)), [fixedExitHostIds]);
  const excludedIds = useMemo(() => new Set(excludedHostIds.map((id) => Number(id || 0)).filter((id) => id > 0)), [excludedHostIds]);
  const movableHopCount = hops.filter((hop) => !fixedExitIds.has(hop.hostId)).length;
  const hopSortable = useSortableReorder({
    items: hops,
    getId: (hop) => hop.hostId,
    disabled: movableHopCount < 2,
    onReorder: (nextHops) => {
      const fixedPositionsChanged = hops.some((hop, index) => (
        fixedExitIds.has(hop.hostId) && nextHops[index]?.hostId !== hop.hostId
      ));
      if (!fixedPositionsChanged) setHops(nextHops);
    },
  });
  const reachedMaxHops = hops.length >= maxHops;
  const availableHosts = reachedMaxHops ? [] : hosts.filter((host) => !selectedIds.has(host.id) && !excludedIds.has(host.id));
  const relayCount = Math.max(0, hops.length - (externalEntry ? 0 : 1) - (externalExit ? 0 : 1));
  const showRelayMode = relayModeSupported && relayCount >= 2;

  useEffect(() => {
    if (!showRelayMode && relayMode === "failover") onRelayModeChange?.("chain");
  }, [onRelayModeChange, relayMode, showRelayMode]);

  useEffect(() => {
    if (excludedIds.size === 0) return;
    setHops((prev) => {
      const next = prev.filter((hop) => !excludedIds.has(hop.hostId));
      return next.length === prev.length ? prev : next;
    });
  }, [excludedIds]);

  const addHop = (hostId: string) => {
    if (reachedMaxHops) return;
    const id = Number(hostId);
    if (!id || selectedIds.has(id)) return;
    const host = hostById.get(id);
    if (!host) return;
    setHops((prev) => [...prev, { hostId: host.id, hostName: host.name, useTunnelEntryIp: false, useIpv6: false }]);
  };

  const removeHop = (idx: number) => {
    const hop = hops[idx];
    if (hop && fixedExitIds.has(hop.hostId)) return;
    setHops((prev) => prev.filter((_, i) => i !== idx));
  };

  const moveHop = (fromIdx: number, toIdx: number) => {
    const fromHop = hops[fromIdx];
    const toHop = hops[toIdx];
    if ((fromHop && fixedExitIds.has(fromHop.hostId)) || (toHop && fixedExitIds.has(toHop.hostId))) return;
    setHops((prev) => reorder(prev, fromIdx, toIdx));
  };

  const updateUseTunnelEntryIp = (idx: number, enabled: boolean) => {
    setHops((prev) => prev.map((hop, i) => {
      if (i !== idx) return hop;
      const host = hostById.get(hop.hostId);
      const privateAddr = String(host?.tunnelEntryIp || "").trim();
      return { ...hop, useTunnelEntryIp: !!enabled && !!privateAddr, useIpv6: enabled ? false : hop.useIpv6 };
    }));
  };

  const updateUseIpv6 = (idx: number, enabled: boolean) => {
    setHops((prev) => prev.map((hop, i) => {
      if (i !== idx) return hop;
      const host = hostById.get(hop.hostId);
      const ipv6Addr = String(host?.ipv6 || "").trim();
      return { ...hop, useIpv6: !!enabled && !!ipv6Addr, useTunnelEntryIp: enabled ? false : hop.useTunnelEntryIp };
    }));
  };

  return (
    <div className="space-y-2">
      {headerLabel && (
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-medium">{headerLabel}</span>
          {hops.length > 0 && (
            <span className="text-xs text-muted-foreground">{hops.length} / {maxHops} 台主机</span>
          )}
        </div>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Select value="" onValueChange={addHop} disabled={reachedMaxHops}>
          <SelectTrigger className="h-8 min-w-0 flex-1 text-sm sm:max-w-sm">
            <SelectValue placeholder={reachedMaxHops ? `最多 ${maxHops} 级` : "添加主机到链路..."} />
          </SelectTrigger>
          <SelectContent>
            {reachedMaxHops ? (
              <div className="px-2 py-4 text-center text-xs text-muted-foreground">最多支持 {maxHops} 级隧道</div>
            ) : availableHosts.length === 0 && (
              <div className="px-2 py-4 text-center text-xs text-muted-foreground">已全部添加</div>
            )}
            {availableHosts.map((host) => (
              <SelectItem key={host.id} value={String(host.id)} textValue={host.name}>
                <HostStatusLabel host={host} label={host.name} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!headerLabel && hops.length > 0 && (
          <span className="text-xs text-muted-foreground sm:whitespace-nowrap">{hops.length} / {maxHops} 台主机</span>
        )}
        {showRelayMode && (
          <div className="flex min-w-0 items-center gap-2 sm:ml-auto">
            <span className="shrink-0 text-xs text-muted-foreground">中转模式</span>
            <div className={`${segmentedControlClassName} grid min-w-0 flex-1 grid-cols-2 gap-1 sm:w-52 sm:flex-none`}>
              <button
                type="button"
                aria-pressed={relayMode === "chain"}
                className={segmentedOptionClassName(relayMode === "chain", false, "h-7 px-2 text-xs")}
                onClick={() => onRelayModeChange?.("chain")}
              >
                链路中转
              </button>
              <button
                type="button"
                aria-pressed={relayMode === "failover"}
                className={segmentedOptionClassName(relayMode === "failover", false, "h-7 px-2 text-xs")}
                onClick={() => onRelayModeChange?.("failover")}
              >
                故障转移
              </button>
            </div>
          </div>
        )}
      </div>

      {hops.length === 0 ? (
        <div className="flex items-center justify-center rounded-md border border-dashed border-border py-5 text-sm text-muted-foreground">
          从上方选择主机来创建链路
        </div>
      ) : (
        <div className="space-y-1.5 rounded-md border border-border bg-card p-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/35 px-2.5 py-1.5 text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground/70">开关说明</span>
            <span>内网：使用该主机内网 IP</span>
            <span>IPv6：使用该主机 IPv6</span>
            <span>两者互斥，未配置时不可开启</span>
          </div>
          <div className="hidden grid-cols-[auto_auto_minmax(8rem,1fr)_56px_56px_52px_84px] items-center gap-1.5 px-2.5 text-[11px] text-muted-foreground sm:grid">
            <span className="col-span-2">{relayMode === "failover" ? "优先级" : "顺序"}</span>
            <span>主机</span>
            <span className="text-center">内网</span>
            <span className="text-center">IPv6</span>
            <span className="text-center">角色</span>
            <span className="text-right">操作</span>
          </div>
          <SortableReorderContext sortable={hopSortable} strategy="vertical" restrictToList>
          {hops.map((hop, idx) => {
            const role = getRole(idx, hops.length);
            const isFirst = role === "entry";
            const isLast = role === "exit";
            const host = hostById.get(hop.hostId);
            const tunnelEntryIp = String(host?.tunnelEntryIp || "").trim();
            const hasTunnelEntryIp = !!tunnelEntryIp;
            const hasIpv6 = !!String(host?.ipv6 || "").trim();
            const useTunnelEntryIp = hop.useTunnelEntryIp && hasTunnelEntryIp;
            const useIpv6 = hop.useIpv6 && hasIpv6;
            const isFixedExit = fixedExitIds.has(hop.hostId);
            const showTunnelEntryIpSwitch = !isFirst && !isFixedExit;
            const showIpv6Switch = !isFirst && !isFixedExit;
            const tunnelEntryTip = hasTunnelEntryIp ? "使用内网IP / IX地址" : missingTunnelEntryIpTip;
            const tunnelEntrySwitch = (
              <Switch
                checked={useTunnelEntryIp}
                disabled={!hasTunnelEntryIp}
                onCheckedChange={(checked) => updateUseTunnelEntryIp(idx, !!checked)}
                aria-label={`为${hop.hostName}使用内网IP`}
              />
            );
            const ipv6Switch = (
              <Switch
                checked={useIpv6}
                disabled={!hasIpv6}
                onCheckedChange={(checked) => updateUseIpv6(idx, !!checked)}
                aria-label={`为${hop.hostName}使用IPv6转发`}
              />
            );
            return (
              <SortableItem key={hop.hostId} id={hop.hostId} disabled={isFixedExit || hopSortable.disabled}>
              {({ itemProps, handleProps, isDragging, isDropTarget }) => (
              <div
                {...itemProps}
                className={`flex flex-wrap items-center gap-1.5 rounded-md border bg-background px-2 py-1.5 transition-[border-color,background-color,box-shadow,opacity] duration-150 ${
                  isDragging
                    ? "border-primary/45 bg-card opacity-95 shadow-lg ring-1 ring-primary/20"
                    : "border-border/50"
                } ${isDropTarget ? "border-primary/40 bg-primary/[0.03] ring-1 ring-primary/25" : ""}`}
              >
                {isFixedExit || hopSortable.disabled ? (
                  <span
                    className="inline-flex h-6 w-6 shrink-0 cursor-not-allowed items-center justify-center text-muted-foreground/40"
                    title={isFixedExit ? "固定出口不可排序" : "至少需要两台可排序主机"}
                  >
                    <GripVertical className="h-4 w-4" />
                  </span>
                ) : (
                  <SortableDragHandle dragHandleProps={handleProps} visible className="h-6 w-6" />
                )}
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
                  {idx + 1}
                </span>
                <HostStatusLabel
                  host={host}
                  label={hop.hostName}
                  className="min-w-[7rem] flex-1 basis-[9rem] text-sm font-medium"
                  labelClassName="truncate"
                />

                <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5">
                <div className="flex h-7 w-[56px] shrink-0 items-center justify-center">
                  {showTunnelEntryIpSwitch ? (
                    <TooltipProvider delayDuration={120}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className={hasTunnelEntryIp ? "inline-flex" : "inline-flex cursor-not-allowed"}>
                            {tunnelEntrySwitch}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{tunnelEntryTip}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : (
                    <span className="text-[11px] text-muted-foreground/40">--</span>
                  )}
                </div>

                <div className="flex h-7 w-[56px] shrink-0 items-center justify-center">
                  {showIpv6Switch ? (
                    <TooltipProvider delayDuration={120}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className={hasIpv6 ? "inline-flex" : "inline-flex cursor-not-allowed"}>
                            {ipv6Switch}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{hasIpv6 ? "使用IPv6转发" : missingIpv6Tip}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : (
                    <span className="text-[11px] text-muted-foreground/40">--</span>
                  )}
                </div>

                <Badge variant="outline" className={`flex h-6 min-w-[44px] shrink-0 justify-center whitespace-nowrap px-1.5 py-0 text-[10px] ${ROLE_COLORS[role]}`}>
                  {ROLE_LABELS[role]}
                </Badge>

                <div className="flex h-7 w-[84px] shrink-0 items-center justify-end gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  disabled={idx === 0 || isFixedExit}
                  onClick={() => moveHop(idx, idx - 1)}
                  title="上移"
                >
                  <ArrowDown className="h-3 w-3 rotate-180" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  disabled={idx === hops.length - 1 || isFixedExit}
                  onClick={() => moveHop(idx, idx + 1)}
                  title="下移"
                >
                  <ArrowDown className="h-3 w-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                  disabled={isFixedExit}
                  onClick={() => removeHop(idx)}
                  title="移除"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
                </div>
                </div>
              </div>
              )}
              </SortableItem>
            );
          })}
          </SortableReorderContext>
        </div>
      )}
    </div>
  );
}
