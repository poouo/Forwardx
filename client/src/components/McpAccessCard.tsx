import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";
import { toast } from "@/lib/localizedToast";
import { copyTextToClipboard } from "@/lib/clipboard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Network } from "lucide-react";
import { mobileAuth } from "@/lib/mobileAuth";

export default function McpAccessCard() {
  const endpoint = `${mobileAuth.getPanelUrl() || (typeof window === "undefined" ? "" : window.location.origin)}/mcp`;
  const tokens = trpc.mcp.tokens.useQuery();
  const [name, setName] = useState(""), [days, setDays] = useState<7 | 30 | 90>(30), [secret, setSecret] = useState("");
  const create = trpc.mcp.createToken.useMutation({ onSuccess: data => { setSecret(data.token); setName(""); void tokens.refetch(); }, onError: error => toast.error(error.message) });
  const revoke = trpc.mcp.revokeToken.useMutation({ onSuccess: () => { void tokens.refetch(); }, onError: error => toast.error(error.message) });
  return <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Network className="size-4 text-primary" />{t("外部 MCP 接口")}</CardTitle>
    <CardDescription>{t("仅管理员可用，让外部 AI 客户端只读查询面板，不提供密码或密钥。普通用户 AI 功能不受影响。")}</CardDescription></CardHeader>
    <CardContent className="space-y-4"><p className="break-all text-sm">{t("接口地址")}：<code>{endpoint}</code></p>
      <p className="text-xs text-muted-foreground">{t("使用 Streamable HTTP 和 Bearer 令牌。外部客户端不会使用面板配置的模型；仅创建令牌后才能访问。请在实际部署的 HTTPS 地址使用。")}</p>
      <div className="flex flex-wrap gap-2"><Input aria-label={t("令牌名称")} className="min-w-0 flex-1" placeholder={t("令牌名称")} value={name} maxLength={80} onChange={event => setName(event.target.value)} />
        <Select value={String(days)} onValueChange={value => setDays(Number(value) as 7 | 30 | 90)}><SelectTrigger className="w-28" aria-label={t("有效期")}><SelectValue /></SelectTrigger><SelectContent>{[7, 30, 90].map(value => <SelectItem key={value} value={String(value)}>{value} {t("天")}</SelectItem>)}</SelectContent></Select>
        <Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate({ name, days })}>{t("创建令牌")}</Button></div>
      {tokens.error && <p role="alert" className="text-sm text-destructive">{tokens.error.message}</p>}
      <div className="max-h-64 space-y-2 overflow-y-auto">{tokens.data?.map(token => <div key={token.id} className="flex items-center justify-between gap-2 rounded-lg border p-3 text-sm"><div className="min-w-0"><p className="truncate">{token.name}</p><p className="text-xs text-muted-foreground">{token.prefix}… · {t("到期时间")} {new Date(Number(token.expiresAt) * 1000).toLocaleDateString()}</p></div><Button size="sm" variant="outline" disabled={revoke.isPending} onClick={() => revoke.mutate({ id: Number(token.id) })}>{t("撤销")}</Button></div>)}</div>
      <Dialog open={!!secret} onOpenChange={open => !open && setSecret("")}><DialogContent><DialogHeader><DialogTitle>{t("保存 MCP 令牌")}</DialogTitle><DialogDescription>{t("只显示这一次，请妥善保存。不要放在链接、截图或公开配置中。")}</DialogDescription></DialogHeader><Input aria-label={t("MCP 令牌")} readOnly value={secret} /><Button onClick={async () => { if (await copyTextToClipboard(secret)) toast.success(t("已复制")); else toast.error(t("复制失败")); }}>{t("复制")}</Button></DialogContent></Dialog>
    </CardContent></Card>;
}
