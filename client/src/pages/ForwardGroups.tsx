import DashboardLayout from "@/components/DashboardLayout";
import { PersistentPagination, usePersistentPagination } from "@/components/PersistentPagination";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { getTunnelRouteText } from "@/lib/tunnelDisplay";
import { trpc } from "@/lib/trpc";
import {
  Activity,
  CheckCircle2,
  GripVertical,
  Layers3,
  LayoutGrid,
  List,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Server,
  Trash2,
  XCircle,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";

type GroupType = "host" | "tunnel";

type MemberForm = {
  key: string;
  memberType: GroupType;
  hostId: number | null;
  tunnelId: number | null;
  isEnabled: boolean;
};

type GroupForm = {
  name: string;
  groupType: GroupType;
  domain: string;
  recordType: "A" | "AAAA" | "CNAME";
  failoverSeconds: string;
  recoverSeconds: string;
  autoFailback: boolean;
  isEnabled: boolean;
  members: MemberForm[];
};

const makeDefaultForm = (): GroupForm => ({
  name: "",
  groupType: "host",
  domain: "",
  recordType: "A",
  failoverSeconds: "60",
  recoverSeconds: "120",
  autoFailback: true,
  isEnabled: true,
  members: [],
});

function memberKey(memberType: GroupType, id: number) {
  return `${memberType}-${id}`;
}

type ForwardGroupViewMode = "card" | "table";

const FORWARD_GROUP_VIEW_MODE_STORAGE_KEY = "forwardx.forwardGroups.viewMode";

function getStoredForwardGroupViewMode(): ForwardGroupViewMode {
  if (typeof window === "undefined") return "card";
  try {
    const value = window.localStorage.getItem(FORWARD_GROUP_VIEW_MODE_STORAGE_KEY);
    return value === "table" ? "table" : "card";
  } catch {
    return "card";
  }
}

function storeForwardGroupViewMode(viewMode: ForwardGroupViewMode) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FORWARD_GROUP_VIEW_MODE_STORAGE_KEY, viewMode);
  } catch {
    // Ignore storage failures so the page still works in restricted browsers.
  }
}

