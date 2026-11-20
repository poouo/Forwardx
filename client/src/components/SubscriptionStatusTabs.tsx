import type { ReactNode } from "react";
import { t } from "@/i18n";
import { SlidingTabsList, type SlidingTabItem } from "@/components/ui/sliding-tabs";
import { Tabs, TabsContent } from "@/components/ui/tabs";

export type SubscriptionListStatus = "active" | "expired";

export function SubscriptionStatusTabs({ value, onChange, children }: {
  value: SubscriptionListStatus;
  onChange: (value: SubscriptionListStatus) => void;
  children: ReactNode;
}) {
  const items: SlidingTabItem<SubscriptionListStatus>[] = [
    { value: "active", label: t("有效期内") },
    { value: "expired", label: t("已过期") },
  ];
  return (
    <Tabs value={value} onValueChange={(next) => { if (next === "active" || next === "expired") onChange(next); }} className="space-y-4">
      <SlidingTabsList items={items} activeValue={value} onValueChange={onChange} ariaLabel={t("订阅状态")} className="sm:max-w-xs" />
      <TabsContent value={value} className="mt-0 space-y-4">{children}</TabsContent>
    </Tabs>
  );
}
