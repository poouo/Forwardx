import { Network, Route } from "lucide-react";
import type { ComponentType } from "react";

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
    <div className="rounded-lg border border-border/50 bg-muted/25 p-1">
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
              onClick={() => onValueChange(option.value)}
              className={`flex h-10 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-colors ${
                isActive
                  ? "border border-border/60 bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-background/60 hover:text-foreground"
              } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
            >
              <Icon className="h-4 w-4" />
              <span>{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
