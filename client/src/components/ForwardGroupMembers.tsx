import type { ReactNode } from "react";
import { t } from "../i18n";

export type ForwardGroupMemberDisplay = {
  id: number | string;
  label: string;
  title?: string;
  active: boolean;
  icon?: ReactNode;
};

// Shared by cards, mobile lists and desktop tables. Parallel entries stay parallel:
// no route arrows or primary/backup roles are inferred from member order.
export function ForwardGroupMembers({ title, entryGroupName, members, compact = false, children }: {
  title: string;
  entryGroupName?: string;
  members: ForwardGroupMemberDisplay[];
  compact?: boolean;
  children?: ReactNode;
}) {
  const visible = compact ? members.slice(0, 2) : members;
  return (
    <div className={compact ? "min-w-0 max-w-xs space-y-2" : "min-w-0 space-y-2 rounded-md bg-muted/25 p-2.5"}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-1.5 text-xs">
        <span className="text-muted-foreground">{title}</span>
        {entryGroupName && <span className="max-w-full truncate rounded border border-border/50 bg-background/35 px-1.5 py-0.5 text-[11px]" title={entryGroupName}>{t("入口组")} · {entryGroupName}</span>}
      </div>
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {visible.map(member => (
          <span key={member.id} title={member.title} className={`inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${member.active
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            : "border-border bg-muted/20 text-muted-foreground"}`}>
            {member.icon}
            <span className="truncate">{member.label}</span>
          </span>
        ))}
        {members.length === 0 && <span className="text-xs text-muted-foreground">{t("暂无成员")}</span>}
        {members.length > visible.length && <span title={members.slice(visible.length).map(member => member.label).join("\n")} className="rounded border border-border bg-muted/20 px-1.5 py-0.5 text-[11px] text-muted-foreground">+{members.length - visible.length}</span>}
      </div>
      {children}
    </div>
  );
}
