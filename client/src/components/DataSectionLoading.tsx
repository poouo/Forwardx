import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type DataSectionLoadingProps = {
  label?: string;
  className?: string;
  minHeight?: string;
};

export default function DataSectionLoading({
  label = "数据加载中",
  className,
  minHeight = "min-h-[180px]",
}: DataSectionLoadingProps) {
  return (
    <div
      className={cn(
        "flex w-full items-center justify-center rounded-lg border border-border/40 bg-card/55 text-muted-foreground",
        minHeight,
        className,
      )}
    >
      <div className="flex items-center gap-2 text-sm">
        <Loader2 className="forwardx-icon-spin h-4 w-4 text-primary" />
        <span>{label}</span>
      </div>
    </div>
  );
}
