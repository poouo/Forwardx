import { useId, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, Loader2, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useOverlayContainer } from "@/components/ui/overlay-root";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

export type AiModelOption = { id: string; isFree?: boolean | null };

export function modelSelectOptions(models: readonly AiModelOption[], search: string) {
  const keyword = search.trim();
  const unique = Array.from(new Map(models.filter(model => model.id).map(model => [model.id, model])).values());
  const matches = unique.filter(model => model.id.toLowerCase().includes(keyword.toLowerCase()));
  return { matches, custom: keyword && !unique.some(model => model.id === keyword) ? keyword : "" };
}

export default function AiModelSelect({ id, value, onValueChange, models, loading, configured, error, placeholder, onRefresh }: {
  id?: string; value: string; onValueChange: (value: string) => void; models: readonly AiModelOption[];
  loading: boolean; configured: boolean; error?: string; placeholder?: string; onRefresh: () => void;
}) {
  const container = useOverlayContainer();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(-1);
  const { matches, custom } = modelSelectOptions(models, search);
  const options = [...matches.map(model => ({ ...model, custom: false })), ...(custom ? [{ id: custom, custom: true, isFree: undefined }] : [])];
  const choose = (model: string) => { onValueChange(model); setOpen(false); };
  const move = (index: number) => {
    const next = Math.max(0, Math.min(options.length - 1, index));
    setActive(next);
    listRef.current?.querySelectorAll<HTMLElement>('[role="option"]')[next]?.scrollIntoView({ block: "nearest" });
  };
  return <Popover.Root open={open} onOpenChange={next => { setOpen(next); setSearch(""); setActive(-1); }}>
    <Popover.Trigger asChild>
      <Button id={id} type="button" variant="outline" role="combobox" aria-label={t("模型")} aria-expanded={open} aria-controls={listId} className="w-full min-w-0 justify-between gap-2 font-normal">
        <span className="min-w-0 truncate font-mono" title={value}>{value || placeholder || t("从列表选择模型")}</span>
        {loading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" /> : <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />}
      </Button>
    </Popover.Trigger>
    <Popover.Portal container={container}>
      <Popover.Content align="end" sideOffset={6} collisionPadding={12} onOpenAutoFocus={event => { event.preventDefault(); inputRef.current?.focus(); }} className="z-[80] flex max-h-[min(26rem,var(--radix-popover-content-available-height))] w-[max(20rem,var(--radix-popover-trigger-width))] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl border bg-popover p-2 text-popover-foreground shadow-xl">
        <div className="relative mb-2 shrink-0">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input ref={inputRef} value={search} maxLength={128} aria-label={t("搜索或输入模型名称")} placeholder={t("搜索或输入模型名称")} role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={options[active] ? `${listId}-${active}` : undefined} className="h-9 pl-8" onChange={event => { setSearch(event.target.value); setActive(-1); }} onKeyDown={event => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); move(active < 0 && event.key === "ArrowUp" ? options.length - 1 : active + (event.key === "ArrowDown" ? 1 : -1)); }
            if (event.key === "Enter") { event.preventDefault(); const option = options[active] || options.find(option => option.id === search.trim()); if (option) choose(option.id); }
          }} />
        </div>
        <div ref={listRef} id={listId} role="listbox" aria-label={t("模型")} aria-busy={loading} className="min-h-0 overflow-y-auto overscroll-contain">
          {options.map((model, index) => <button type="button" key={model.id} id={`${listId}-${index}`} role="option" tabIndex={-1} aria-selected={model.id === value} onPointerMove={() => setActive(index)} onClick={() => choose(model.id)} className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm", active === index && "bg-accent", model.id === value && "bg-primary/5 text-primary")}>
            <span className="min-w-0 flex-1 truncate font-mono" title={model.id}>{model.id}</span>
            {model.custom ? <span className="shrink-0 text-xs text-muted-foreground">{t("自定义")}</span> : model.isFree !== undefined && model.isFree !== null ? <span className="shrink-0 text-xs text-muted-foreground">{model.isFree ? "Free" : "Paid"}</span> : null}
          </button>)}
          {!options.length && <p role="status" className="px-2.5 py-3 text-xs text-muted-foreground">{loading ? t("加载中...") : t("暂无可选模型，可直接输入名称。")}</p>}
        </div>
        <div className="mt-2 flex shrink-0 items-center justify-between gap-2 border-t pt-2">
          <p role={error ? "alert" : undefined} className="min-w-0 break-words text-xs text-muted-foreground">{!configured ? t("保存 API Key 后可拉取模型列表。") : error || t("可用模型：{0}", [models.length])}</p>
          <Button type="button" variant="ghost" size="sm" disabled={!configured || loading} onClick={onRefresh} className="h-7 shrink-0 px-2 text-xs"><RefreshCw className={cn("mr-1 h-3.5 w-3.5", loading && "animate-spin")} />{t("刷新")}</Button>
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
