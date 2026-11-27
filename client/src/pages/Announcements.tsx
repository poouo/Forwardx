import { getFormatLocale } from "@/i18n";
import { t as translateText } from "@/i18n";
import { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import DataSectionLoading from "@/components/DataSectionLoading";
import AnnouncementExcerpt from "@/components/AnnouncementExcerpt";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { renderMixedHtml, describeContentFormat } from "@/lib/htmlContent";
import { announcementDateText, isScheduledAnnouncement, toLocalDateTime } from "@/lib/announcementDates";
import { trpc } from "@/lib/trpc";
import { Eye, Megaphone, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "@/lib/localizedToast";

type AnnouncementType = "normal" | "popup";

type AnnouncementForm = {
  id: number;
  title: string;
  content: string;
  type: AnnouncementType;
  publication: "now" | "scheduled" | "published";
  localPublishAt: string;
  telegramPush: boolean;
};

const emptyForm: AnnouncementForm = {
  id: 0,
  title: "",
  content: "",
  type: "normal",
  publication: "now",
  localPublishAt: "",
  telegramPush: false,
};

function renderAnnouncementHtml(content: string) {
  return { __html: renderMixedHtml(content) };
}

function announcementTypeLabel(type: AnnouncementType) {
  if (type === "popup") return translateText("登录弹窗");
  return translateText("普通公告");
}

export default function Announcements() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const utils = trpc.useUtils();
  const { data: announcements = [], isLoading } = trpc.announcements.list.useQuery(undefined, {
    refetchInterval: 15_000,
  });
  const [open, setOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [form, setForm] = useState<AnnouncementForm>(emptyForm);

  const invalidateAnnouncementQueries = () => {
    utils.announcements.list.invalidate();
    utils.announcements.popup.invalidate();
    utils.announcements.upgradePopup.invalidate();
  };

  const createAnnouncement = trpc.announcements.create.useMutation({
    onSuccess: (data) => {
      onSaved(data, false);
    },
    onError: (error) => toast.error(error.message || translateText("创建失败")),
  });

  const updateAnnouncement = trpc.announcements.update.useMutation({
    onSuccess: (data) => {
      onSaved(data, true);
    },
    onError: (error) => toast.error(error.message || translateText("更新失败")),
  });

  function onSaved(data: {
    announcement: (typeof announcements)[number];
    telegramPush: { requested: boolean; sent: number; failed: number; total: number };
  }, updating: boolean) {
    const { announcement, telegramPush: push } = data;
    if (isScheduledAnnouncement(announcement)) {
      toast.success(translateText("公告排期已保存"));
    } else if (push.requested) {
      const action = translateText(updating ? "更新" : "创建");
      toast.success(translateText("公告已{0}，通知推送 {1}/{2}{3}", [action, push.sent, push.total, push.failed ? translateText("，失败 {0}", [push.failed]) : ""]));
    } else {
      toast.success(updating ? translateText("公告已更新") : translateText("公告已发布"));
    }
    setOpen(false);
    invalidateAnnouncementQueries();
  }

  const deleteAnnouncement = trpc.announcements.delete.useMutation({
    onSuccess: () => {
      toast.success(translateText("公告已删除"));
      invalidateAnnouncementQueries();
    },
    onError: (error) => toast.error(error.message || translateText("删除失败")),
  });

  const submit = () => {
    let publishAt: string | null | undefined;
    if (form.publication === "scheduled") {
      const date = new Date(form.localPublishAt);
      if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
        toast.error(translateText("定时发布时间必须晚于当前时间"));
        return;
      }
      publishAt = date.toISOString();
    } else if (form.publication === "now") {
      publishAt = null;
    }
    const payload = {
      title: form.title.trim(),
      content: form.content.trim(),
      type: form.type,
      publishAt,
      telegramPush: form.telegramPush,
    };
    if (form.id) updateAnnouncement.mutate({ ...payload, id: form.id });
    else createAnnouncement.mutate(payload);
  };

  const edit = (item: (typeof announcements)[number]) => {
    const type: AnnouncementType = item.type === "popup" ? "popup" : "normal";
    const scheduled = isScheduledAnnouncement(item);
    setForm({
      id: item.id,
      title: item.title || "",
      content: item.content || "",
      type,
      publication: scheduled ? "scheduled" : "published",
      localPublishAt: scheduled && item.scheduledAt ? toLocalDateTime(item.scheduledAt) : "",
      telegramPush: scheduled && item.pushOnPublish,
    });
    setOpen(true);
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="pearl-page-header flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{isAdmin ? translateText("公告管理") : translateText("公告")}</h1>
          </div>
          {isAdmin && (
            <Button onClick={() => { setForm(emptyForm); setOpen(true); }}>
              <Plus className="mr-2 h-4 w-4" />{translateText(" 新增公告")}</Button>
          )}
        </div>

        {isLoading ? (
          <DataSectionLoading label={translateText("正在加载公告")} />
        ) : (
          <div className="grid gap-4">
            {announcements.map((item) => {
              const type: AnnouncementType = item.type === "popup" ? "popup" : "normal";
              const isPopup = type === "popup";
              const dates = announcementDateText(item);
              return (
                <Card key={item.id} hoverable>
                  <CardHeader>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <CardTitle className="flex flex-wrap items-center gap-2">
                          <Megaphone className="h-5 w-5" />
                          {item.title}
                          <Badge variant={isPopup ? "default" : "outline"}>{announcementTypeLabel(type)}</Badge>
                          {isAdmin && isScheduledAnnouncement(item) && <Badge variant="secondary">{translateText("待发布")}</Badge>}
                          {isAdmin && !item.isActive && <Badge variant="secondary">{translateText("已停用")}</Badge>}
                        </CardTitle>
                        <CardDescription className="mt-2">{dates}</CardDescription>
                      </div>
                      {isAdmin && (
                        <div className="flex gap-2">
                          <Button variant="outline" size="icon" aria-label={translateText("编辑公告")} title={translateText("编辑公告")} onClick={() => edit(item)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" className="text-destructive" aria-label={translateText("删除公告")} title={translateText("删除公告")} onClick={() => deleteAnnouncement.mutate({ id: item.id })}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent>
                    <AnnouncementExcerpt
                      title={item.title || ""}
                      content={item.content || ""}
                      description={dates}
                    />
                  </CardContent>
                </Card>
              );
            })}
            {announcements.length === 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>{translateText("暂无公告")}</CardTitle>
                  <CardDescription>{translateText("当前没有可查看的公告。")}</CardDescription>
                </CardHeader>
              </Card>
            )}
          </div>
        )}

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{form.id ? translateText("编辑公告") : translateText("新增公告")}</DialogTitle>
              <DialogDescription>{translateText("选择公告展示方式。")}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>{translateText("标题")}</Label>
                  <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>{translateText("类型")}</Label>
                  <Select
                    value={form.type}
                    onValueChange={(type: AnnouncementType) => setForm((current) => ({
                      ...current,
                      type,
                    }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="normal">{translateText("普通公告")}</SelectItem>
                      <SelectItem value="popup">{translateText("登录弹窗")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {form.publication !== "published" && (
                <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                  <fieldset className="min-w-0 space-y-2">
                    <legend className="text-sm font-medium">{translateText("发布方式")}</legend>
                    <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
                      {(["now", "scheduled"] as const).map((publication) => (
                        <label key={publication} className="cursor-pointer">
                          <input
                            type="radio"
                            name="announcement-publication"
                            className="peer sr-only"
                            checked={form.publication === publication}
                            onChange={() => setForm((current) => ({ ...current, publication }))}
                          />
                          <span className="block rounded-md px-2 py-1.5 text-center text-sm text-muted-foreground peer-checked:bg-background peer-checked:text-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
                            {publication === "now" ? translateText("立即发布") : translateText("定时发布")}
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  {form.publication === "scheduled" && (
                    <div className="min-w-0 space-y-2">
                      <Label htmlFor="announcement-publish-at">{translateText("计划发布时间")}</Label>
                      <Input
                        id="announcement-publish-at"
                        type="datetime-local"
                        step={1}
                        className="min-w-0 max-w-full"
                        value={form.localPublishAt}
                        onChange={(e) => setForm({ ...form, localPublishAt: e.target.value })}
                      />
                      <p className="break-words text-xs text-muted-foreground">{Intl.DateTimeFormat().resolvedOptions().timeZone}</p>
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-col gap-3 rounded-lg border border-border/40 bg-muted/15 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <Label htmlFor="announcement-push">{form.publication === "scheduled" ? translateText("发布时推送通知") : translateText("同步通知渠道推送")}</Label>
                  <p className="mt-1 text-xs text-muted-foreground">{translateText("仅发送给已绑定所选通知渠道且在个人资料中开启公告推送的用户。")}</p>
                </div>
                <Switch
                  id="announcement-push"
                  checked={form.telegramPush}
                  onCheckedChange={(telegramPush) => setForm({ ...form, telegramPush })}
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <Label>{translateText("内容")}</Label>
                    <p className="mt-1 text-xs text-muted-foreground">{translateText("支持文字、Markdown 和 HTML。")}</p>
                  </div>
                  <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => setPreviewOpen(true)} disabled={!form.content.trim()}>
                    <Eye className="h-4 w-4" />{translateText("预览")}</Button>
                </div>
                <Textarea
                  id="announcement-content"
                  className="min-h-56 font-mono text-xs leading-5"
                  value={form.content}
                  onChange={(e) => setForm({ ...form, content: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  {form.content.length.toLocaleString(getFormatLocale())}{translateText(" / 60,000 字符，")}{describeContentFormat(form.content)}
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>{translateText("取消")}</Button>
              <Button
                onClick={submit}
                disabled={
                  !form.title.trim() ||
                  !form.content.trim() ||
                  (form.publication === "scheduled" && !form.localPublishAt) ||
                  createAnnouncement.isPending ||
                  updateAnnouncement.isPending
                }
              >
                {form.publication === "published"
                  ? translateText("保存")
                  : form.publication === "scheduled" ? translateText("保存排期") : translateText("立即发布")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{translateText("公告预览")}</DialogTitle>
              <DialogDescription>{describeContentFormat(form.content)}{translateText(" 预览。")}</DialogDescription>
            </DialogHeader>
            <div
              className="forwardx-rich-text max-h-[60svh] overflow-y-auto rounded-lg border bg-background/45 p-4 text-sm leading-6"
              dangerouslySetInnerHTML={renderAnnouncementHtml(form.content)}
            />
            <DialogFooter>
              <Button onClick={() => setPreviewOpen(false)}>{translateText("关闭")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
