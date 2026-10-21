import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { RulePersonalGroupBadges } from "./RulePersonalGroupBadges";

export function RuleCardMetadata({ routeBadges, protocol, groupIds, groups, path, warning }: {
  routeBadges: ReactNode;
  protocol: string;
  groupIds?: readonly number[];
  groups: readonly { id: number; name: string }[];
  path?: ReactNode;
  warning?: ReactNode;
}) {
  return <div data-rule-card-meta className="min-w-0 space-y-1 text-xs">
    <div data-rule-card-tags className="flex h-5 min-w-0 flex-nowrap items-center gap-1.5">
      <div className="flex min-w-0 shrink items-center gap-1 overflow-hidden">{routeBadges}</div>
      <Badge variant="secondary" className="h-5 shrink-0 whitespace-nowrap px-1.5 text-[10px]">{protocol}</Badge>
      <RulePersonalGroupBadges groupIds={groupIds} groups={groups} maxVisible={1} className="max-w-24" />
    </div>
    {path && <div data-rule-card-path className="h-4 min-w-0 overflow-hidden text-muted-foreground">{path}</div>}
    {warning}
  </div>;
}
