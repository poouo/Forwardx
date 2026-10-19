import { t } from "@/i18n";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { hostAddressOptions } from "@shared/hostAddresses";

export default function HostAddressSelectors({ host, preferredIpv4, preferredIpv6, onChange }: {
  host: any; preferredIpv4: string; preferredIpv6: string;
  onChange: (field: "preferredIpv4" | "preferredIpv6", value: string) => void;
}) {
  return <div className="space-y-2 sm:col-span-2">
    <Label className="text-sm">{t("Agent 检测 IP")}</Label>
    <div className="grid min-w-0 gap-2.5 sm:grid-cols-2">
      {(["ipv4", "ipv6"] as const).map(family => {
        const field = family === "ipv4" ? "preferredIpv4" : "preferredIpv6";
        const preferred = family === "ipv4" ? preferredIpv4 : preferredIpv6;
        const options = hostAddressOptions(host, family);
        const unavailable = !!preferred && !options.includes(preferred);
        return <div className="min-w-0 space-y-1" key={family}>
          <Label htmlFor={`host-primary-${family}`} className="text-xs text-muted-foreground">{family === "ipv4" ? t("IPv4 主 IP") : t("IPv6 主 IP")}</Label>
          <Select value={preferred || "auto"} onValueChange={value => onChange(field, value === "auto" ? "" : value)} disabled={!host?.id || !options.length && !preferred}>
            <SelectTrigger id={`host-primary-${family}`} className="h-8 min-w-0"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t("自动（当前：{0}）", [host?.[family] || t("未检测到")])}</SelectItem>
              {options.map(ip => <SelectItem key={ip} value={ip}>{ip}</SelectItem>)}
              {unavailable && <SelectItem value={preferred} disabled>{t("{0}（未检测到，已回退）", [preferred])}</SelectItem>}
            </SelectContent>
          </Select>
        </div>;
      })}
    </div>
    <p className="text-xs text-muted-foreground">{t("分别选择面板使用的主 IP；不修改主机网卡或出站路由，手动入口地址仍优先使用。多 IP 探测需要更新 Agent。")}</p>
  </div>;
}