function ForwardGroupsContent() {
  const utils = trpc.useUtils();
  const { data: groups, isLoading } = trpc.forwardGroups.list.useQuery(undefined, { refetchInterval: 15000 });
  const { data: hosts } = trpc.hosts.list.useQuery();
  const { data: tunnels } = trpc.tunnels.list.useQuery();
  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<GroupForm>(makeDefaultForm());
  const savedMembersRef = useRef<Record<string, MemberForm[]>>({ host: [], tunnel: [] });
  const [dragMemberKey, setDragMemberKey] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ForwardGroupViewMode>(() => getStoredForwardGroupViewMode());

  const hostById = useMemo(() => new Map<number, any>((hosts || []).map((h: any) => [Number(h.id), h])), [hosts]);
  const tunnelById = useMemo(() => new Map<number, any>((tunnels || []).map((t: any) => [Number(t.id), t])), [tunnels]);
  const activeCount = groups?.filter((g: any) => g.isEnabled && g.lastStatus === "healthy").length ?? 0;
  const groupPagination = usePersistentPagination(groups || [], {
    storageKey: "forwardx.forwardGroups.page",
    pageSize: 12,
    isReady: !isLoading && !!groups,
  });
  const pagedGroups = groupPagination.items;

  const resetForm = () => {
    setForm(makeDefaultForm());
    setEditingId(null);
    setDragMemberKey(null);
    savedMembersRef.current = { host: [], tunnel: [] };
  };

  const openCreate = () => {
    resetForm();
    setShowDialog(true);
  };

  const openEdit = (group: any) => {
    setForm({
      name: group.name || "",
      groupType: group.groupType === "tunnel" ? "tunnel" : "host",
      domain: group.domain || "",
      recordType: group.recordType || "A",
      failoverSeconds: String(Number(group.failoverSeconds || 60)),
      recoverSeconds: String(Number(group.recoverSeconds || 120)),
      autoFailback: !!group.autoFailback,
      isEnabled: !!group.isEnabled,
      members: (group.members || []).map((member: any) => ({
        key: memberKey(member.memberType, Number(member.memberType === "host" ? member.hostId : member.tunnelId)),
        memberType: member.memberType,
        hostId: member.hostId ? Number(member.hostId) : null,
        tunnelId: member.tunnelId ? Number(member.tunnelId) : null,
        isEnabled: !!member.isEnabled,
      })),
    });
    setEditingId(Number(group.id));
    setShowDialog(true);
  };

  const createMutation = trpc.forwardGroups.create.useMutation({
    onSuccess: () => {
      utils.forwardGroups.list.invalidate();
      utils.rules.list.invalidate();
      setShowDialog(false);
      resetForm();
      toast.success("转发组已创建");
    },
    onError: (e) => toast.error(e.message || "创建失败"),
  });

  const updateMutation = trpc.forwardGroups.update.useMutation({
    onSuccess: () => {
      utils.forwardGroups.list.invalidate();
      utils.rules.list.invalidate();
      setShowDialog(false);
      resetForm();
      toast.success("转发组已更新");
    },
    onError: (e) => toast.error(e.message || "更新失败"),
  });

  const deleteMutation = trpc.forwardGroups.delete.useMutation({
    onSuccess: () => {
      utils.forwardGroups.list.invalidate();
      utils.rules.list.invalidate();
      toast.success("转发组已删除，引用规则将同步清理");
    },
    onError: (e) => toast.error(e.message || "删除失败"),
  });

  const syncMutation = trpc.forwardGroups.sync.useMutation({
    onSuccess: () => {
      utils.forwardGroups.list.invalidate();
      utils.rules.list.invalidate();
      toast.success("已同步转发组成员规则");
    },
    onError: (e) => toast.error(e.message || "同步失败"),
  });

  const runFailoverMutation = trpc.forwardGroups.runFailover.useMutation({
    onSuccess: () => {
      utils.forwardGroups.list.invalidate();
      toast.success("已执行一次故障转移检查");
    },
    onError: (e) => toast.error(e.message || "执行失败"),
  });

  const availableMemberOptions = form.groupType === "host"
    ? (hosts || []).map((h: any) => ({ id: Number(h.id), label: h.name, meta: h.entryIp || h.ip || "" }))
    : (tunnels || []).map((t: any) => ({
      id: Number(t.id),
      label: t.name,
      meta: getTunnelRouteText(t, hosts),
    }));

  const addMember = (id: number) => {
    if (!id) return;
    const key = memberKey(form.groupType, id);
    if (form.members.some((m) => m.key === key)) {
      toast.error("成员已存在");
      return;
    }
    setForm({
      ...form,
      members: [
        ...form.members,
        {
          key,
          memberType: form.groupType,
          hostId: form.groupType === "host" ? id : null,
          tunnelId: form.groupType === "tunnel" ? id : null,
          isEnabled: true,
        },
      ],
    });
  };

  const removeMember = (key: string) => {
    setForm({ ...form, members: form.members.filter((m) => m.key !== key) });
  };

  const moveMember = (fromKey: string, toKey: string) => {
    if (fromKey === toKey) return;
    const items = [...form.members];
    const from = items.findIndex((m) => m.key === fromKey);
    const to = items.findIndex((m) => m.key === toKey);
    if (from < 0 || to < 0) return;
    const [item] = items.splice(from, 1);
    items.splice(to, 0, item);
    setForm({ ...form, members: items });
  };

  const handleSubmit = () => {
    if (!form.name.trim()) return toast.error("请填写组名称");
    if (form.members.length === 0) return toast.error("请至少添加一个成员");
    const failoverSeconds = Number(form.failoverSeconds);
    const recoverSeconds = Number(form.recoverSeconds);
    if (!Number.isInteger(failoverSeconds) || failoverSeconds < 10 || failoverSeconds > 3600) {
      return toast.error("故障转移时间需为 10-3600 秒的整数");
    }
    if (!Number.isInteger(recoverSeconds) || recoverSeconds < 10 || recoverSeconds > 3600) {
      return toast.error("恢复观察时间需为 10-3600 秒的整数");
    }
    const payload = {
      ...form,
      name: form.name.trim(),
      domain: form.domain.trim() || null,
      failoverSeconds,
      recoverSeconds,
      members: form.members.map((member, index) => ({
        memberType: member.memberType,
        hostId: member.hostId,
        tunnelId: member.tunnelId,
        isEnabled: member.isEnabled,
        priority: index,
      })),
    };
    if (editingId) updateMutation.mutate({ id: editingId, ...payload });
    else createMutation.mutate(payload);
  };

  const groupStatusBadge = (group: any) => {
    if (!group.isEnabled) return <Badge variant="outline">停用</Badge>;
    if (group.lastStatus === "healthy") return <Badge className="border-emerald-500/20 bg-emerald-500/10 text-emerald-600">健康</Badge>;
    if (group.lastStatus === "down") return <Badge variant="destructive">不可用</Badge>;
    if (group.lastStatus === "error") return <Badge variant="destructive">DDNS 异常</Badge>;
    return <Badge variant="secondary">等待检测</Badge>;
  };

  const memberLabel = (member: any) => {
    if (member.memberType === "host") return hostById.get(Number(member.hostId))?.name || `主机 #${member.hostId}`;
    const tunnel = tunnelById.get(Number(member.tunnelId));
    return tunnel ? `${tunnel.name} / ${getTunnelRouteText(tunnel, hosts)}` : `隧道 #${member.tunnelId}`;
  };

  const isPending = createMutation.isPending || updateMutation.isPending;
  const handleViewModeChange = (nextViewMode: ForwardGroupViewMode) => {
    setViewMode(nextViewMode);
    storeForwardGroupViewMode(nextViewMode);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">转发组</h1>
          <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
            管理可故障转移的入口组。
          </p>
        </div>
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:items-center sm:justify-end">
          <Badge variant="outline" className="justify-center gap-1.5 px-3 py-1.5 text-xs">
            <Activity className="h-3 w-3 text-emerald-500" />
            {activeCount} / {groups?.length ?? 0} 健康
          </Badge>
          <Button variant="outline" className="gap-2" onClick={() => runFailoverMutation.mutate()} disabled={runFailoverMutation.isPending}>
            {runFailoverMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            检查
          </Button>
          <div className="hidden items-center overflow-hidden rounded-md border border-border/40 sm:flex">
            <Button
              variant={viewMode === "card" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-none"
              onClick={() => handleViewModeChange("card")}
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === "table" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-none"
              onClick={() => handleViewModeChange("table")}
            >
              <List className="h-4 w-4" />
            </Button>
          </div>
          <Button onClick={openCreate} className="col-span-2 gap-2 sm:col-span-1">
            <Plus className="h-4 w-4" />
            添加转发组
          </Button>
        </div>
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="space-y-3 p-6">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
          </CardContent>
        </Card>
      ) : groups && groups.length > 0 ? (
        <>
        {viewMode === "card" ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {pagedGroups.map((group: any) => (
              <Card key={group.id} className="border-border/40 bg-card/60">
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <p className="min-w-0 truncate font-medium">{group.name}</p>
                        <Badge variant="outline">{group.groupType === "tunnel" ? "隧道组" : "主机组"}</Badge>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{group.lastMessage || "等待检查"}</p>
                    </div>
                    <div className="shrink-0">{groupStatusBadge(group)}</div>
                  </div>

                  <div className="space-y-2 rounded-md bg-muted/25 p-2.5">
                    <div className="text-xs text-muted-foreground">成员优先级</div>
                    <div className="flex flex-wrap gap-1.5">
                      {(group.members || []).length > 0 ? (group.members || []).map((member: any, index: number) => (
                        <span
                          key={member.id}
                          className={`inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${
                            Number(group.activeMemberId) === Number(member.id)
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
                              : "border-border bg-muted/20 text-muted-foreground"
                          }`}
                          title={`${member.healthStatus || "unknown"}${member.lastLatencyMs ? ` / ${member.lastLatencyMs}ms` : ""}`}
                        >
                          {member.healthStatus === "healthy" ? (
                            <CheckCircle2 className="h-3 w-3 shrink-0" />
                          ) : member.healthStatus === "unhealthy" ? (
                            <XCircle className="h-3 w-3 shrink-0" />
                          ) : null}
                          <span className="truncate">{index + 1}. {memberLabel(member)}</span>
                        </span>
                      )) : (
                        <span className="text-xs text-muted-foreground">暂无成员</span>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="min-w-0 rounded-md border border-border/40 bg-background/35 p-2">
                      <p className="text-muted-foreground">DDNS</p>
                      <p className="mt-1 truncate">{group.domain || "未配置"}</p>
                    </div>
                    <div className="min-w-0 rounded-md border border-border/40 bg-background/35 p-2">
                      <p className="text-muted-foreground">引用规则</p>
                      <p className="mt-1">{Number(group.templateRuleCount || 0)}</p>
                    </div>
                  </div>

                  <div className="flex justify-end gap-1 border-t border-border/40 pt-2">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => syncMutation.mutate({ id: group.id })}>
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(group)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => {
                        if (confirm("确定删除此转发组吗？引用它的转发规则会同步清理。")) deleteMutation.mutate({ id: group.id });
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <>
          <div className="grid gap-3 sm:hidden">
            {pagedGroups.map((group: any) => (
              <Card key={group.id} className="border-border/40 bg-card/60">
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <p className="min-w-0 truncate font-medium">{group.name}</p>
                        <Badge variant="outline">{group.groupType === "tunnel" ? "隧道组" : "主机组"}</Badge>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{group.lastMessage || "等待检查"}</p>
                    </div>
                    <div className="shrink-0">{groupStatusBadge(group)}</div>
                  </div>

                  <div className="space-y-2 rounded-md bg-muted/25 p-2.5">
                    <div className="text-xs text-muted-foreground">成员优先级</div>
                    <div className="flex flex-wrap gap-1.5">
                      {(group.members || []).length > 0 ? (group.members || []).map((member: any, index: number) => (
                        <span
                          key={member.id}
                          className={`inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${
                            Number(group.activeMemberId) === Number(member.id)
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
                              : "border-border bg-muted/20 text-muted-foreground"
                          }`}
                          title={`${member.healthStatus || "unknown"}${member.lastLatencyMs ? ` / ${member.lastLatencyMs}ms` : ""}`}
                        >
                          {member.healthStatus === "healthy" ? (
                            <CheckCircle2 className="h-3 w-3 shrink-0" />
                          ) : member.healthStatus === "unhealthy" ? (
                            <XCircle className="h-3 w-3 shrink-0" />
                          ) : null}
                          <span className="truncate">{index + 1}. {memberLabel(member)}</span>
                        </span>
                      )) : (
                        <span className="text-xs text-muted-foreground">暂无成员</span>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="min-w-0 rounded-md border border-border/40 bg-background/35 p-2">
                      <p className="text-muted-foreground">DDNS</p>
                      <p className="mt-1 truncate">{group.domain || "未配置"}</p>
                    </div>
                    <div className="min-w-0 rounded-md border border-border/40 bg-background/35 p-2">
                      <p className="text-muted-foreground">引用规则</p>
                      <p className="mt-1">{Number(group.templateRuleCount || 0)}</p>
                    </div>
                  </div>

                  <div className="flex justify-end gap-1 border-t border-border/40 pt-2">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => syncMutation.mutate({ id: group.id })}>
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(group)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => {
                        if (confirm("确定删除此转发组吗？引用它的转发规则会同步清理。")) deleteMutation.mutate({ id: group.id });
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          <Card className="hidden border-border/40 bg-card/60 sm:block">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>状态</TableHead>
                    <TableHead>名称</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>成员优先级</TableHead>
                    <TableHead className="hidden md:table-cell">DDNS</TableHead>
                    <TableHead className="hidden md:table-cell">引用规则</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pagedGroups.map((group: any) => (
                    <TableRow key={group.id}>
                      <TableCell>{groupStatusBadge(group)}</TableCell>
                      <TableCell>
                        <div className="font-medium">{group.name}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{group.lastMessage || "等待故障转移检查"}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{group.groupType === "tunnel" ? "隧道组" : "主机组"}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex max-w-xs flex-wrap gap-1.5">
                          {(group.members || []).map((member: any, index: number) => (
                            <span
                              key={member.id}
                              className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${
                                Number(group.activeMemberId) === Number(member.id)
                                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
                                  : "border-border bg-muted/20 text-muted-foreground"
                              }`}
                              title={`${member.healthStatus || "unknown"}${member.lastLatencyMs ? ` / ${member.lastLatencyMs}ms` : ""}`}
                            >
                              {member.healthStatus === "healthy" ? (
                                <CheckCircle2 className="h-3 w-3" />
                              ) : member.healthStatus === "unhealthy" ? (
                                <XCircle className="h-3 w-3" />
                              ) : null}
                              {index + 1}. {memberLabel(member)}
                            </span>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <div className="text-sm">{group.domain || "未配置域名"}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{group.lastDdnsValue || "未切换"}</div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">{Number(group.templateRuleCount || 0)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => syncMutation.mutate({ id: group.id })}>
                            <RefreshCw className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(group)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive hover:text-destructive"
                            onClick={() => {
                              if (confirm("确定删除此转发组吗？引用它的转发规则会同步清理。")) deleteMutation.mutate({ id: group.id });
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
          </>
        )}
          <PersistentPagination pagination={groupPagination} itemName="个转发组" />
        </>
      ) : (
        <Card className="border-border/40 bg-card/60">
          <CardContent className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/30">
              <Layers3 className="h-8 w-8 opacity-40" />
            </div>
            <p className="text-lg font-medium">暂无转发组</p>
            <p className="mt-1 text-sm text-muted-foreground/60">创建后可在转发规则中作为高可用入口使用</p>
          </CardContent>
        </Card>
      )}

      <Dialog
        open={showDialog}
        onOpenChange={(open) => {
          if (!open) resetForm();
          setShowDialog(open);
        }}
      >
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{editingId ? "编辑转发组" : "添加转发组"}</DialogTitle>
            <DialogDescription>
              配置入口成员和故障转移。
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>组名称</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如: Web 高可用入口" />
              </div>
              <div className="space-y-2">
                <Label>组类型</Label>
                <Select
                  value={form.groupType}
                  onValueChange={(v) => {
                    const newType = v as GroupType;
                    // Save current members before switching
                    savedMembersRef.current[form.groupType] = form.members;
                    // Restore saved members for the target type (or empty if never added)
                    const restored = savedMembersRef.current[newType] || [];
                    setForm({ ...form, groupType: newType, members: restored });
                  }}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="host">主机端口转发组</SelectItem>
                    <SelectItem value="tunnel">隧道转发组</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_120px]">
              <div className="space-y-2">
                <Label>DDNS 域名</Label>
                <Input value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} placeholder="例如 app.example.com" />
              </div>
              <div className="space-y-2">
                <Label>记录类型</Label>
                <Select value={form.recordType} onValueChange={(v) => setForm({ ...form, recordType: v as any })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="A">A</SelectItem>
                    <SelectItem value="AAAA">AAAA</SelectItem>
                    <SelectItem value="CNAME">CNAME</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">单位：秒，范围 10-3600。</p>
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label>故障转移时间</Label>
                  <Input
                    type="number"
                    min={10}
                    max={3600}
                    value={form.failoverSeconds}
                    onChange={(e) => setForm({ ...form, failoverSeconds: e.target.value })}
                    placeholder="60"
                  />
                </div>
                <div className="space-y-2">
                  <Label>恢复观察时间</Label>
                  <Input
                    type="number"
                    min={10}
                    max={3600}
                    value={form.recoverSeconds}
                    onChange={(e) => setForm({ ...form, recoverSeconds: e.target.value })}
                    placeholder="120"
                  />
                </div>
                <div className="flex items-end gap-4">
                  <label className="flex h-10 flex-1 items-center justify-between rounded-md border border-border/60 px-3">
                    <span className="text-sm">恢复后切回</span>
                    <Switch checked={form.autoFailback} onCheckedChange={(autoFailback) => setForm({ ...form, autoFailback })} />
                  </label>
                  <label className="flex h-10 flex-1 items-center justify-between rounded-md border border-border/60 px-3">
                    <span className="text-sm">启用</span>
                    <Switch checked={form.isEnabled} onCheckedChange={(isEnabled) => setForm({ ...form, isEnabled })} />
                  </label>
                </div>
              </div>
            </div>

            <div className="space-y-3 rounded-lg border border-border/60 p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <Label>成员优先级</Label>
                  <p className="mt-1 text-xs text-muted-foreground">越靠上优先级越高。</p>
                </div>
                <Select onValueChange={(v) => addMember(Number(v))}>
                  <SelectTrigger className="w-full sm:w-64"><SelectValue placeholder={form.groupType === "host" ? "添加主机成员" : "添加隧道成员"} /></SelectTrigger>
                  <SelectContent>
                    {availableMemberOptions.map((item: any) => (
                      <SelectItem key={item.id} value={String(item.id)}>
                        {item.label} {item.meta ? `/ ${item.meta}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                {form.members.map((member, index) => (
                  <div
                    key={member.key}
                    draggable
                    onDragStart={() => setDragMemberKey(member.key)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (dragMemberKey) moveMember(dragMemberKey, member.key);
                      setDragMemberKey(null);
                    }}
                    className="flex items-center gap-3 rounded-md border border-border/60 bg-background/70 px-3 py-2"
                  >
                    <GripVertical className="h-4 w-4 cursor-grab text-muted-foreground" />
                    <span className="flex h-6 w-6 items-center justify-center rounded bg-muted text-xs">{index + 1}</span>
                    {member.memberType === "host" ? <Server className="h-4 w-4 text-primary" /> : <Route className="h-4 w-4 text-primary" />}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{memberLabel(member)}</p>
                    </div>
                    <Switch checked={member.isEnabled} onCheckedChange={(checked) => {
                      setForm({ ...form, members: form.members.map((m) => m.key === member.key ? { ...m, isEnabled: checked } : m) });
                    }} />
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => removeMember(member.key)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
                {form.members.length === 0 && (
                  <div className="rounded-md border border-dashed border-border/70 p-6 text-center text-sm text-muted-foreground">还没有成员</div>
                )}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>取消</Button>
            <Button onClick={handleSubmit} disabled={isPending}>{isPending ? "保存中..." : editingId ? "保存" : "创建"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function ForwardGroupsPage() {
  return (
    <DashboardLayout>
      <ForwardGroupsContent />
    </DashboardLayout>
  );
}
