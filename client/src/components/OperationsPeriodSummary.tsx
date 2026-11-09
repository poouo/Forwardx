import { t } from "@/i18n";

/** Always describes the applied query, not the date fields being edited. */
export default function OperationsPeriodSummary({ from, to }: { from: string; to: string }) {
  const start = from.replaceAll("-", "/"), end = to.replaceAll("-", "/");
  const period = from === to ? start : `${start} – ${end}`;
  return <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
    {t("{0} · 北京时间 · 实际规则流量，不含计费倍率", [period])}
  </p>;
}
