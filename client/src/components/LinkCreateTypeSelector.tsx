import { Network, Route } from "lucide-react";
import type { ComponentType } from "react";
import { segmentedControlClassName, segmentedIconClassName, segmentedOptionClassName } from "@/components/ui/segmented";

export type LinkCreateType = "tunnel" | "chain";

type LinkCreateTypeSelectorProps = {
  value: LinkCreateType;
  onValueChange: (value: LinkCreateType) => void;
  canCreateTunnel?: boolean;
  canCreateChain?: boolean;
};

const options: Array<{
  value: LinkCreateType;
  label: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  {
    value: "tunnel",
    label: "隧道链路",
    icon: Network,
  },
  {
    value: "chain",
    label: "端口转发链",
    icon: Route,
  },
];

export default function LinkCreateTypeSelector({
  value,
  onValueChange,
  canCreateTunnel = true,
  canCreateChain = true,
}: LinkCreateTypeSelectorProps) {
  return (
    <div className={segmentedControlClassName}>
      <div className="grid grid-cols-2 gap-1">
        {options.map((option) => {
          const Icon = option.icon;
          const isActive = option.value === value;
          const disabled = option.value === "tunnel" ? !canCreateTunnel : !canCreateChain;
          return (
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              aria-pressed={isActive}
              onClick={() => onValueChange(option.value)}
              className={segmentedOptionClassName(isActive, disabled)}
            >
              <Icon className={segmentedIconClassName(isActive)} />
              <span>{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
