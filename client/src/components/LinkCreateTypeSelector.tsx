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
    <div className="rounded-md border border-border/60 bg-muted/25 p-1 shadow-inner shadow-black/5">
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
              className={`flex h-9 items-center justify-center gap-2 rounded-sm border px-3 text-sm font-medium transition-colors ${
                isActive
                  ? "border-primary/60 bg-primary/10 text-primary shadow-md shadow-primary/10 ring-1 ring-primary/25"
                  : "border-transparent text-muted-foreground hover:bg-background/70 hover:text-foreground"
              } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
            >
              <Icon className={`h-4 w-4 ${isActive ? "text-primary" : ""}`} />
              <span>{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
