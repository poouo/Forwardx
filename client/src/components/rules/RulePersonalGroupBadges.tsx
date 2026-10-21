import { Folder } from "lucide-react";
import { t } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Group = { id: number; name: string };

/** Presentational only: the page shares one account-scoped group query. */
export function RulePersonalGroupBadges({ groupIds, groups, emptyPlaceholder = false, maxVisible = 2, className }: {
  groupIds?: readonly number[];
  groups: readonly Group[];
  emptyPlaceholder?: boolean;
  maxVisible?: 1 | 2;
  className?: string;
}) {
  const ids = new Set(groupIds);
  const assigned = groups.filter(group => ids.has(group.id));
  if (!assigned.length) return emptyPlaceholder ? <span className="text-muted-foreground">—</span> : null;

  const names = assigned.map(group => group.name).join("、");
  return <span data-rule-personal-groups className={cn("inline-flex min-w-0 max-w-full items-center gap-1 align-middle", className)} title={`${t("所属分组")}: ${names}`}>
    {assigned.slice(0, maxVisible).map(group => <Badge key={group.id} variant="outline" className="h-5 min-w-0 max-w-24 gap-1 border-chart-1/25 bg-chart-1/5 px-1.5 text-[10px] text-chart-1" title={group.name}>
      <Folder className="size-3 shrink-0" aria-hidden="true" /><span className="truncate">{group.name}</span>
    </Badge>)}
    {assigned.length > maxVisible && <Badge variant="secondary" className="h-5 shrink-0 px-1.5 text-[10px]">+{assigned.length - maxVisible}</Badge>}
  </span>;
}
