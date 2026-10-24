import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Folder, FolderCog, FolderKanban, FolderPlus, Folders, Pencil, Search, Trash2, X } from "lucide-react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { t } from "@/i18n";
import { trpc } from "@/lib/trpc";
import { pollingInterval } from "@/lib/polling";
import { toast } from "@/lib/localizedToast";
import { cn } from "@/lib/utils";
import type { PersonalRuleGroup } from "@shared/ruleGroups";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useOverlayContainer } from "@/components/ui/overlay-root";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { SortableDragHandle, SortableItem, SortableReorderContext, useOptimisticSortableOrder, useSortableReorder } from "@/components/SortableDragHandle";

const EMPTY_GROUPS: PersonalRuleGroup[] = [];
const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
function PopoverContent({ className, ...props }: ComponentProps<typeof PopoverPrimitive.Content>) {
  const container = useOverlayContainer();
  return <PopoverPrimitive.Portal container={container}><PopoverPrimitive.Content sideOffset={6} collisionPadding={12} className={cn("action-menu-content z-50 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-lg border bg-popover text-popover-foreground shadow-lg", className)} {...props} /></PopoverPrimitive.Portal>;
}
function Checkbox({ checked, disabled, onCheckedChange }: { checked: boolean; disabled?: boolean; onCheckedChange: (checked: boolean) => void }) {
  return <input type="checkbox" className="size-4 shrink-0 accent-primary" checked={checked} disabled={disabled} onChange={event => onCheckedChange(event.target.checked)} />;
}

export function useRefreshPersonalRuleGroups() {
  const utils = trpc.useUtils();
  return async () => {
    await Promise.all([utils.rules.personalGroups.invalidate(), utils.rules.list.invalidate(), utils.rules.listPage.invalidate(), utils.rules.mapItems.invalidate(), utils.rules.listSummary.invalidate()]);
  };
}

