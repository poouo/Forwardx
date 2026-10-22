import { useEffect, useState } from "react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";

type Props = {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
};

function TimePart({ id, value, count, label, disabled, onChange }: {
  id?: string; value: string; count: number; label: string; disabled?: boolean; onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  return <div className="relative w-[4.5rem]">
    <Input id={id} aria-label={label} type="text" inputMode="numeric" autoComplete="off" maxLength={2} value={draft} disabled={disabled}
      className="pr-7 tabular-nums" onFocus={event => { setEditing(true); event.currentTarget.select(); }}
      onBlur={() => { setEditing(false); setDraft(value); }}
      onChange={event => {
        const next = event.target.value;
        if (!/^\d{0,2}$/.test(next) || (next !== "" && Number(next) >= count)) return;
        setDraft(next);
        if (next !== "") onChange(next.padStart(2, "0"));
      }} />
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger aria-label={label} className="absolute inset-y-0 right-0 h-full w-7 justify-center rounded-l-none border-0 bg-transparent p-1 shadow-none">
        <span className="sr-only">{label}</span>
      </SelectTrigger>
      <SelectContent align="end" sideOffset={6} collisionPadding={12} className="time-picker-options max-h-[min(16rem,var(--radix-select-content-available-height))] min-w-[4.5rem] rounded-xl">
        {Array.from({ length: count }, (_, index) => {
          const option = String(index).padStart(2, "0");
          return <SelectItem key={option} value={option} showIndicator={false} className="justify-center tabular-nums data-[state=checked]:bg-accent data-[state=checked]:font-medium data-[state=checked]:text-primary">{option}</SelectItem>;
        })}
      </SelectContent>
    </Select>
  </div>;
}

export default function TimePicker({ id, value, onChange, disabled, className }: Props) {
  const [hour, minute] = value.split(":");
  const columns = [
    { key: "hours", label: t("小时"), count: 24, value: hour },
    { key: "minutes", label: t("分钟"), count: 60, value: minute },
  ];
  return <div role="group" aria-label={t("选择时间")} className={cn("inline-flex shrink-0 items-center gap-1.5", className)}>
    {columns.map((column, index) => <div key={column.key} className="contents">
      {index > 0 && <span aria-hidden="true" className="text-muted-foreground">:</span>}
      <TimePart id={index === 0 ? id : id ? `${id}-minute` : undefined} value={column.value} count={column.count} label={column.label} disabled={disabled}
        onChange={option => onChange(column.key === "hours" ? `${option}:${minute}` : `${hour}:${option}`)} />
    </div>)}
  </div>;
}
