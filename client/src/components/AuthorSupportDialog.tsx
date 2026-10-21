import { ChevronRight, Copy, Heart } from "lucide-react";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export const AUTHOR_SUPPORT_ADDRESSES = [
  { network: "USDT (TRON)", address: "TGCVssNj5v58JPHxPZLLVQXsphQzLqQ3fK" },
  { network: "Solana", address: "8XvFdKNmESquSSJqhYepqqPJkWUqtBXn4jgeDjXyhzHU" },
  { network: "BNB Smart Chain", address: "0x44543FE6C5569Efe2b0Dc13454D4008378c92fE3" },
  { network: "USDT (Polygon)", address: "0x44543FE6C5569Efe2b0Dc13454D4008378c92fE3" },
] as const;

type CopyAddress = (address: string) => void | Promise<void>;

export function AuthorSupportAddresses({ onCopy }: { onCopy: CopyAddress }) {
  return <div className="space-y-3">
    {AUTHOR_SUPPORT_ADDRESSES.map(item => <div key={item.network} className="rounded-xl border border-border/50 bg-muted/20 p-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{item.network}</span>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" title={t("复制地址")} aria-label={`${t("复制地址")} · ${item.network}`} onClick={() => onCopy(item.address)}>
          <Copy className="h-3.5 w-3.5" />
        </Button>
      </div>
      <code className="block select-text break-all text-xs leading-5 text-muted-foreground">{item.address}</code>
    </div>)}
  </div>;
}

export default function AuthorSupportDialog({ onCopy }: { onCopy: CopyAddress }) {
  return <Dialog>
    <DialogTrigger asChild>
      <button type="button" className="flex min-w-0 items-center justify-between rounded-lg border border-border/40 p-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-rose-500/10 text-rose-500"><Heart className="h-4 w-4" /></div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{t("赞助作者")}</p>
            <p className="truncate text-xs text-muted-foreground">{t("给作者充点克劳德")}</p>
          </div>
        </div>
        <ChevronRight className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
    </DialogTrigger>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><Heart className="h-4 w-4 text-rose-500" />{t("赞助作者")}</DialogTitle>
        <DialogDescription>{t("给作者充点克劳德")}</DialogDescription>
      </DialogHeader>
      <AuthorSupportAddresses onCopy={onCopy} />
      <p className="text-xs text-muted-foreground">{t("请确认币种与网络后再转账。")}</p>
    </DialogContent>
  </Dialog>;
}