function RuleGroupEditorDialog({ group, onClose }: { group: PersonalRuleGroup | null; onClose: () => void }) {
  const [name, setName] = useState(group?.name || "");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [changes, setChanges] = useState<Record<number, boolean>>({});
  const refresh = useRefreshPersonalRuleGroups();
  const query = trpc.rules.listPage.useQuery({ scope: "self", page, pageSize: 20, category: "all", search }, { staleTime: 10_000, refetchOnWindowFocus: false });
  const save = trpc.rules.savePersonalGroup.useMutation({
    onSuccess: async () => { await refresh(); toast.success(t("分组已更新")); onClose(); },
    onError: error => toast.error(error.message),
  });
  const items = (query.data?.items || []) as (Record<string, any> & { id: number; name: string; personalGroupIds?: number[] })[];
  const changeCount = Object.keys(changes).length;
  const submit = () => save.mutate({
    id: group?.id, name: name.trim(),
    addRuleIds: Object.entries(changes).filter(([, selected]) => selected).map(([id]) => Number(id)),
    removeRuleIds: Object.entries(changes).filter(([, selected]) => !selected).map(([id]) => Number(id)),
  });
  return <Dialog open onOpenChange={open => !open && !save.isPending && onClose()}>
    <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-xl">
      <DialogHeader className="shrink-0"><DialogTitle>{t(group ? "编辑分组" : "新增分组")}</DialogTitle><DialogDescription>{t("勾选加入，取消勾选移出，不影响其他分组。")}</DialogDescription></DialogHeader>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        <div className="space-y-2"><Label htmlFor="rule-group-editor-name">{t("分组名")}</Label><Input id="rule-group-editor-name" autoFocus value={name} disabled={save.isPending} maxLength={64} onChange={event => setName(event.target.value)} /></div>
        <div className="relative"><Search className="absolute left-3 top-3 size-4 text-muted-foreground" /><Input aria-label={t("搜索规则")} placeholder={t("搜索规则")} value={search} className="pl-9" disabled={save.isPending} onChange={event => { setSearch(event.target.value); setPage(1); }} /></div>
        <div className="max-h-[38dvh] space-y-1 overflow-y-auto rounded-lg border p-2">
          {items.map(rule => {
            const original = group ? !!rule.personalGroupIds?.includes(group.id) : false;
            const selected = changes[rule.id] ?? original;
            return <label key={rule.id} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-accent">
              <Checkbox checked={selected} disabled={save.isPending || (!(rule.id in changes) && changeCount >= 500)} onCheckedChange={checked => setChanges(current => {
                const next = { ...current };
                if (checked === original) delete next[rule.id]; else next[rule.id] = checked;
                return next;
              })} />
              <span className="min-w-0 flex-1"><span className="block truncate">{rule.name}</span><span className="block truncate text-xs text-muted-foreground">{rule.targetIp}:{rule.targetPort}</span></span><span className="text-xs tabular-nums text-muted-foreground">#{rule.id}</span>
            </label>;
          })}
          {query.isLoading && <p className="p-3 text-center text-sm text-muted-foreground">{t("加载中...")}</p>}
          {query.isError && <Button type="button" variant="ghost" onClick={() => query.refetch()}>{t("重试")}</Button>}
          {!query.isLoading && !query.isError && !items.length && <p className="p-3 text-center text-sm text-muted-foreground">{t("暂无规则")}</p>}
        </div>
        <div className="flex items-center justify-between gap-2"><Button type="button" variant="outline" size="sm" disabled={save.isPending || page <= 1 || query.isFetching} onClick={() => setPage(Math.max(1, (query.data?.page ?? page) - 1))}>{t("上一页")}</Button><span className="text-xs tabular-nums text-muted-foreground">{query.data?.page ?? page} / {query.data?.totalPages ?? 1}</span><Button type="button" variant="outline" size="sm" disabled={save.isPending || !query.data || page >= query.data.totalPages || query.isFetching} onClick={() => setPage((query.data?.page ?? page) + 1)}>{t("下一页")}</Button></div>
      </div>
      <DialogFooter className="shrink-0"><Button type="button" variant="outline" disabled={save.isPending} onClick={onClose}>{t("取消")}</Button><Button type="button" disabled={save.isPending || !name.trim()} onClick={submit}>{t("保存")}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function RuleGroupManagerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const query = trpc.rules.personalGroups.useQuery(undefined, { enabled: open });
  const groups = query.data?.groups || EMPTY_GROUPS;
  const refresh = useRefreshPersonalRuleGroups();
  const confirm = useConfirmDialog();
  const [editing, setEditing] = useState<PersonalRuleGroup | null | undefined>();
  useEffect(() => { if (!open) setEditing(undefined); }, [open]);
  const remove = trpc.rules.deletePersonalGroup.useMutation({ onSuccess: refresh, onError: error => toast.error(error.message) });
  const reorder = trpc.rules.reorderPersonalGroups.useMutation({ onError: error => toast.error(error.message) });
  const pending = remove.isPending || reorder.isPending;
  const order = useOptimisticSortableOrder({ items: groups, getId: group => Number(group.id) });
  const sortable = useSortableReorder({ items: order.items, getId: group => Number(group.id), disabled: pending || groups.length < 2,
    onReorder: next => {
      const request = order.begin(next);
      reorder.mutate({ ids: next.map(group => Number(group.id)) }, { onError: () => order.release(request), onSettled: () => order.resync(request, refresh) });
    },
  });
  return <Dialog open={open} onOpenChange={value => !pending && editing === undefined && onOpenChange(value)}>
    <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-lg">
      <DialogHeader className="shrink-0"><DialogTitle>{t("管理分组")}</DialogTitle><DialogDescription>{t("仅整理自己的规则，不影响转发和授权。")}</DialogDescription></DialogHeader>
      <Button type="button" variant="outline" className="shrink-0 self-end gap-2" disabled={pending} onClick={() => setEditing(null)}><FolderPlus className="size-4" />{t("新增分组")}</Button>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {query.isError && <Button variant="outline" onClick={() => query.refetch()}>{t("重试")}</Button>}
        {!query.isLoading && !groups.length && <p className="py-6 text-center text-sm text-muted-foreground">{t("暂无分组")}</p>}
        <SortableReorderContext sortable={sortable} ids={order.items.map(group => Number(group.id))} strategy="vertical" restrictToList>
          {order.items.map(group => <SortableItem key={group.id} id={Number(group.id)} disabled={sortable.disabled}>
            {({ itemProps, handleProps, isDragging }) => <div {...itemProps} className={cn("flex items-center gap-2 rounded-lg border bg-background p-2", isDragging && "opacity-60")}>
              <SortableDragHandle dragHandleProps={handleProps} visible busy={pending} />
              <span className="min-w-0 flex-1 truncate text-sm" title={group.name}>{group.name}</span><Badge variant="secondary">{group.count}</Badge>
              <Button type="button" variant="ghost" size="icon" disabled={pending} title={t("编辑分组")} aria-label={t("编辑分组")} onClick={() => setEditing(group)}><Pencil className="size-4" /></Button>
              <Button variant="ghost" size="icon" disabled={pending} aria-label={t("删除分组")} onClick={async () => {
                if (await confirm({ title: t("删除分组"), description: t("仅移除分组及其归属关系，规则和其他分组会保留。"), confirmText: t("删除"), tone: "destructive" })) {
                  remove.mutate({ id: group.id });
                }
              }}><Trash2 className="size-4 text-destructive" /></Button>
            </div>}
          </SortableItem>)}
        </SortableReorderContext>
      </div>
      <DialogFooter className="shrink-0"><Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>{t("关闭")}</Button></DialogFooter>
    </DialogContent>
    {editing !== undefined && <RuleGroupEditorDialog key={editing?.id ?? "new"} group={editing} onClose={() => setEditing(undefined)} />}
  </Dialog>;
}

