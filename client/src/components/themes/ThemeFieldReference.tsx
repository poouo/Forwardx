import { useState } from "react";
import { Code2, Copy } from "lucide-react";
import { THEME_FIELDS } from "@shared/themeFields";
import { t } from "@/i18n";
import { copyTextToClipboard } from "@/lib/clipboard";
import { toast } from "@/lib/localizedToast";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";

export default function ThemeFieldReference() {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const visible = Object.entries(THEME_FIELDS).filter(([key, field]) => `${key} ${t(field.label)} ${field.scope} ${field.format}`.toLowerCase().includes(search.toLowerCase()));
  const scopeLabel = { host: t("主机卡片"), fleet: t("主机页汇总"), shared: t("公共字段") };
  return <>
    <Button variant="outline" type="button" className="gap-2" onClick={() => setOpen(true)}><Code2 className="h-4 w-4" />{t("字段与布局接口")}</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>{t("字段与布局接口")}</DialogTitle><DialogDescription>{t("在 theme.json 的 views 中配置布局与字段。字段沿用当前账号的数据权限，下载开发模板可查看完整示例。")}</DialogDescription></DialogHeader>
        <Input aria-label={t("搜索主题字段")} placeholder={t("搜索主题字段")} value={search} onChange={event => setSearch(event.target.value)} />
        <div className="max-h-[55svh] overflow-auto rounded-lg border">
          <table className="w-full text-left text-xs"><thead className="sticky top-0 bg-card"><tr><th className="p-3">{t("字段")}</th><th className="p-3">{t("名称")}</th><th className="p-3">{t("格式")}</th><th className="p-3">{t("可用位置")}</th><th className="p-3"><span className="sr-only">{t("复制")}</span></th></tr></thead>
            <tbody>{visible.map(([key, field]) => <tr key={key} className="border-t"><td className="p-3 font-mono">{key}</td><td className="p-3 whitespace-nowrap">{t(field.label)}</td><td className="p-3">{field.format}</td><td className="p-3 whitespace-nowrap">{scopeLabel[field.scope]}</td><td className="p-2"><Button variant="ghost" size="icon" aria-label={`${t("复制")} ${key}`} onClick={async () => {
              const copied = await copyTextToClipboard(JSON.stringify({ type: "field", field: key }, null, 2));
              if (copied) toast.success(t("已复制")); else toast.error(t("复制失败"));
            }}><Copy className="h-3.5 w-3.5" /></Button></td></tr>)}</tbody>
          </table>
          {!visible.length && <p className="p-4 text-sm text-muted-foreground">{t("无匹配字段")}</p>}
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
