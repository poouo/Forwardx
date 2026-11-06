import { useEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, Copy } from "lucide-react";
import { t } from "@/i18n";
import { partitionRuleEntryAddresses, type RuleEntryAddress } from "@/lib/ruleEntryDisplay";
import { cn } from "@/lib/utils";
import { useOverlayContainer } from "@/components/ui/overlay-root";

type DisplayEntry = RuleEntryAddress & { text: string; copyable: boolean };

/** Hover reveals secondary addresses; the trigger also works with touch/keyboard. */
export function RuleEntryAddresses({ entries, onCopy, compact = false, table = false }: {
  entries: readonly DisplayEntry[];
  onCopy: (value: string) => void | Promise<void>;
  compact?: boolean;
  table?: boolean;
}) {
  const { visible, hidden } = partitionRuleEntryAddresses(entries);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const openedViaHover = useRef(false);
  const container = useOverlayContainer();
  const cancelClose = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
  };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const closeSoon = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 200);
  };
  const entryButton = (entry: DisplayEntry, showLabel: boolean, popup = false) => {
    const copyLabel = entry.copyable ? t("复制入口地址: {0}", [entry.text]) : entry.text;
    return <button
      key={`${entry.label}:${entry.value}`}
      type="button"
      onClick={() => { if (entry.copyable) void onCopy(entry.value); }}
      disabled={!entry.copyable}
      title={copyLabel}
      aria-label={copyLabel}
      className={cn("group flex max-w-full min-w-0 items-start gap-1.5 rounded bg-muted/35 px-1.5 text-left transition-colors enabled:hover:bg-muted/70 disabled:cursor-default disabled:text-muted-foreground", table && !popup ? "border border-border/40 py-0.5" : "w-full py-1.5")}
    >
      {showLabel && <span className="shrink-0 text-[10px] text-muted-foreground">{t(entry.label)}</span>}
      <code className={cn("min-w-0 flex-1 break-all", compact || table ? "text-[11px] leading-4" : "text-xs leading-5")}>{entry.text}</code>
      {entry.copyable && <Copy className="mt-0.5 size-3 shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100" />}
    </button>;
  };
  const primary = visible.map(entry => entryButton(entry, visible.length > 1));
  if (!hidden.length) return <div className="flex min-w-0 flex-col gap-1 font-mono">{primary}</div>;
  return <Popover.Root open={open} onOpenChange={value => { cancelClose(); setOpen(value); }}>
    <Popover.Anchor asChild>
      <div className="flex min-w-0 items-start gap-1 font-mono"
        onPointerEnter={event => {
          if (event.pointerType === "touch") return;
          cancelClose();
          if (!open) { openedViaHover.current = true; setOpen(true); }
        }}
        onPointerLeave={event => { if (event.pointerType !== "touch") closeSoon(); }}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">{primary}</div>
        <Popover.Trigger asChild>
          <button type="button" title={t("悬停或点击查看 IPv6 入口")} aria-label={t("查看 IPv6 入口")}
            onPointerDown={() => { openedViaHover.current = false; }}
            onKeyDown={() => { openedViaHover.current = false; }}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-border/40 bg-muted/25 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >IPv6<ChevronDown className="size-3" /></button>
        </Popover.Trigger>
      </div>
    </Popover.Anchor>
    <Popover.Portal container={container}>
      <Popover.Content align="start" sideOffset={6} collisionPadding={12} aria-label={t("IPv6 入口")}
        className="action-menu-content z-50 w-80 max-w-[calc(100vw-24px)] max-h-[var(--radix-popover-content-available-height)] space-y-2 overflow-y-auto rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg"
        onPointerEnter={cancelClose} onPointerLeave={closeSoon}
        onOpenAutoFocus={event => { if (openedViaHover.current) event.preventDefault(); }}
        onCloseAutoFocus={event => { if (openedViaHover.current) event.preventDefault(); }}
      >
        <p className="text-xs font-medium">{t("IPv6 入口")}</p>
        <div className="space-y-1 font-mono">{hidden.map(entry => entryButton(entry, false, true))}</div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
