import { t } from "@/i18n";
import { normalizeLoadValue, type HostLoadMetric } from "../../../../shared/hostLoad";

export default function HostLoad({ metric, className = "", showLabel = true }: {
  metric?: HostLoadMetric | null;
  className?: string;
  showLabel?: boolean;
}) {
  return (
    <div className={`flex items-center gap-1.5 whitespace-nowrap text-[11px] ${className}`}>
      {showLabel && <span className="text-muted-foreground">{t("负载")}</span>}
      <span className="inline-flex items-center gap-2 font-medium tabular-nums">
        {[metric?.load1, metric?.load5, metric?.load15].map((value, index) => (
          <span key={index}>{normalizeLoadValue(value)?.toFixed(2) ?? "—"}</span>
        ))}
      </span>
    </div>
  );
}
