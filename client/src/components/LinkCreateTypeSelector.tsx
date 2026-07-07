import { ArrowRightLeft, Network, Route } from "lucide-react";
import type { ComponentType, CSSProperties } from "react";
import { segmentedControlClassName, segmentedIconClassName, segmentedOptionClassName } from "@/components/ui/segmented";

export type LinkCreateType = "tunnel" | "port" | "chain";

type LinkCreateTypeSelectorProps = {
  value: LinkCreateType;
  onValueChange: (value: LinkCreateType) => void;
  canCreateTunnel?: boolean;
  canCreatePort?: boolean;
  canCreateChain?: boolean;
  showPort?: boolean;
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
    value: "port",
    label: "端口转发",
    icon: ArrowRightLeft,
  },
  {
    value: "chain",
    label: "转发链",
    icon: Route,
  },
];

export default function LinkCreateTypeSelector({
  value,
  onValueChange,
  canCreateTunnel = true,
  canCreatePort = true,
  canCreateChain = true,
  showPort = true,
}: LinkCreateTypeSelectorProps) {
  return (
    <div className={segmentedControlClassName}>
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-[repeat(var(--link-create-type-count),minmax(0,1fr))]" style={{ "--link-create-type-count": showPort ? 3 : 2 } as CSSProperties}>
        {options.filter((option) => showPort || option.value !== "port").map((option) => {
          const Icon = option.icon;
          const isActive = option.value === value;
          const disabled = option.value === "tunnel"
            ? !canCreateTunnel
            : option.value === "port"
              ? !canCreatePort
              : !canCreateChain;
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
