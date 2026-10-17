import { useId } from "react";
import { t } from "../i18n";
import { Label } from "./ui/label";
import { OptimisticSwitch } from "./ui/switch";

type Setting = {
  enabled: boolean;
  unavailable: boolean;
  onChange: (enabled: boolean) => Promise<unknown>;
};

export function PlanManagementSettings({ store, trafficBilling }: { store: Setting; trafficBilling: Setting }) {
  const id = useId();
  const settings = [
    { key: "store", title: t("商店状态"), description: t("开启后用户可自助购买。"), ...store },
    { key: "billing", title: t("按量计费"), description: t("公开计费资源可在余额充足时使用；需授权的资源仍须先授权。"), ...trafficBilling },
  ];
  return (
    <div className="divide-y divide-border/50">
      {settings.map(setting => (
        <div key={setting.key} className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor={`${id}-${setting.key}`}>{setting.title}</Label>
            <p id={`${id}-${setting.key}-help`} className="text-sm text-muted-foreground">{setting.description}</p>
          </div>
          <OptimisticSwitch
            id={`${id}-${setting.key}`}
            aria-describedby={`${id}-${setting.key}-help`}
            checked={setting.enabled}
            disabled={setting.unavailable}
            onCheckedChangeAsync={setting.onChange}
          />
        </div>
      ))}
    </div>
  );
}
