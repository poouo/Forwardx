import { useEffect, useId, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { useOverlayContainer } from "@/components/ui/overlay-root";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { userOptionDetail, userOptionLabel } from "@/lib/userSelection";

type Props = {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  specialOptions?: Array<{ value: string; label: string }>;
  excludeUserId?: number;
  placeholder?: string;
  className?: string;
};

export default function UserSelect({ id, value, onValueChange, specialOptions = [], excludeUserId, placeholder = t("选择用户"), className }: Props) {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const admin = user?.role === "admin";
  const overlayContainer = useOverlayContainer();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [cursors, setCursors] = useState<Array<number | undefined>>([undefined]);
  const [active, setActive] = useState(-1);
  const searching = search.trim() !== query;
  useEffect(() => {
    const timer = window.setTimeout(() => { setQuery(search.trim()); setCursors([undefined]); setActive(-1); }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  const page = trpc.users.optionsPage.useQuery({ search: query, cursor: cursors[cursors.length - 1], limit: 20, excludeUserId }, {
    enabled: admin && open && !searching, staleTime: 30_000, refetchOnWindowFocus: false,
  });
  const selectedId = /^\d+$/.test(value) ? Number(value) : undefined;
  // Independent lookup preserves the selected label across search/page changes.
  const selected = trpc.users.optionsByIds.useQuery({ ids: selectedId ? [selectedId] : [] }, {
    enabled: admin && !!selectedId, staleTime: 30_000, refetchOnWindowFocus: false,
  });
  const items = searching ? [] : page.data?.items || [];
  const fixed = specialOptions.map(option => ({ ...option, detail: "" }));
  const options = [...fixed, ...items.map(item => ({ value: String(item.id), label: userOptionLabel(item), detail: userOptionDetail(item) }))];
  const label = specialOptions.find(option => option.value === value)?.label
    || (selected.data?.[0] ? userOptionLabel(selected.data[0]) : selectedId ? t("用户 #{0}", [selectedId]) : placeholder);
  const busy = searching || page.isFetching;
  const choose = (next: string) => {
    const option = items.find(item => String(item.id) === next);
    // Keep the chosen name visible immediately, without flashing a numeric ID
    // while its independent selected-user query starts.
    if (option) utils.users.optionsByIds.setData({ ids: [option.id] }, [option]);
    onValueChange(next);
    setOpen(false);
  };
  const move = (index: number) => {
    if (!options.length) return;
    const next = Math.max(0, Math.min(options.length - 1, index));
    setActive(next);
    listRef.current?.querySelectorAll<HTMLElement>('[role="option"]')[next]?.scrollIntoView({ block: "nearest" });
  };
  const renderOption = (option: typeof options[number], index: number) => <button key={option.value} id={`${listId}-${index}`} type="button" role="option" tabIndex={-1} aria-selected={value === option.value}
    onPointerMove={() => setActive(index)} onClick={() => choose(option.value)}
    className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm", active === index && "bg-accent", value === option.value && "text-primary")}>
    <Check className={cn("size-4 shrink-0", value !== option.value && "invisible")} /><span className="min-w-0 flex-1">
      <span className="block truncate" title={option.label}>{option.label}</span>
      {option.detail && <span className="block truncate text-xs text-muted-foreground" title={option.detail}>{option.detail}</span>}
    </span>
  </button>;
  return <Popover.Root open={open} onOpenChange={next => {
    setOpen(next);
    if (next) { setSearch(""); setQuery(""); setCursors([undefined]); setActive(-1); }
  }}>
    <Popover.Trigger asChild><Button id={id} type="button" variant="outline" role="combobox" aria-label={t("选择用户")} aria-expanded={open} aria-controls={listId}
      disabled={!admin} className={cn("w-full min-w-0 justify-between gap-2 font-normal", className)}>
      <span className="min-w-0 truncate" title={label}>{label}</span><ChevronDown className="size-4 shrink-0 text-muted-foreground" />
    </Button></Popover.Trigger>
    <Popover.Portal container={overlayContainer}><Popover.Content align="start" sideOffset={6} aria-label={t("选择用户")}
      className="user-select-content z-50 flex max-h-[var(--radix-popover-content-available-height)] w-[max(var(--radix-popover-trigger-width),18rem)] max-w-[calc(100vw-2rem)] flex-col rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-xl"
      onOpenAutoFocus={event => { event.preventDefault(); inputRef.current?.focus({ preventScroll: true }); }}>
      <div className="relative mb-1 shrink-0"><Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input ref={inputRef} value={search} maxLength={128} placeholder={t("搜索用户名、邮箱、ID 或备注")}
          role="combobox" aria-label={t("搜索用户")} aria-autocomplete="list" aria-expanded={open} aria-controls={listId}
          aria-activedescendant={active >= 0 && options[active] ? `${listId}-${active}` : undefined}
          className="h-9 pl-8" onChange={event => { setSearch(event.target.value); setActive(-1); }} onKeyDown={event => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); move(active < 0 && event.key === "ArrowUp" ? options.length - 1 : active + (event.key === "ArrowDown" ? 1 : -1)); }
            if (event.key === "Enter" && options[active]) { event.preventDefault(); choose(options[active].value); }
          }} />
      </div>
      <div ref={listRef} id={listId} role="listbox" aria-label={t("用户")} aria-busy={busy} className="min-h-0 max-h-64 overflow-y-auto overscroll-contain">
        {!!fixed.length && <div role="group" className="sticky top-0 z-10 border-b bg-popover">{options.slice(0, fixed.length).map(renderOption)}</div>}
        {options.slice(fixed.length).map((option, index) => renderOption(option, fixed.length + index))}
      </div>
      {busy ? <p role="status" className="p-3 text-center text-xs text-muted-foreground">{t("加载中...")}</p>
        : page.error ? <div role="alert" className="p-2 text-center text-xs text-destructive"><p>{t("用户加载失败")}</p><Button size="sm" variant="ghost" onClick={() => void page.refetch()}>{t("重试")}</Button></div>
        : !items.length && <p role="status" className="p-3 text-center text-xs text-muted-foreground">{t("未找到用户")}</p>}
      <div className="mt-1 flex shrink-0 items-center justify-between gap-2 border-t pt-1.5 text-xs text-muted-foreground">
        <Button type="button" variant="ghost" size="sm" aria-label={t("上一页")} disabled={busy || cursors.length === 1} onClick={() => { setCursors(current => current.slice(0, -1)); setActive(-1); listRef.current?.scrollTo({ top: 0 }); }}><ChevronLeft className="size-4" /></Button>
        <span>{t("第 {0} 页", [cursors.length])}</span>
        <Button type="button" variant="ghost" size="sm" aria-label={t("下一页")} disabled={busy || !page.data?.nextCursor} onClick={() => { if (page.data?.nextCursor) setCursors(current => [...current, page.data!.nextCursor]); setActive(-1); listRef.current?.scrollTo({ top: 0 }); }}><ChevronRight className="size-4" /></Button>
      </div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
