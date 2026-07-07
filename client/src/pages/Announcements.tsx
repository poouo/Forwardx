import { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import DataSectionLoading from "@/components/DataSectionLoading";
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
import { trpc } from "@/lib/trpc";
import { Eye, Megaphone, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

type AnnouncementType = "normal" | "popup" | "upgrade_popup";

type AnnouncementForm = {
  id: number;
  title: string;
  content: string;
  type: AnnouncementType;
  targetVersion: string;
  telegramPush: boolean;
};

const emptyForm: AnnouncementForm = {
  id: 0,
  title: "",
  content: "",
  type: "normal",
  targetVersion: "",
  telegramPush: false,
};

function dateText(value?: string | Date | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function renderAnnouncementHtml(content: string) {
  return { __html: renderMixedHtml(content) };
}

function normalizeVersionText(version: string | null | undefined) {
  return String(version || "").trim().replace(/^v/i, "");
}

function announcementTypeLabel(type: AnnouncementType) {
  if (type === "popup") return "登录弹窗";
  if (type === "upgrade_popup") return "升级公告";
  return "普通公告";
}

function announcementSuccessMessage(action: string, data: any) {
  const push = data?.telegramPush;
  if (!push?.requested) return `公告已${action}`;
  return `公告已${action}，TG 推送 ${push.sent || 0}/${push.total || 0}${push.failed ? `，失败 ${push.failed}` : ""}`;
}

export default function Announcements() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const utils = trpc.useUtils();
  const { data: announcements = [], isLoading } = trpc.announcements.list.useQuery();
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
      toast.success(data?.telegramPush?.requested ? announcementSuccessMessage("创建", data) : "公告已创建");
      setOpen(false);
      setForm(emptyForm);
      invalidateAnnouncementQueries();
    },
    onError: (error) => toast.error(error.message || "创建失败"),
  });

  const updateAnnouncement = trpc.announcements.update.useMutation({
    onSuccess: (data) => {
      toast.success(data?.telegramPush?.requested ? announcementSuccessMessage("更新", data) : "公告已更新");
      setOpen(false);
      setForm(emptyForm);
      invalidateAnnouncementQueries();
    },
    onError: (error) => toast.error(error.message || "更新失败"),
  });

  const deleteAnnouncement = trpc.announcements.delete.useMutation({
    onSuccess: () => {
      toast.success("公告已删除");
      invalidateAnnouncementQueries();
    },
    onError: (error) => toast.error(error.message || "删除失败"),
  });

  const submit = () => {
    const payload = {
      title: form.title.trim(),
      content: form.content.trim(),
      type: form.type,
      targetVersion: form.type === "upgrade_popup" ? form.targetVersion.trim() : null,
      telegramPush: form.telegramPush,
    };
    if (form.id) updateAnnouncement.mutate({ ...payload, id: form.id });
    else createAnnouncement.mutate(payload);
  };

  const edit = (item: any) => {
    const type: AnnouncementType = item.type === "popup" || item.type === "upgrade_popup" ? item.type : "normal";
    setForm({
      id: item.id,
      title: item.title || "",
      content: item.content || "",
      type,
      targetVersion: item.targetVersion || "",
      telegramPush: false,
    });
    setOpen(true);
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{isAdmin ? "公告管理" : "公告"}</h1>
            <p className="text-sm text-muted-foreground">
              {isAdmin ? "管理普通公告、登录弹窗和升级公告。" : "查看管理员发布的公告信息。"}
            </p>
          </div>
          {isAdmin && (
            <Button onClick={() => { setForm(emptyForm); setOpen(true); }}>
              <Plus className="mr-2 h-4 w-4" /> 新增公告
            </Button>
          )}
        </div>

        {isLoading ? (
          <DataSectionLoading label="正在加载公告" />
        ) : (
          <div className="grid gap-4">
            {announcements.map((item: any) => {
              const type: AnnouncementType = item.type === "popup" || item.type === "upgrade_popup" ? item.type : "normal";
              const isPopup = type === "popup";
              const isUpgradePopup = type === "upgrade_popup";
              return (
                <Card key={item.id}>
                  <CardHeader>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <CardTitle className="flex flex-wrap items-center gap-2">
                          <Megaphone className="h-5 w-5" />
                          {item.title}
                          <Badge variant={isPopup || isUpgradePopup ? "default" : "outline"}>{announcementTypeLabel(type)}</Badge>
                        </CardTitle>
                        {isUpgradePopup ? (
                          <CardDescription className="mt-2">
                            目标版本：{item.targetVersion ? `v${normalizeVersionText(item.targetVersion)}` : "-"}
                          </CardDescription>
                        ) : !isPopup ? (
                          <CardDescription className="mt-2">发布时间：{dateText(item.createdAt || item.updatedAt)}</CardDescription>
                        ) : null}
                      </div>
                      {isAdmin && (
                        <div className="flex gap-2">
                          <Button variant="outline" size="icon" onClick={() => edit(item)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" className="text-destructive" onClick={() => deleteAnnouncement.mutate({ id: item.id })}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="text-sm leading-6 text-foreground/85" dangerouslySetInnerHTML={renderAnnouncementHtml(item.content || "")} />
                  </CardContent>
                </Card>
              );
            })}
            {announcements.length === 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>暂无公告</CardTitle>
                  <CardDescription>当前没有可查看的公告。</CardDescription>
                </CardHeader>
              </Card>
            )}
          </div>
        )}

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{form.id ? "编辑公告" : "新增公告"}</DialogTitle>
              <DialogDescription>选择公告展示方式。</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>标题</Label>
                  <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>类型</Label>
                  <Select
                    value={form.type}
                    onValueChange={(type: AnnouncementType) => setForm((current) => ({
                      ...current,
                      type,
                      targetVersion: type === "upgrade_popup" ? current.targetVersion : "",
                    }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="normal">普通公告</SelectItem>
                      <SelectItem value="popup">登录弹窗</SelectItem>
                      <SelectItem value="upgrade_popup">升级公告</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {form.type === "upgrade_popup" && (
                <div className="space-y-2">
                  <Label>目标版本</Label>
                  <Input
                    placeholder="例如 2.3.218"
                    value={form.targetVersion}
                    onChange={(e) => setForm({ ...form, targetVersion: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    仅在用户升级到该版本后，如果该版本配置了升级公告，才会弹出一次。
                  </p>
                </div>
              )}

              <div className="flex flex-col gap-3 rounded-lg border border-border/40 bg-muted/15 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <Label>同步 Telegram 推送</Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    仅发送给已绑定 Telegram 且在个人资料中开启公告推送的用户。
                  </p>
                </div>
                <Switch
                  instant
                  checked={form.telegramPush}
                  onCheckedChange={(telegramPush) => setForm({ ...form, telegramPush })}
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <Label>内容</Label>
                    <p className="mt-1 text-xs text-muted-foreground">支持文字、Markdown 和 HTML。</p>
                  </div>
                  <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => setPreviewOpen(true)} disabled={!form.content.trim()}>
                    <Eye className="h-4 w-4" />
                    预览
                  </Button>
                </div>
                <Textarea
                  id="announcement-content"
                  className="min-h-56 font-mono text-xs leading-5"
                  value={form.content}
                  onChange={(e) => setForm({ ...form, content: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  {form.content.length.toLocaleString()} / 60,000 字符，{describeContentFormat(form.content)}
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
              <Button
                onClick={submit}
                disabled={
                  !form.title.trim() ||
                  !form.content.trim() ||
                  (form.type === "upgrade_popup" && !form.targetVersion.trim()) ||
                  createAnnouncement.isPending ||
                  updateAnnouncement.isPending
                }
              >
                保存
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>公告预览</DialogTitle>
              <DialogDescription>{describeContentFormat(form.content)} 预览。</DialogDescription>
            </DialogHeader>
            <div
              className="max-h-[60svh] overflow-y-auto rounded-lg border bg-background/45 p-4 text-sm leading-6"
              dangerouslySetInnerHTML={renderAnnouncementHtml(form.content)}
            />
            <DialogFooter>
              <Button onClick={() => setPreviewOpen(false)}>关闭</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
