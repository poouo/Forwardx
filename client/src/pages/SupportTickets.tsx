import { useEffect, useId, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import {
  ArrowLeft,
  Inbox,
  Loader2,
  MessageSquarePlus,
  Paperclip,
  RefreshCw,
  Search,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { t } from "@/i18n";
import { trpc } from "@/lib/trpc";
import { toast } from "@/lib/localizedToast";
import {
  readSupportTicketFiles,
  downloadSupportTicketFile,
} from "@/lib/supportTicketFiles";
import DashboardLayout from "@/components/DashboardLayout";
import DataSectionLoading from "@/components/DataSectionLoading";
import {
  SupportTicketMessage,
  TicketStatusBadge,
  ticketDate,
} from "@/components/SupportTicketMessage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Textarea } from "@/components/ui/textarea";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  TICKET_CATEGORIES,
  TICKET_CATEGORY_LABELS,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_SERVICE_LABELS,
  TICKET_SERVICE_TYPES,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  isTicketFinished,
  type TicketAttachmentInput,
  type TicketCategory,
  type TicketPriority,
  type TicketService,
  type TicketServiceType,
  type TicketStatus,
} from "@shared/supportTickets";

const fail = (error: { message: string }) => toast.error(error.message);
function useDebounced(value: string) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), 300);
    return () => clearTimeout(timer);
  }, [value]);
  return debounced;
}
function useComposer() {
  const [content, setContent] = useState("");
  const [attachments, setAttachments] = useState<TicketAttachmentInput[]>([]);
  const [reading, setReading] = useState(false);
  return {
    content,
    setContent,
    attachments,
    setAttachments,
    reading,
    reset: () => {
      setContent("");
      setAttachments([]);
    },
    add: async (files: File[]) => {
      setReading(true);
      try {
        const next = await readSupportTicketFiles(files, attachments.length);
        setAttachments((current) => [...current, ...next]);
      } catch (error) {
        fail(error as Error);
      } finally {
        setReading(false);
      }
    },
  };
}
function Attachments({
  composer,
  disabled,
}: {
  composer: ReturnType<typeof useComposer>;
  disabled?: boolean;
}) {
  const inputId = useId();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          type="file"
          multiple
          accept=".png,.jpg,.jpeg,.webp,.pdf,.txt,.log"
          className="sr-only"
          disabled={disabled || composer.reading}
          onChange={(event) => {
            const files = Array.from(event.target.files || []);
            event.target.value = "";
            void composer.add(files);
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={
            disabled || composer.reading || composer.attachments.length >= 3
          }
          onClick={() => document.getElementById(inputId)?.click()}
        >
          <Paperclip className="mr-2 h-4 w-4" />
          {t(composer.reading ? "读取中..." : "添加附件")}
        </Button>
        <span className="text-xs text-muted-foreground">
          {t("最多 3 个，每个 2 MB；图片、PDF、TXT/LOG")}
        </span>
      </div>
      {composer.attachments.map((file, index) => (
        <div
          key={`${file.name}-${index}`}
          className="flex min-w-0 items-center gap-2 rounded-md bg-muted/50 px-3 py-1 text-xs"
        >
          <span className="min-w-0 flex-1 break-all">{file.name}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            aria-label={t("移除附件")}
            disabled={disabled || composer.reading}
            onClick={() =>
              composer.setAttachments((current) =>
                current.filter((_, i) => i !== index),
              )
            }
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
    </div>
  );
}
function EnumSelect<T extends string>({
  value,
  onChange,
  values,
  labels,
  label,
  disabled,
  all,
}: {
  value: T | "all";
  onChange: (value: T | "all") => void;
  values: readonly T[];
  labels: Record<T, string>;
  label: string;
  disabled?: boolean;
  all?: boolean;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger aria-label={label} className="min-w-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {all && <SelectItem value="all">{label}</SelectItem>}
        {values.map((v) => (
          <SelectItem key={v} value={v}>
            {t(labels[v])}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
function ServicePicker({
  value,
  onChange,
  disabled,
}: {
  value: TicketService | null;
  onChange: (service: TicketService | null) => void;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [type, setType] = useState<TicketServiceType | "all">("all");
  const [offset, setOffset] = useState(0);
  const debounced = useDebounced(search);
  const services = trpc.supportTickets.services.useQuery(
    { search: debounced, type: type === "all" ? undefined : type, offset },
    { refetchOnWindowFocus: false },
  );
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label>{t("关联服务（可选）")}</Label>
        <Button
          variant="ghost"
          type="button"
          size="sm"
          disabled={disabled}
          onClick={() => setExpanded((v) => !v)}
        >
          {t(expanded ? "收起" : "选择服务")}
        </Button>
      </div>
      <div className="flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-sm">
        <span className="min-w-0 flex-1 break-words">
          {value
            ? `${t(TICKET_SERVICE_LABELS[value.type])} · ${value.name} #${value.id}`
            : t("不关联服务（通用问题）")}
        </span>
        {value && (
          <Button
            variant="ghost"
            type="button"
            size="icon"
            className="h-7 w-7 shrink-0"
            disabled={disabled}
            aria-label={t("清除关联服务")}
            onClick={() => onChange(null)}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
      {expanded && (
        <div className="space-y-2 rounded-md border bg-muted/20 p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <EnumSelect
              value={type}
              onChange={(v) => {
                setType(v);
                setOffset(0);
              }}
              values={TICKET_SERVICE_TYPES}
              labels={TICKET_SERVICE_LABELS}
              label={t("全部服务类型")}
              all
              disabled={disabled}
            />
            <Input
              aria-label={t("搜索服务")}
              placeholder={t("搜索服务")}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setOffset(0);
              }}
              disabled={disabled}
            />
          </div>
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {services.isFetching ? (
              <p className="p-2 text-xs text-muted-foreground">
                {t("加载中...")}
              </p>
            ) : services.error ? (
              <p role="alert" className="p-2 text-xs text-destructive">
                {services.error.message}
              </p>
            ) : !services.data?.items.length ? (
              <p className="p-2 text-xs text-muted-foreground">
                {t("暂无可关联的服务，可以不选择")}
              </p>
            ) : (
              services.data.items.map((service) => (
                <Button
                  key={`${service.type}-${service.id}`}
                  type="button"
                  variant={
                    value?.type === service.type && value.id === service.id
                      ? "secondary"
                      : "ghost"
                  }
                  className="h-auto w-full justify-start whitespace-normal py-2 text-left"
                  disabled={disabled}
                  onClick={() => {
                    onChange(service);
                    setExpanded(false);
                  }}
                >
                  <span className="break-words">
                    {t(TICKET_SERVICE_LABELS[service.type])} · {service.name} #
                    {service.id}
                  </span>
                </Button>
              ))
            )}
          </div>
          <div className="flex justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              type="button"
              disabled={!offset || services.isFetching || disabled}
              onClick={() => setOffset((v) => Math.max(0, v - 50))}
            >
              {t("上一页")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              disabled={
                services.data?.nextOffset == null ||
                services.isFetching ||
                disabled
              }
              onClick={() => setOffset(services.data!.nextOffset!)}
            >
              {t("下一页")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
function CreateTicket({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<TicketCategory>("technical");
  const [priority, setPriority] = useState<TicketPriority>("normal");
  const [service, setService] = useState<TicketService | null>(null);
  const composer = useComposer();
  const mutation = trpc.supportTickets.create.useMutation({
    onSuccess: (result) => {
      toast.success(t("工单已提交"));
      onCreated(result.id);
    },
    onError: fail,
  });
  const busy = mutation.isPending || composer.reading;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto]">
        <DialogHeader>
          <DialogTitle>{t("提交工单")}</DialogTitle>
          <DialogDescription>
            {t(
              "请描述问题和复现步骤；关联服务可留空。请勿上传密码、Token 或其他敏感信息。",
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          id="create-support-ticket"
          className="min-h-0 space-y-4 overflow-y-auto px-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy)
              mutation.mutate({
                title,
                category,
                priority,
                service: service
                  ? { id: service.id, type: service.type }
                  : null,
                content: composer.content,
                attachments: composer.attachments,
              });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="ticket-title">{t("工单标题")}</Label>
            <Input
              id="ticket-title"
              required
              maxLength={160}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>{t("问题分类")}</Label>
              <EnumSelect
                value={category}
                onChange={(v) => setCategory(v as TicketCategory)}
                values={TICKET_CATEGORIES}
                labels={TICKET_CATEGORY_LABELS}
                label={t("问题分类")}
                disabled={busy}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("优先级")}</Label>
              <EnumSelect
                value={priority}
                onChange={(v) => setPriority(v as TicketPriority)}
                values={TICKET_PRIORITIES}
                labels={TICKET_PRIORITY_LABELS}
                label={t("优先级")}
                disabled={busy}
              />
            </div>
          </div>
          <ServicePicker
            value={service}
            onChange={setService}
            disabled={busy}
          />
          <div className="space-y-2">
            <Label htmlFor="ticket-content">{t("问题描述")}</Label>
            <Textarea
              id="ticket-content"
              rows={6}
              maxLength={20000}
              required={!composer.attachments.length}
              value={composer.content}
              onChange={(e) => composer.setContent(e.target.value)}
              disabled={busy}
            />
          </div>
          <Attachments composer={composer} disabled={mutation.isPending} />
        </form>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("取消")}
          </Button>
          <Button
            type="submit"
            form="create-support-ticket"
            disabled={
              busy ||
              !title.trim() ||
              (!composer.content.trim() && !composer.attachments.length)
            }
          >
            {mutation.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            {t("提交工单")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CannedReplies({ onClose }: { onClose: () => void }) {
  const utils = trpc.useUtils();
  const list = trpc.supportTickets.cannedReplies.useQuery();
  const [draft, setDraft] = useState({
    id: undefined as number | undefined,
    title: "",
    content: "",
  });
  const confirm = useConfirmDialog();
  const save = trpc.supportTickets.saveCannedReply.useMutation({
    onError: fail,
    onSuccess: () => {
      setDraft({ id: undefined, title: "", content: "" });
      void utils.supportTickets.cannedReplies.invalidate();
      toast.success(t("已保存"));
    },
  });
  const remove = trpc.supportTickets.deleteCannedReply.useMutation({
    onError: fail,
    onSuccess: (_, variables) => {
      if (draft.id === variables.id)
        setDraft({ id: undefined, title: "", content: "" });
      void utils.supportTickets.cannedReplies.invalidate();
    },
  });
  const busy = save.isPending || remove.isPending;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-w-xl grid-rows-[auto_minmax(0,1fr)_auto]">
        <DialogHeader>
          <DialogTitle>{t("管理快捷回复")}</DialogTitle>
          <DialogDescription>
            {t("所有管理员共享，插入回复后仍需手动发送。")}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto px-1">
          <div className="max-h-48 space-y-2 overflow-y-auto">
            {list.error && <p role="alert">{list.error.message}</p>}
            {list.data?.map((item) => (
              <div
                key={item.id}
                className="flex min-w-0 items-center gap-2 rounded-md border p-2"
              >
                <Button
                  variant="ghost"
                  className="h-auto min-w-0 flex-1 justify-start whitespace-normal text-left"
                  disabled={busy}
                  onClick={() => setDraft(item)}
                >
                  {item.title}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  aria-label={t("删除快捷回复")}
                  disabled={busy}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: t("删除快捷回复"),
                        description: item.title,
                        tone: "destructive",
                      })
                    )
                      remove.mutate({ id: item.id });
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
          <form
            id="support-canned-reply"
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(draft);
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="canned-title">{t("快捷回复名称")}</Label>
              <Input
                id="canned-title"
                maxLength={120}
                required
                value={draft.title}
                onChange={(e) =>
                  setDraft((v) => ({ ...v, title: e.target.value }))
                }
                disabled={busy}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="canned-content">{t("回复内容")}</Label>
              <Textarea
                id="canned-content"
                rows={5}
                maxLength={20000}
                required
                value={draft.content}
                onChange={(e) =>
                  setDraft((v) => ({ ...v, content: e.target.value }))
                }
                disabled={busy}
              />
            </div>
          </form>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setDraft({ id: undefined, title: "", content: "" })}
          >
            {t("新增快捷回复")}
          </Button>
          <Button
            form="support-canned-reply"
            type="submit"
            disabled={busy || !draft.title.trim() || !draft.content.trim()}
          >
            {t("保存")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TicketDetail({
  id,
  admin,
  onBack,
}: {
  id: number;
  admin: boolean;
  onBack: () => void;
}) {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const detail = trpc.supportTickets.detail.useQuery(
    { id },
    { refetchInterval: 30000 },
  );
  const messages = trpc.supportTickets.messages.useInfiniteQuery(
    { id },
    { getNextPageParam: (last) => last.nextCursor, refetchInterval: 30000 },
  );
  const staff = trpc.supportTickets.staff.useQuery(undefined, {
    enabled: admin,
  });
  const canned = trpc.supportTickets.cannedReplies.useQuery(undefined, {
    enabled: admin,
  });
  const composer = useComposer();
  const [internal, setInternal] = useState(false);
  const [replyStatus, setReplyStatus] = useState<TicketStatus>("waiting_user");
  const [rating, setRating] = useState(5);
  const [ratingComment, setRatingComment] = useState("");
  const [downloading, setDownloading] = useState(false);
  const confirm = useConfirmDialog();
  const refresh = () =>
    Promise.all([
      utils.supportTickets.detail.invalidate({ id }),
      utils.supportTickets.messages.invalidate({ id }),
      utils.supportTickets.list.invalidate(),
      utils.supportTickets.summary.invalidate(),
    ]);
  const mutationError = (error: {
    message: string;
    data?: { code?: string } | null;
  }) => {
    fail(error);
    if (error.data?.code === "CONFLICT") void refresh();
  };
  const update = trpc.supportTickets.update.useMutation({
    onError: mutationError,
    onSuccess: () => {
      void refresh();
    },
  });
  const reply = trpc.supportTickets.reply.useMutation({
    onError: mutationError,
    onSuccess: () => {
      composer.reset();
      void refresh();
      toast.success(t(internal ? "内部备注已保存" : "回复已发送"));
    },
  });
  const rate = trpc.supportTickets.rate.useMutation({
    onError: mutationError,
    onSuccess: () => {
      void refresh();
      toast.success(t("感谢您的评价"));
    },
  });
  const remove = trpc.supportTickets.delete.useMutation({
    onError: mutationError,
    onSuccess: () => {
      onBack();
      void utils.supportTickets.invalidate();
      toast.success(t("工单记录已删除"));
    },
  });
  const lastRead = useRef(0);
  const markRead = trpc.supportTickets.markRead.useMutation({
    onSuccess: () => {
      void utils.supportTickets.summary.invalidate();
      void utils.supportTickets.list.invalidate();
    },
    onError: () => {
      lastRead.current = 0;
    },
  });
  const seenVersion = messages.data?.pages[0]?.seenVersion;
  useEffect(() => {
    if (seenVersion && !messages.isFetching && seenVersion > lastRead.current) {
      lastRead.current = seenVersion;
      markRead.mutate({ id, version: seenVersion });
    }
  }, [id, seenVersion, messages.isFetching]);
  const ticket = detail.data;
  const busy =
    update.isPending ||
    reply.isPending ||
    rate.isPending ||
    remove.isPending ||
    composer.reading;
  const change = (patch: {
    status?: TicketStatus;
    priority?: TicketPriority;
    category?: TicketCategory;
    assignedTo?: number | null;
  }) => {
    if (ticket && !busy)
      update.mutate({ id, version: ticket.version, ...patch });
  };
  const download = async (attachmentId: number) => {
    setDownloading(true);
    try {
      downloadSupportTicketFile(
        await utils.supportTickets.attachment.fetch({ id: attachmentId }),
      );
    } catch (error) {
      fail(error as Error);
    } finally {
      setDownloading(false);
    }
  };
  if (detail.isLoading) return <DataSectionLoading />;
  if (!ticket || detail.error)
    return (
      <Card>
        <CardContent className="space-y-4 pt-6">
          <p role="alert">
            {detail.error?.message || t("工单不存在或无权访问")}
          </p>
          <Button variant="outline" onClick={onBack}>
            {t("返回工单列表")}
          </Button>
        </CardContent>
      </Card>
    );
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t("返回工单列表")}
        </Button>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            aria-label={t("刷新工单")}
            disabled={detail.isFetching || messages.isFetching || busy}
            onClick={() => void refresh()}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          {isTicketFinished(ticket.status) ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => change({ status: "open" })}
            >
              {t("重新打开")}
            </Button>
          ) : (
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                if (
                  await confirm({
                    title: t("关闭工单"),
                    description: t(
                      "关闭后仍可查看历史记录，必要时可重新打开。",
                    ),
                  })
                )
                  change({ status: "closed" });
              }}
            >
              {t("关闭工单")}
            </Button>
          )}
        </div>
      </div>
      <Card disableEnterAnimation>
        <CardHeader>
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
            <CardTitle className="min-w-0 flex-1 basis-48 [overflow-wrap:anywhere]">
              #{ticket.id} · {ticket.title}
            </CardTitle>
            <TicketStatusBadge status={ticket.status} />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              {t("创建时间")}：{ticketDate(ticket.createdAt)}
            </span>
            <span>
              {t("最近更新")}：{ticketDate(ticket.updatedAt)}
            </span>
            {ticket.firstResponseAt && (
              <span>
                {t("首次回复")}：{ticketDate(ticket.firstResponseAt)}
              </span>
            )}
            {admin && (
              <span>
                {t("提交用户")}：{ticket.ownerName || `#${ticket.userId}`}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="break-words text-sm text-muted-foreground">
            {t("关联服务")}：
            {ticket.serviceType
              ? `${t(TICKET_SERVICE_LABELS[ticket.serviceType])} · ${ticket.serviceName}${ticket.serviceId ? ` #${ticket.serviceId}` : ""}`
              : t("不关联服务（通用问题）")}
          </p>
          {admin ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-1">
                <Label>{t("状态")}</Label>
                <EnumSelect
                  value={ticket.status}
                  onChange={(v) => change({ status: v as TicketStatus })}
                  values={TICKET_STATUSES}
                  labels={TICKET_STATUS_LABELS}
                  label={t("状态")}
                  disabled={busy}
                />
              </div>
              <div className="space-y-1">
                <Label>{t("优先级")}</Label>
                <EnumSelect
                  value={ticket.priority}
                  onChange={(v) => change({ priority: v as TicketPriority })}
                  values={TICKET_PRIORITIES}
                  labels={TICKET_PRIORITY_LABELS}
                  label={t("优先级")}
                  disabled={busy}
                />
              </div>
              <div className="space-y-1">
                <Label>{t("问题分类")}</Label>
                <EnumSelect
                  value={ticket.category}
                  onChange={(v) => change({ category: v as TicketCategory })}
                  values={TICKET_CATEGORIES}
                  labels={TICKET_CATEGORY_LABELS}
                  label={t("问题分类")}
                  disabled={busy}
                />
              </div>
              <div className="space-y-1">
                <Label>{t("处理人")}</Label>
                <Select
                  value={ticket.assignedTo ? String(ticket.assignedTo) : "none"}
                  onValueChange={(v) =>
                    change({ assignedTo: v === "none" ? null : Number(v) })
                  }
                  disabled={busy}
                >
                  <SelectTrigger aria-label={t("处理人")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t("未指派")}</SelectItem>
                    {staff.data?.map((s) => (
                      <SelectItem key={s.id} value={String(s.id)}>
                        {s.name || `#${s.id}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary" className="shrink-0 whitespace-nowrap">
                {t(TICKET_CATEGORY_LABELS[ticket.category])}
              </Badge>
              <Badge variant="outline" className="shrink-0 whitespace-nowrap">
                {t("优先级")}：{t(TICKET_PRIORITY_LABELS[ticket.priority])}
              </Badge>
            </div>
          )}
        </CardContent>
      </Card>
      <Card disableEnterAnimation>
        <CardHeader>
          <CardTitle>{t("沟通记录")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {messages.error && (
            <div role="alert" className="text-sm text-destructive">
              {messages.error.message}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void messages.refetch()}
              >
                {t("重试")}
              </Button>
            </div>
          )}
          {messages.hasNextPage && (
            <Button
              variant="outline"
              className="w-full"
              disabled={messages.isFetchingNextPage}
              onClick={() => void messages.fetchNextPage()}
            >
              {t("加载更早的记录")}
            </Button>
          )}
          {messages.isLoading && <DataSectionLoading />}
          {messages.data?.pages
            .slice()
            .reverse()
            .flatMap((page) => page.items)
            .map((message) => (
              <SupportTicketMessage
                key={message.id}
                message={message}
                staffNames={Object.fromEntries(
                  (staff.data || []).map((s) => [s.id, s.name]),
                )}
                onDownload={(id) => void download(id)}
                downloading={downloading}
              />
            ))}
        </CardContent>
      </Card>
      {(ticket.status !== "closed" || admin) && (
        <Card disableEnterAnimation>
          <CardHeader>
            <CardTitle>{t(internal ? "内部备注" : "回复工单")}</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (!busy)
                  reply.mutate({
                    id,
                    version: ticket.version,
                    content: composer.content,
                    attachments: composer.attachments,
                    internal,
                    status: admin && !internal ? replyStatus : undefined,
                  });
              }}
            >
              {admin && (
                <div className="flex flex-wrap items-center gap-3">
                  <Select
                    value={internal ? "internal" : "public"}
                    onValueChange={(v) => setInternal(v === "internal")}
                    disabled={busy}
                  >
                    <SelectTrigger
                      className="w-full sm:w-44"
                      aria-label={t("回复可见性")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="public">{t("回复用户")}</SelectItem>
                      <SelectItem value="internal">{t("内部备注")}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value="placeholder"
                    onValueChange={(v) => {
                      const item = canned.data?.find((c) => c.id === Number(v));
                      if (item)
                        composer.setContent((current) =>
                          current
                            ? `${current}\n\n${item.content}`
                            : item.content,
                        );
                    }}
                    disabled={busy || !canned.data?.length}
                  >
                    <SelectTrigger
                      className="w-full sm:w-52"
                      aria-label={t("插入快捷回复")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="placeholder" disabled>
                        {t("插入快捷回复")}
                      </SelectItem>
                      {canned.data?.map((c) => (
                        <SelectItem key={c.id} value={String(c.id)}>
                          {c.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {internal && (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  {t("仅管理员可见，不会通知用户，也不会更改工单状态。")}
                </p>
              )}
              {ticket.status === "closed" && !internal && (
                <p className="text-xs text-muted-foreground">
                  {t("工单已关闭，请先重新打开再回复")}
                </p>
              )}
              <Textarea
                aria-label={t("回复内容")}
                rows={5}
                maxLength={20000}
                value={composer.content}
                onChange={(e) => composer.setContent(e.target.value)}
                disabled={busy}
                required={!composer.attachments.length}
              />
              <Attachments composer={composer} disabled={busy} />
              <div className="flex flex-wrap items-center justify-end gap-3">
                {admin && !internal && (
                  <div className="w-full sm:w-48">
                    <EnumSelect
                      value={replyStatus}
                      onChange={(v) => setReplyStatus(v as TicketStatus)}
                      values={TICKET_STATUSES}
                      labels={TICKET_STATUS_LABELS}
                      label={t("回复后状态")}
                      disabled={busy}
                    />
                  </div>
                )}
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    messages.isLoading ||
                    !!messages.error ||
                    (!internal && ticket.status === "closed") ||
                    (!composer.content.trim() && !composer.attachments.length)
                  }
                >
                  {reply.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  {t(internal ? "保存内部备注" : "发送回复")}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
      {isTicketFinished(ticket.status) && (
        <Card disableEnterAnimation>
          <CardHeader>
            <CardTitle>{t("处理评价")}</CardTitle>
          </CardHeader>
          <CardContent>
            {ticket.rating ? (
              <div className="space-y-2">
                <p className="flex items-center gap-2">
                  <Star className="h-4 w-4 text-amber-500" />
                  {ticket.rating} / 5
                </p>
                {ticket.ratingComment && (
                  <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
                    {ticket.ratingComment}
                  </p>
                )}
              </div>
            ) : Number(ticket.userId) === user?.id ? (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  rate.mutate({
                    id,
                    version: ticket.version,
                    rating,
                    comment: ratingComment,
                  });
                }}
              >
                <Select
                  value={String(rating)}
                  onValueChange={(v) => setRating(Number(v))}
                  disabled={busy}
                >
                  <SelectTrigger aria-label={t("满意度评分")} className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[5, 4, 3, 2, 1].map((v) => (
                      <SelectItem key={v} value={String(v)}>
                        {v} / 5
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Textarea
                  aria-label={t("评价说明（可选）")}
                  placeholder={t("评价说明（可选）")}
                  maxLength={1000}
                  value={ratingComment}
                  onChange={(e) => setRatingComment(e.target.value)}
                  disabled={busy}
                />
                <Button type="submit" disabled={busy}>
                  {t("提交评价")}
                </Button>
              </form>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("用户尚未评价")}
              </p>
            )}
          </CardContent>
        </Card>
      )}
      {admin && ticket.status === "closed" && (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            className="text-destructive"
            disabled={busy}
            onClick={async () => {
              if (
                await confirm({
                  title: t("删除工单记录"),
                  description: t(
                    "将永久删除工单 #{0} 的所有回复、内部备注和附件，无法恢复。",
                    [id],
                  ),
                  tone: "destructive",
                })
              )
                remove.mutate({ id, version: ticket.version });
            }}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {t("删除工单记录")}
          </Button>
        </div>
      )}
    </div>
  );
}

function TicketList({
  admin,
  onOpen,
  onCreate,
}: {
  admin: boolean;
  onOpen: (id: number) => void;
  onCreate: () => void;
}) {
  const utils = trpc.useUtils();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<TicketStatus | "all">("all");
  const [priority, setPriority] = useState<TicketPriority | "all">("all");
  const [category, setCategory] = useState<TicketCategory | "all">("all");
  const [assigned, setAssigned] = useState("all");
  const [unread, setUnread] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [cannedOpen, setCannedOpen] = useState(false);
  const debounced = useDebounced(search);
  const list = trpc.supportTickets.list.useQuery(
    {
      page,
      search: debounced,
      status: status === "all" ? undefined : status,
      priority: priority === "all" ? undefined : priority,
      category: category === "all" ? undefined : category,
      assigned:
        assigned === "all" ? undefined : (assigned as "me" | "unassigned"),
      unread,
    },
    { refetchInterval: 30000 },
  );
  const summary = trpc.supportTickets.summary.useQuery(undefined, {
    refetchInterval: 30000,
  });
  const confirm = useConfirmDialog();
  const bulk = trpc.supportTickets.bulkStatus.useMutation({
    onError: (error) => {
      fail(error);
      void list.refetch();
    },
    onSuccess: () => {
      setSelected([]);
      void utils.supportTickets.invalidate();
      toast.success(t("工单已更新"));
    },
  });
  useEffect(() => {
    setSelected([]);
  }, [page, debounced, status, priority, category, assigned, unread]);
  useEffect(() => {
    const last = Math.max(1, Math.ceil((list.data?.total || 0) / 20));
    if (list.data && page > last) setPage(last);
  }, [list.data?.total, page]);
  const doBulk = async (next: TicketStatus) => {
    const tickets =
      list.data?.items
        .filter((item) => selected.includes(item.id))
        .map((item) => ({ id: item.id, version: item.version })) || [];
    if (
      tickets.length &&
      (await confirm({
        title: t("批量更新工单"),
        description: t("将 {0} 个工单设为「{1}」？", [
          tickets.length,
          t(TICKET_STATUS_LABELS[next]),
        ]),
      }))
    )
      bulk.mutate({ tickets, status: next });
  };
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">{t("工单支持")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(
              admin
                ? "处理用户问题，跟进服务与账务请求。"
                : "提交问题、跟进回复和查看处理进度。",
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {admin && (
            <Button variant="outline" onClick={() => setCannedOpen(true)}>
              {t("管理快捷回复")}
            </Button>
          )}
          <Button onClick={onCreate}>
            <MessageSquarePlus className="mr-2 h-4 w-4" />
            {t("提交工单")}
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {TICKET_STATUSES.map((value) => (
          <button
            key={value}
            type="button"
            className={`min-w-0 rounded-xl border p-3 text-left ${status === value ? "border-primary/40 bg-primary/5" : "border-border bg-card"}`}
            onClick={() => {
              setStatus((current) => (current === value ? "all" : value));
              setPage(1);
            }}
          >
            <span className="text-xs text-muted-foreground">
              {t(TICKET_STATUS_LABELS[value])}
            </span>
            <div className="mt-1 text-xl font-semibold tabular-nums">
              {summary.data?.statuses[value] || 0}
            </div>
          </button>
        ))}
        <button
          type="button"
          className={`rounded-xl border p-3 text-left ${unread ? "border-primary/40 bg-primary/5" : "border-border bg-card"}`}
          onClick={() => {
            setUnread((v) => !v);
            setPage(1);
          }}
        >
          <span className="text-xs text-muted-foreground">{t("未读工单")}</span>
          <div className="mt-1 text-xl font-semibold tabular-nums">
            {summary.data?.unread || 0}
          </div>
        </button>
      </div>
      <Card disableEnterAnimation>
        <CardContent className="space-y-4 pt-5">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
            <div className="relative">
              <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                aria-label={t("搜索工单")}
                placeholder={t("搜索标题、编号或服务")}
                className="pl-9"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <EnumSelect
              value={status}
              onChange={(v) => {
                setStatus(v);
                setPage(1);
              }}
              values={TICKET_STATUSES}
              labels={TICKET_STATUS_LABELS}
              label={t("全部状态")}
              all
            />
            <EnumSelect
              value={priority}
              onChange={(v) => {
                setPriority(v);
                setPage(1);
              }}
              values={TICKET_PRIORITIES}
              labels={TICKET_PRIORITY_LABELS}
              label={t("全部优先级")}
              all
            />
            <EnumSelect
              value={category}
              onChange={(v) => {
                setCategory(v);
                setPage(1);
              }}
              values={TICKET_CATEGORIES}
              labels={TICKET_CATEGORY_LABELS}
              label={t("全部分类")}
              all
            />
            {admin ? (
              <Select
                value={assigned}
                onValueChange={(v) => {
                  setAssigned(v);
                  setPage(1);
                }}
              >
                <SelectTrigger aria-label={t("处理人筛选")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("全部处理人")}</SelectItem>
                  <SelectItem value="me">{t("指派给我")}</SelectItem>
                  <SelectItem value="unassigned">{t("未指派")}</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <Button
                variant={unread ? "secondary" : "outline"}
                onClick={() => {
                  setUnread((v) => !v);
                  setPage(1);
                }}
              >
                {t("仅看未读")}
              </Button>
            )}
          </div>
          {admin && (
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex shrink-0 items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  aria-label={t("选择本页工单")}
                  checked={
                    !!list.data?.items.length &&
                    list.data.items.every((t) => selected.includes(t.id))
                  }
                  disabled={bulk.isPending || !list.data?.items.length}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked ? list.data!.items.map((t) => t.id) : [],
                    )
                  }
                />
                {t("选择本页")}
              </label>
              <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                {t("已选 {0} 个", [selected.length])}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={!selected.length || bulk.isPending}
                onClick={() => void doBulk("resolved")}
              >
                {t("标记已解决")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!selected.length || bulk.isPending}
                onClick={() => void doBulk("closed")}
              >
                {t("批量关闭")}
              </Button>
            </div>
          )}
          {list.isLoading ? (
            <DataSectionLoading />
          ) : list.error ? (
            <div role="alert" className="text-sm text-destructive">
              {list.error.message}
              <Button variant="ghost" onClick={() => void list.refetch()}>
                {t("重试")}
              </Button>
            </div>
          ) : !list.data?.items.length ? (
            <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
              <Inbox className="h-9 w-9" />
              <p className="text-sm">{t("暂无工单")}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {list.data.items.map((ticket) => (
                <div
                  key={ticket.id}
                  className="flex min-w-0 items-start gap-3 rounded-xl border border-border bg-background/40 p-3 hover:border-primary/30"
                >
                  {admin && (
                    <input
                      type="checkbox"
                      aria-label={t("选择工单 #{0}", [ticket.id])}
                      className="mt-1 shrink-0"
                      checked={selected.includes(ticket.id)}
                      disabled={bulk.isPending}
                      onChange={(e) =>
                        setSelected((ids) =>
                          e.target.checked
                            ? [...ids, ticket.id]
                            : ids.filter((id) => id !== ticket.id),
                        )
                      }
                    />
                  )}
                  <button
                    type="button"
                    className="min-w-0 flex-1 space-y-2 text-left"
                    onClick={() => onOpen(ticket.id)}
                  >
                    <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                      <span className="min-w-0 flex-1 basis-48 break-words text-sm font-semibold">
                        {ticket.unread && (
                          <span
                            className="mr-2 inline-block h-2 w-2 rounded-full bg-primary"
                            aria-label={t("未读")}
                          />
                        )}
                        #{ticket.id} · {ticket.title}
                      </span>
                      <TicketStatusBadge status={ticket.status} />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>{t(TICKET_CATEGORY_LABELS[ticket.category])}</span>
                      <span
                        className={
                          ticket.priority === "urgent" ||
                          ticket.priority === "high"
                            ? "text-destructive"
                            : ""
                        }
                      >
                        {t(TICKET_PRIORITY_LABELS[ticket.priority])}
                      </span>
                      {ticket.serviceType && (
                        <span className="break-words">
                          {t(TICKET_SERVICE_LABELS[ticket.serviceType])} ·{" "}
                          {ticket.serviceName}
                        </span>
                      )}
                      {admin && (
                        <span className="break-words">
                          {ticket.ownerName || `#${ticket.userId}`}
                        </span>
                      )}
                      <time>{ticketDate(ticket.updatedAt)}</time>
                    </div>
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              {t("共 {0} 个工单", [list.data?.total || 0])}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1 || list.isFetching}
                onClick={() => setPage((v) => v - 1)}
              >
                {t("上一页")}
              </Button>
              <span className="whitespace-nowrap text-xs tabular-nums">
                {page} / {Math.max(1, Math.ceil((list.data?.total || 0) / 20))}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={
                  page * 20 >= (list.data?.total || 0) || list.isFetching
                }
                onClick={() => setPage((v) => v + 1)}
              >
                {t("下一页")}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
      {cannedOpen && <CannedReplies onClose={() => setCannedOpen(false)} />}
    </div>
  );
}

export default function SupportTickets() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const search = useSearch();
  const ticketId = Number(new URLSearchParams(search).get("ticket"));
  const status = trpc.supportTickets.status.useQuery(undefined, {
    enabled: !!user,
    refetchOnWindowFocus: true,
  });
  const utils = trpc.useUtils();
  const [creating, setCreating] = useState(false);
  const open = (id: number) => navigate(`/tickets?ticket=${id}`);
  return (
    <DashboardLayout>
      {status.isLoading ? (
        <DataSectionLoading />
      ) : status.error ? (
        <Card>
          <CardContent className="pt-6">
            <p role="alert">{status.error.message}</p>
            <Button variant="outline" onClick={() => void status.refetch()}>
              {t("重试")}
            </Button>
          </CardContent>
        </Card>
      ) : !status.data?.enabled ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("工单系统未开启")}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {t("管理员可在系统设置的侧边栏入口中开启工单支持。")}
          </CardContent>
        </Card>
      ) : (
        <>
          {Number.isSafeInteger(ticketId) && ticketId > 0 ? (
            <TicketDetail
              key={ticketId}
              id={ticketId}
              admin={user?.role === "admin"}
              onBack={() => navigate("/tickets")}
            />
          ) : (
            <TicketList
              admin={user?.role === "admin"}
              onOpen={open}
              onCreate={() => setCreating(true)}
            />
          )}
          {creating && (
            <CreateTicket
              onClose={() => setCreating(false)}
              onCreated={(id) => {
                setCreating(false);
                void utils.supportTickets.invalidate();
                open(id);
              }}
            />
          )}
        </>
      )}
    </DashboardLayout>
  );
}
