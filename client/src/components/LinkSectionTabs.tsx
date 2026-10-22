import { ArrowRightLeft, LogIn, LogOut, Network, Route, ShieldCheck } from "lucide-react";
import { t } from "@/i18n";
import { SlidingTabsList } from "@/components/ui/sliding-tabs";

export const LINK_SECTIONS = ["tunnels", "ports", "chains", "groups", "entries", "exits"] as const;
export type LinkSection = typeof LINK_SECTIONS[number];

const sections = [
  { value: "tunnels", label: "隧道链路", icon: Network },
  { value: "ports", label: "端口转发", icon: ArrowRightLeft },
  { value: "chains", label: "转发链", icon: Route },
  { value: "groups", label: "转发组", icon: ShieldCheck },
  { value: "entries", label: "入口组", icon: LogIn },
  { value: "exits", label: "出口组", icon: LogOut },
] as const;

export function LinkSectionTabs({ activeSection, onSectionChange, counts }: {
  activeSection: LinkSection;
  onSectionChange: (section: LinkSection) => void;
  counts?: Record<LinkSection, number>;
}) {
  return <SlidingTabsList
    items={sections.map(item => ({ ...item, label: t(item.label), badge: counts?.[item.value] ?? null }))}
    activeValue={activeSection}
    onValueChange={onSectionChange}
    ariaLabel={t("链路管理")}
    minItemWidthRem={7.75}
  />;
}
