import { useEffect, useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { t } from "@/i18n";
import { Button } from "./ui/button";
import { requestBillingExport } from "@/lib/billingExport";
import { downloadBlobFile } from "@/lib/fileDownload";
import { toast } from "@/lib/localizedToast";

export default function BillingExportButton({ userId }: { userId?: number }) {
  const [pending, setPending] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const exportLedger = async () => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    try {
      const { blob, filename } = await requestBillingExport(userId, controller.signal);
      if (!controller.signal.aborted) downloadBlobFile(filename, blob);
    } catch (error) {
      if (!controller.signal.aborted) toast.error(error instanceof Error ? error.message : t("账单导出失败，请稍后重试"));
    } finally {
      if (!controller.signal.aborted) setPending(false);
      if (active.current === controller) active.current = null;
    }
  };
  return <Button type="button" variant="outline" size="sm" disabled={pending} aria-busy={pending}
    onClick={() => void exportLedger()} title={t("导出当前筛选的全部流水")}>
    {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
    {pending ? t("正在导出") : t("导出 Excel")}
  </Button>;
}
