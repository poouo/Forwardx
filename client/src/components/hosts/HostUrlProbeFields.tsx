import { t } from "@/i18n";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type UrlProbeDraft = { targetUrl: string; timeoutSeconds: number; expectedStatus: number };

export default function HostUrlProbeFields({ value, onChange }: { value: UrlProbeDraft; onChange: (patch: Partial<UrlProbeDraft>) => void }) {
  return <div className="space-y-2.5">
    <div className="min-w-0 space-y-1">
      <Label htmlFor="probe-service-url" className="text-xs" title={t("由主机直接请求，计入 DNS、TCP、TLS 和响应首字节耗时；不复用连接、不跟随重定向。")}>{t("检测 URL")}</Label>
      <Input id="probe-service-url" className="h-9 sm:h-8" type="url" value={value.targetUrl} onChange={event => onChange({ targetUrl: event.target.value })} placeholder="https://example.com/health" />
    </div>
    <div className="grid min-w-0 grid-cols-2 gap-2.5">
      <div className="min-w-0 space-y-1"><Label htmlFor="probe-service-timeout" className="text-xs">{t("超时（秒）")}</Label><Input id="probe-service-timeout" className="h-9 sm:h-8" type="number" min={1} max={30} value={value.timeoutSeconds} onChange={event => onChange({ timeoutSeconds: Number(event.target.value) })} /></div>
      <div className="min-w-0 space-y-1"><Label htmlFor="probe-service-status" className="text-xs">{t("预期状态码")}</Label><Input id="probe-service-status" className="h-9 sm:h-8" type="number" min={200} max={599} value={value.expectedStatus} onChange={event => onChange({ expectedStatus: Number(event.target.value) })} /></div>
    </div>
  </div>;
}