export function RuleGroupMultiSelect({ value, onChange, disabled = false }: { value: number[]; onChange: (ids: number[]) => void; disabled?: boolean }) {
  const valueRef = useRef(value);
  valueRef.current = value;
  const query = trpc.rules.personalGroups.useQuery();
  const groups = query.data?.groups || EMPTY_GROUPS;
  const refresh = useRefreshPersonalRuleGroups();
  const [search, setSearch] = useState("");
  const [manager, setManager] = useState(false);
  const [open, setOpen] = useState(false);
  const save = trpc.rules.savePersonalGroup.useMutation({ onSuccess: async result => { await refresh(); onChange([...new Set([...valueRef.current, result.id])]); setSearch(""); }, onError: error => toast.error(error.message) });
  // Only prune removed groups after a successful response, never while loading.
  useEffect(() => {
    if (!query.data) return;
    const allowed = new Set(query.data.groups.map(group => Number(group.id)));
    const next = value.filter(id => allowed.has(id));
    if (next.length !== value.length) onChange(next);
  }, [query.data, value, onChange]);
  const selected = groups.filter(group => value.includes(group.id));
  return <div className="space-y-2">
    <div className="flex items-center justify-between gap-2"><Label>{t("规则分组")}</Label><Button type="button" variant="ghost" size="icon" className="size-7" disabled={disabled} title={t("管理分组")} aria-label={t("管理分组")} onClick={() => setManager(true)}><FolderCog className="size-4" /></Button></div>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button type="button" variant="outline" disabled={disabled || query.isLoading} className="h-10 w-full justify-start text-left font-normal"><Folders className="mr-2 size-4 shrink-0 text-primary" /><span className="min-w-0 truncate">{selected.length ? t("已选 {0} 个分组", [selected.length]) : t("选择分组（可多选）")}</span></Button></PopoverTrigger>
      <PopoverContent className="w-[min(22rem,calc(100vw-3rem))] p-2" align="start">
        <Input autoFocus value={search} maxLength={64} onChange={event => setSearch(event.target.value)} placeholder={t("搜索或新增分组")} className="mb-2" />
        <div className="max-h-52 space-y-1 overflow-y-auto">
          {groups.filter(group => group.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).map(group => <label key={group.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-sm hover:bg-accent"><Checkbox disabled={disabled} checked={value.includes(group.id)} onCheckedChange={checked => onChange(checked ? [...new Set([...value, group.id])] : value.filter(id => id !== group.id))} /><span className="min-w-0 flex-1 truncate">{group.name}</span><span className="text-xs text-muted-foreground">{group.count}</span></label>)}
        </div>
        {!!search.trim() && !groups.some(group => group.name.toLocaleLowerCase() === search.trim().toLocaleLowerCase()) && <Button type="button" variant="ghost" className="mt-1 w-full justify-start" disabled={save.isPending || groups.length >= 100} onClick={() => save.mutate({ name: search.trim() })}><FolderPlus className="mr-2 size-4" />{t("新增分组")}</Button>}
        {query.isError && <Button variant="ghost" onClick={() => query.refetch()}>{t("重试")}</Button>}
      </PopoverContent>
    </Popover>
    {selected.length > 0 && <div className="flex max-h-20 flex-wrap gap-1 overflow-y-auto">{selected.map(group => <Badge key={group.id} variant="secondary" className="max-w-full gap-1"><span className="truncate">{group.name}</span><button type="button" disabled={disabled} aria-label={t("移出分组")} onClick={() => onChange(value.filter(id => id !== group.id))}><X className="size-3" /></button></Badge>)}</div>}
    <RuleGroupManagerDialog open={manager} onOpenChange={setManager} />
  </div>;
}

export function RuleGroupBar({ value, onChange }: { value: number | null; onChange: (id: number | null) => void }) {
  const query = trpc.rules.personalGroups.useQuery(undefined, { staleTime: 10_000, refetchInterval: pollingInterval("normal") });
  const [manager, setManager] = useState(false);
  useEffect(() => { if (query.data && value && !query.data.groups.some(group => group.id === value)) onChange(null); }, [query.data, value, onChange]);
  const options = [{ id: null, name: t("全部"), count: query.data?.total }, ...(query.data?.groups || []), { id: 0, name: t("未分组"), count: query.data?.ungrouped }];
  return <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/40 bg-card/50 p-2 backdrop-blur-md">
    <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto py-0.5">{options.map(group => {
      const active = value === group.id;
      const Icon = group.id === null ? Folders : group.id === 0 ? Folder : FolderKanban;
      return <button key={group.id ?? "all"} type="button" aria-pressed={active} title={group.name} className={cn("inline-flex h-9 max-w-56 shrink-0 items-center gap-2 rounded-md border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active ? "border-chart-1/35 bg-chart-1/10 text-chart-1 shadow-sm" : "border-border/45 bg-card/60 text-muted-foreground hover:bg-muted/45 hover:text-foreground")} onClick={() => onChange(group.id)}><Icon className="size-3.5 shrink-0" /><span className="truncate">{group.name}</span><span className={cn("rounded px-1.5 py-0.5 text-[11px] tabular-nums", active ? "bg-chart-1/15 text-chart-1" : "bg-background/70 text-muted-foreground")}>{group.count ?? "–"}</span></button>;
    })}</div>
    <Button type="button" variant="outline" size="icon" className="size-9 shrink-0 border-border/45 bg-card/60 text-muted-foreground" title={t("管理分组")} aria-label={t("管理分组")} onClick={() => setManager(true)}><FolderCog className="size-4" /></Button>
    <RuleGroupManagerDialog open={manager} onOpenChange={setManager} />
  </div>;
}

export function useRuleGroupBulkEditor({ enabled }: { enabled: boolean }) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [ids, setIds] = useState<number[]>([]);
  const [groupIds, updateGroupIds] = useState<number[]>([]);
  const [mode, updateMode] = useState<"replace" | "add" | "remove">("add");
  const setGroupIds = (next: number[]) => {
    updateGroupIds(next);
    setPage(1);
    setIds([]);
  };
  const setMode = (next: typeof mode) => {
    updateMode(next);
    setPage(1);
    setIds([]);
  };
  const refresh = useRefreshPersonalRuleGroups();
  const confirm = useConfirmDialog();
  const query = trpc.rules.listPage.useQuery({
    scope: "self", page, pageSize: 20, category: "all", search,
    personalGroupChange: mode === "replace" ? undefined : { mode, groupIds },
  }, { enabled, staleTime: 10_000, refetchOnWindowFocus: false });
  const move = trpc.rules.moveToPersonalGroups.useMutation({ onSuccess: async () => { setIds([]); await refresh(); toast.success(t("分组已更新")); }, onError: error => toast.error(error.message) });
  useEffect(() => {
    if (enabled) return;
    setPage(1);
    setSearch("");
    setIds([]);
    updateGroupIds([]);
    updateMode("add");
  }, [enabled]);
  const items = (query.data?.items || []) as any[];
  const canApply = enabled && ids.length > 0 && !move.isPending && (mode === "replace" || groupIds.length > 0);
  const apply = async () => {
    if (!canApply) return;
    if (mode === "replace" && !(await confirm({ title: t("替换分组"), description: t("所选规则原有的分组归属将被替换。"), confirmText: t("继续") }))) return;
    move.mutate({ ids, groupIds, mode });
  };
  return { page, setPage, search, setSearch, ids, setIds, groupIds, setGroupIds, mode, setMode, query, items, isPending: move.isPending, canApply, apply };
}

type RuleGroupBulkEditorState = ReturnType<typeof useRuleGroupBulkEditor>;

export function RuleGroupBulkEditor({ editor }: { editor: RuleGroupBulkEditorState }) {
  const { search, setSearch, setPage, ids, setIds, groupIds, setGroupIds, mode, setMode, query, items, isPending } = editor;
  return <div className="space-y-3">
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_8rem] items-start gap-2">
      <RuleGroupMultiSelect value={groupIds} onChange={setGroupIds} disabled={isPending} />
      <div className="min-w-0 space-y-2">
        <div className="flex h-7 items-center"><Label>{t("操作")}</Label></div>
        <Select value={mode} onValueChange={value => setMode(value as typeof mode)} disabled={isPending}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="add">{t("加入分组")}</SelectItem><SelectItem value="remove">{t("移出分组")}</SelectItem><SelectItem value="replace">{t("替换分组")}</SelectItem></SelectContent></Select>
      </div>
    </div>
    <div className="relative"><Search className="absolute left-3 top-3 size-4 text-muted-foreground" /><Input value={search} disabled={isPending} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder={t("搜索规则")} className="pl-9" /></div>
    <div aria-busy={query.isFetching} className="min-h-48 space-y-1 rounded-lg border p-2">
      {items.map(rule => <label key={rule.id} className="flex cursor-pointer items-center gap-2 rounded p-2 text-sm hover:bg-accent"><Checkbox disabled={isPending || (!ids.includes(rule.id) && ids.length >= 500)} checked={ids.includes(rule.id)} onCheckedChange={checked => setIds(current => checked ? [...new Set([...current, rule.id])] : current.filter(id => id !== rule.id))} /><span className="min-w-0 flex-1 truncate">{rule.name}</span><span className="text-xs text-muted-foreground">#{rule.id}</span></label>)}
      {query.isLoading && <p className="p-2 text-sm text-muted-foreground">{t("加载中...")}</p>}
      {query.isError && <Button variant="ghost" onClick={() => query.refetch()}>{t("重试")}</Button>}
      {!query.isLoading && !query.isError && !items.length && <p className="p-2 text-sm text-muted-foreground">{mode !== "replace" && !groupIds.length ? t("请先选择分组") : t("没有匹配的转发规则")}</p>}
    </div>
  </div>;
}

export function RuleGroupBulkPagination({ editor }: { editor: RuleGroupBulkEditorState }) {
  const { page, setPage, query, isPending } = editor;
  const currentPage = query.data?.page ?? page;
  return <div className="flex items-center gap-2">
    <Button type="button" variant="outline" size="sm" disabled={isPending || currentPage <= 1 || query.isFetching} onClick={() => setPage(currentPage - 1)}>{t("上一页")}</Button>
    <span className="text-xs tabular-nums">{currentPage} / {query.data?.totalPages ?? 1}</span>
    <Button type="button" variant="outline" size="sm" disabled={isPending || !query.data || currentPage >= query.data.totalPages || query.isFetching} onClick={() => setPage(currentPage + 1)}>{t("下一页")}</Button>
  </div>;
}

export function RuleGroupBulkApplyButton({ editor }: { editor: RuleGroupBulkEditorState }) {
  return <Button type="button" disabled={!editor.canApply} onClick={editor.apply}>{t("应用到 {0} 条规则", [editor.ids.length])}</Button>;
}
