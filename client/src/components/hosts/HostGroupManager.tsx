import DataSectionLoading from "@/components/DataSectionLoading";
import HostStatusLabel from "@/components/HostStatusLabel";
import { SortableDragHandle, SortableItem, SortableReorderContext, useSortableReorder } from "@/components/SortableDragHandle";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { OptimisticSwitch, Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { FolderKanban, Loader2, Pencil, Plus, Power, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

export type HostGroupView = {
  id: number;
  name: string;
  isEnabled: boolean;
  sortOrder?: number;
  hostIds?: number[];
  members?: Array<{ hostId: number; sortOrder?: number }>;
};

export type HostGroupViewMode = "card" | "table";

type HostGroupForm = {
  name: string;
  hostIds: number[];
  isEnabled: boolean;
};

const defaultForm: HostGroupForm = {
  name: "",
  hostIds: [],
  isEnabled: true,
};

function uniqueHostIds(hostIds: unknown[]) {
  return Array.from(new Set((hostIds || [])
    .map((id) => Math.floor(Number(id)))
    .filter((id) => Number.isInteger(id) && id > 0)));
}

function groupHostIds(group: HostGroupView | null | undefined) {
  if (!group) return [];
  if (Array.isArray(group.hostIds)) return uniqueHostIds(group.hostIds);
  return uniqueHostIds((group.members || []).map((member) => member.hostId));
}

function groupMatchesSearchQuery(group: HostGroupView, query: string, hostsById: Map<number, any>) {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const memberValues = groupHostIds(group).flatMap((hostId) => {
    const host = hostsById.get(hostId);
    return [hostId, host?.name, host?.entryIp, host?.ipv4, host?.ipv6, host?.ip];
  });
  const status = group.isEnabled !== false ? "启用 已启用" : "停用 已停用 禁用";
  const haystack = [group.id, group.name, status, ...memberValues]
    .filter((value) => value !== null && value !== undefined)
    .join(" ")
    .toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function buildGroupUpdatePayload(group: HostGroupView, isEnabled = group.isEnabled !== false) {
  return {
    id: Number(group.id),
    name: String(group.name || "").trim(),
    hostIds: groupHostIds(group),
    isEnabled,
    sortOrder: Math.max(0, Math.floor(Number(group.sortOrder) || 0)),
  };
}

function groupHostCount(group: HostGroupView, hostsById: Map<number, any>) {
  return groupHostIds(group).filter((hostId) => hostsById.has(hostId)).length;
}

function normalizeHostSortOrder(value: unknown) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function sortHostsByDisplayOrder(hosts: any[]) {
  return [...hosts].sort((a: any, b: any) => {
    const sortA = normalizeHostSortOrder(a?.sortOrder);
    const sortB = normalizeHostSortOrder(b?.sortOrder);
    if (sortA !== sortB) return sortA - sortB;
    const createdA = new Date(a?.createdAt || 0).getTime();
    const createdB = new Date(b?.createdAt || 0).getTime();
    if (Number.isFinite(createdA) && Number.isFinite(createdB) && createdA !== createdB) return createdB - createdA;
    return Number(b?.id || 0) - Number(a?.id || 0);
  });
}

function HostGroupEnabledSwitch({
  group,
  onToggle,
}: {
  group: HostGroupView;
  onToggle: (group: HostGroupView, checked: boolean) => Promise<unknown>;
}) {
  const enabled = group.isEnabled !== false;
  return (
    <OptimisticSwitch
      checked={enabled}
      onCheckedChangeAsync={(checked) => onToggle(group, checked)}
      onToggleSuccess={(checked) => toast.success(checked ? "主机分组已开启" : "主机分组已关闭")}
      onToggleError={(error) => toast.error(error instanceof Error ? error.message : "切换主机分组状态失败")}
      className="scale-75"
      title={`${enabled ? "停用" : "启用"}主机分组 ${group.name || ""}`}
      aria-label={`${enabled ? "停用" : "启用"}分组 ${group.name || ""}`}
    />
  );
}

function HostGroupHostPreview({
  hostIds,
  hostsById,
  emptyText = "暂未添加主机",
}: {
  hostIds: number[];
  hostsById: Map<number, any>;
  emptyText?: string;
}) {
  const hosts = sortHostsByDisplayOrder(hostIds.map((hostId) => hostsById.get(hostId)).filter(Boolean));
  if (hosts.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border/60 px-3 py-4 text-center text-sm text-muted-foreground">
        {emptyText}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {hosts.slice(0, 10).map((host: any) => (
        <span
          key={host.id}
          className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/45 bg-background/70 px-2 py-1 text-xs"
          title={host.name}
        >
          <HostStatusLabel host={host} label={host.name} className="max-w-[180px]" labelClassName="truncate" />
        </span>
      ))}
      {hosts.length > 10 && (
        <span className="inline-flex items-center rounded-md border border-border/45 bg-muted/35 px-2 py-1 text-xs text-muted-foreground">
          +{hosts.length - 10}
        </span>
      )}
    </div>
  );
}

export default function HostGroupManager({
  hosts,
  groups,
  isLoading,
  createSignal,
  onCreateSignalHandled,
  viewMode = "card",
  searchQuery = "",
  onFilterStatsChange,
}: {
  hosts: any[];
  groups: HostGroupView[];
  isLoading?: boolean;
  createSignal: number;
  onCreateSignalHandled: () => void;
  viewMode?: HostGroupViewMode;
  searchQuery?: string;
  onFilterStatsChange?: (stats: { filtered: number; total: number }) => void;
}) {
  const utils = trpc.useUtils();
  const confirmDialog = useConfirmDialog();
  const hostsById = useMemo(() => new Map((hosts || []).map((host: any) => [Number(host.id), host])), [hosts]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<HostGroupForm>(defaultForm);
  const selectedHostIdSet = useMemo(() => new Set(form.hostIds.map(Number)), [form.hostIds]);
  const availableHosts = useMemo(
    () => (hosts || []).filter((host: any) => !selectedHostIdSet.has(Number(host.id))),
    [hosts, selectedHostIdSet],
  );
  const selectedHosts = useMemo(
    () => (hosts || []).filter((host: any) => selectedHostIdSet.has(Number(host.id))),
    [hosts, selectedHostIdSet],
  );
  const sortedGroups = useMemo(
    () => [...(groups || [])].sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || Number(b.id || 0) - Number(a.id || 0)),
    [groups],
  );
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const isTextFiltered = normalizedSearchQuery.length > 0;
  const filteredGroups = useMemo(
    () => isTextFiltered
      ? sortedGroups.filter((group) => groupMatchesSearchQuery(group, normalizedSearchQuery, hostsById))
      : sortedGroups,
    [hostsById, isTextFiltered, normalizedSearchQuery, sortedGroups],
  );
  useEffect(() => {
    onFilterStatsChange?.({ filtered: filteredGroups.length, total: sortedGroups.length });
  }, [filteredGroups.length, onFilterStatsChange, sortedGroups.length]);

  const createMutation = trpc.hosts.createHostGroup.useMutation({
    onSuccess: () => {
      utils.hosts.hostGroups.invalidate();
      setDialogOpen(false);
      setForm(defaultForm);
      toast.success("分组已添加");
    },
    onError: (err) => toast.error(err.message || "添加分组失败"),
  });
  const updateMutation = trpc.hosts.updateHostGroup.useMutation({
    onSuccess: () => {
      utils.hosts.hostGroups.invalidate();
      setDialogOpen(false);
      setEditingId(null);
      setForm(defaultForm);
      toast.success("分组已更新");
    },
    onError: (err) => toast.error(err.message || "更新分组失败"),
  });
  const toggleMutation = trpc.hosts.updateHostGroup.useMutation({
    onSuccess: async () => {
      await utils.hosts.hostGroups.invalidate();
    },
  });
  const deleteMutation = trpc.hosts.deleteHostGroup.useMutation({
    onSuccess: () => {
      utils.hosts.hostGroups.invalidate();
      toast.success("分组已删除");
    },
    onError: (err) => toast.error(err.message || "删除分组失败"),
  });
  const reorderGroupsMutation = trpc.hosts.reorderHostGroups.useMutation({
    onSuccess: () => {
      utils.hosts.hostGroups.invalidate();
      toast.success("分组顺序已更新");
    },
    onError: (err) => toast.error(err.message || "更新分组顺序失败"),
  });
  const groupSortable = useSortableReorder({
    items: filteredGroups,
    getId: (group) => Number(group.id),
    disabled: isTextFiltered || filteredGroups.length < 2,
    onReorder: (nextGroups) => {
      reorderGroupsMutation.mutate({ ids: nextGroups.map((group) => Number(group.id)) });
    },
  });

  useEffect(() => {
    if (createSignal <= 0) return;
    setEditingId(null);
    setForm(defaultForm);
    setDialogOpen(true);
    onCreateSignalHandled();
  }, [createSignal, onCreateSignalHandled]);

  const openEdit = (group: HostGroupView) => {
    setEditingId(Number(group.id));
    setForm({
      name: group.name || "",
      hostIds: groupHostIds(group),
      isEnabled: group.isEnabled !== false,
    });
    setDialogOpen(true);
  };

  const addHost = (hostId: string) => {
    const id = Number(hostId);
    if (!Number.isInteger(id) || id <= 0) return;
    setForm((current) => selectedHostIdSet.has(id) ? current : { ...current, hostIds: [...current.hostIds, id] });
  };

  const removeHost = (hostId: number) => {
    setForm((current) => ({ ...current, hostIds: current.hostIds.filter((id) => Number(id) !== Number(hostId)) }));
  };

  const toggleGroupEnabled = async (group: HostGroupView, checked: boolean) => {
    const id = Number(group?.id || 0);
    if (!id) throw new Error("主机分组不存在");
    await toggleMutation.mutateAsync(buildGroupUpdatePayload(group, checked));
  };

  const submit = () => {
    const name = form.name.trim();
    if (!name) {
      toast.error("请输入分组名");
      return;
    }
    const payload = { name, hostIds: uniqueHostIds(form.hostIds), isEnabled: form.isEnabled };
    if (editingId) updateMutation.mutate({ ...payload, id: editingId });
    else createMutation.mutate(payload);
  };

  const confirmDelete = async (group: HostGroupView) => {
    if (await confirmDialog({
      title: "删除分组",
      description: `确定要删除“${group.name || "此分组"}”吗？删除后不会影响主机本身。`,
      confirmText: "删除",
      tone: "destructive",
    })) {
      deleteMutation.mutate({ id: Number(group.id) });
    }
  };

  const pending = createMutation.isPending || updateMutation.isPending;
  const groupActionButtons = (group: HostGroupView) => (
    <div className="flex justify-end gap-1">
      <Button variant="ghost" size="icon" className="h-8 w-8" title="编辑分组" onClick={() => openEdit(group)}>
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" title="删除分组" onClick={() => confirmDelete(group)}>
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );

  const renderEmptyState = (className = "") => (
    <Card className={`border-dashed border-border/55 bg-card/45 backdrop-blur-md ${className}`}>
      <CardContent className="flex min-h-[240px] flex-col items-center justify-center px-5 py-12 text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
          <FolderKanban className="h-5 w-5" />
        </span>
        <p className="mt-3 text-sm font-semibold">{isTextFiltered && sortedGroups.length > 0 ? "未找到匹配分组" : "暂无自定义分组"}</p>
        <p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">
          {isTextFiltered && sortedGroups.length > 0
            ? "调整筛选内容或清空搜索"
            : "未创建分组时，主机管理默认展示全部主机；需要按业务、地区或用途筛选时再添加分组。"}
        </p>
      </CardContent>
    </Card>
  );

  const renderGroupCard = (group: HostGroupView, options: { dragHandle?: any; sortableClassName?: string } = {}) => {
    const hostIds = groupHostIds(group);
    return (
      <Card key={group.id} className={cn("action-card group/sortable border-border/40 bg-card/60 backdrop-blur-md", options.sortableClassName)}>
        <CardContent className="action-card-content space-y-4 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <FolderKanban className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold" title={group.name}>{group.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{groupHostCount(group, hostsById)} 台主机</p>
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {options.dragHandle}
              <HostGroupEnabledSwitch group={group} onToggle={toggleGroupEnabled} />
            </div>
          </div>

          <HostGroupHostPreview hostIds={hostIds} hostsById={hostsById} />

          <div className="action-card-footer flex justify-end border-t border-border/40 pt-2">
            {groupActionButtons(group)}
          </div>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground sm:text-sm">
        按业务、地区或用途整理主机，分组顺序可直接拖动调整。
      </p>

      {isLoading ? (
        <DataSectionLoading label="正在加载主机分组" minHeight="min-h-[220px]" />
      ) : viewMode === "table" ? (
        <div key="host-group-table-view" className="card-mode-transition">
          {filteredGroups.length === 0 ? (
            <div className="sm:hidden">{renderEmptyState()}</div>
          ) : (
            <SortableReorderContext sortable={groupSortable} ids={filteredGroups.map((group) => Number(group.id))} strategy="vertical" restrictToList>
              <div className="grid grid-cols-1 gap-4 sm:hidden">
                {filteredGroups.map((group) => (
                  <SortableItem key={group.id} id={Number(group.id)} disabled={groupSortable.disabled}>
                    {({ itemProps, handleProps, isDragging, isDropTarget }) => (
                      <div {...itemProps}>
                        {renderGroupCard(group, {
                          dragHandle: <SortableDragHandle dragHandleProps={handleProps} visible={isDragging} />,
                          sortableClassName: cn(isDragging && "opacity-55 ring-1 ring-primary/35", isDropTarget && "ring-1 ring-primary/45"),
                        })}
                      </div>
                    )}
                  </SortableItem>
                ))}
              </div>
            </SortableReorderContext>
          )}
          <Card className="hidden border-border/40 bg-card/60 backdrop-blur-md sm:block">
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table className="min-w-[884px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[44px]" />
                      <TableHead className="w-[220px]">分组</TableHead>
                      <TableHead className="w-[96px]">状态</TableHead>
                      <TableHead className="w-[96px]">主机数</TableHead>
                      <TableHead>主机</TableHead>
                      <TableHead className="w-[110px] text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredGroups.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6}>
                          {renderEmptyState("border-0 bg-transparent shadow-none")}
                        </TableCell>
                      </TableRow>
                    ) : (
                      <SortableReorderContext sortable={groupSortable} ids={filteredGroups.map((group) => Number(group.id))} strategy="vertical" restrictToList>
                        {filteredGroups.map((group) => {
                      const hostIds = groupHostIds(group);
                      return (
                        <SortableItem key={group.id} id={Number(group.id)} disabled={groupSortable.disabled} itemKind="row">
                          {({ itemProps, handleProps, isDragging, isDropTarget }) => (
                        <TableRow
                          {...itemProps}
                          className={cn(
                            "group/sortable",
                            isDragging && "opacity-55 ring-1 ring-primary/35",
                            isDropTarget && "ring-1 ring-primary/45",
                          )}
                        >
                          <TableCell className="w-[44px] px-2">
                            <SortableDragHandle dragHandleProps={handleProps} visible={isDragging} />
                          </TableCell>
                          <TableCell>
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                                <FolderKanban className="h-4 w-4" />
                              </span>
                              <span className="min-w-0 truncate font-medium" title={group.name}>{group.name}</span>
                            </div>
                          </TableCell>
                          <TableCell><HostGroupEnabledSwitch group={group} onToggle={toggleGroupEnabled} /></TableCell>
                          <TableCell className="text-sm tabular-nums">{groupHostCount(group, hostsById)}</TableCell>
                          <TableCell>
                            <HostGroupHostPreview hostIds={hostIds} hostsById={hostsById} />
                          </TableCell>
                          <TableCell className="text-right">{groupActionButtons(group)}</TableCell>
                        </TableRow>
                          )}
                        </SortableItem>
                      );
                    })}
                      </SortableReorderContext>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : (
        filteredGroups.length === 0 ? (
          renderEmptyState("col-span-full")
        ) : (
          <SortableReorderContext sortable={groupSortable} ids={filteredGroups.map((group) => Number(group.id))} strategy="rect">
            <div key="host-group-card-view" className="standard-card-grid gap-4">
              {filteredGroups.map((group) => (
                <SortableItem key={group.id} id={Number(group.id)} disabled={groupSortable.disabled}>
                  {({ itemProps, handleProps, isDragging, isDropTarget }) => (
                    <div {...itemProps}>
                      {renderGroupCard(group, {
                        dragHandle: <SortableDragHandle dragHandleProps={handleProps} visible={isDragging} />,
                        sortableClassName: cn(isDragging && "opacity-55 ring-1 ring-primary/35", isDropTarget && "ring-1 ring-primary/45"),
                      })}
                    </div>
                  )}
                </SortableItem>
              ))}
            </div>
          </SortableReorderContext>
        )
      )}

      <Dialog open={dialogOpen} onOpenChange={(open) => !pending && setDialogOpen(open)}>
        <DialogContent className="flex max-h-[88vh] flex-col overflow-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingId ? "编辑分组" : "添加分组"}</DialogTitle>
            <DialogDescription>选择需要归入此分组的主机。</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_140px]">
              <div className="space-y-1.5">
                <Label>分组名</Label>
                <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：香港入口组" />
              </div>
              <label className="flex items-center justify-between gap-3 rounded-md border border-border/50 px-3 py-2.5 sm:self-end">
                <span className="inline-flex items-center gap-2 text-sm font-medium">
                  <Power className="h-3.5 w-3.5 text-muted-foreground" />
                  启用
                </span>
                <Switch checked={form.isEnabled} onCheckedChange={(checked) => setForm({ ...form, isEnabled: checked })} />
              </label>
            </div>

            <div className="space-y-3 rounded-md border border-border/50 p-3">
              <div className="flex items-center justify-between gap-3">
                <Label className="text-sm">添加主机</Label>
                {form.hostIds.length > 0 && <span className="text-xs text-muted-foreground">{form.hostIds.length} 台</span>}
              </div>
              <Select value="" onValueChange={addHost} disabled={availableHosts.length === 0}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder={availableHosts.length === 0 ? "已全部添加" : "选择要加入分组的主机..."} />
                </SelectTrigger>
                <SelectContent>
                  {availableHosts.length === 0 ? (
                    <div className="px-2 py-4 text-center text-xs text-muted-foreground">已全部添加</div>
                  ) : availableHosts.map((host: any) => (
                    <SelectItem key={host.id} value={String(host.id)} textValue={host.name}>
                      <HostStatusLabel host={host} label={host.name} />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {selectedHosts.length === 0 ? (
                <div className="flex items-center justify-center rounded-md border border-dashed border-border py-5 text-sm text-muted-foreground">
                  从上方选择主机
                </div>
              ) : (
                <div className="flex flex-wrap gap-2 rounded-md border border-border bg-card p-2">
                  {selectedHosts.map((host: any) => (
                    <span
                      key={host.id}
                      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/50 bg-background px-2 py-1 text-sm"
                      title={host.name}
                    >
                      <HostStatusLabel host={host} label={host.name} className="min-w-0 max-w-[180px] font-medium" labelClassName="truncate" />
                      <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive" title="从分组移除" onClick={() => removeHost(Number(host.id))}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={pending}>取消</Button>
            <Button onClick={submit} disabled={pending}>
              {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              {pending ? "处理中..." : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
