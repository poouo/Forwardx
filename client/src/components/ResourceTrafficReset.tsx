import { Loader2, RotateCcw } from "lucide-react";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function ResourceTrafficResetButton({ onClick, disabled = false }: { onClick: () => void; disabled?: boolean }) {
  return <Button type="button" variant="ghost" size="icon" className="h-8 w-8" title={t("重置统计流量")} aria-label={t("重置统计流量")} disabled={disabled} onClick={onClick}><RotateCcw className="h-3.5 w-3.5" /></Button>;
}

export function ResourceTrafficResetDialog({ name, pending, onClose, onConfirm }: {
  name: string | null; pending: boolean; onClose: () => void; onConfirm: () => void;
}) {
  return <Dialog open={name !== null} onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
    <DialogContent className="sm:max-w-md" onEscapeKeyDown={(event) => { if (pending) event.preventDefault(); }} onPointerDownOutside={(event) => { if (pending) event.preventDefault(); }}>
      <DialogHeader>
        <DialogTitle>{t("重置统计流量")}</DialogTitle>
        <DialogDescription>{t("将“{0}”的当日和累计展示流量归零，后续上报重新累计。不影响转发连接、规则用量、用户额度、历史记录或账单。", [name || ""])}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={pending} onClick={onClose}>{t("取消")}</Button>
        <Button type="button" disabled={pending} onClick={onConfirm} aria-busy={pending}>
          <Loader2 className={`h-4 w-4 ${pending ? "animate-spin" : "invisible"}`} aria-hidden="true" />{t("确认重置")}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
