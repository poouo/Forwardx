import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { t } from "@/i18n";
import { renderMixedHtml } from "@/lib/htmlContent";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

/** Only the list preview is clipped; the reader always renders the complete announcement. */
export default function AnnouncementExcerpt({ title, content, description }: {
  title: string;
  content: string;
  description: string;
}) {
  const html = useMemo(() => ({ __html: renderMixedHtml(content) }), [content]);
  const previewRef = useRef<HTMLDivElement>(null);
  const [truncated, setTruncated] = useState(false);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    const measure = () => setTruncated(preview.scrollHeight > preview.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(preview);
    return () => observer.disconnect();
  }, [html]);

  return <>
    <div
      ref={previewRef}
      data-announcement-excerpt=""
      className="forwardx-rich-text max-h-24 overflow-hidden text-sm leading-6 text-foreground/85 [overflow-wrap:anywhere]"
      style={truncated ? { maskImage: "linear-gradient(to bottom, black calc(100% - 24px), transparent)" } : undefined}
      // Clipped links should not receive focus outside the visible preview.
      inert={truncated}
      dangerouslySetInnerHTML={html}
    />
    {truncated && <Button
      type="button"
      variant="secondary"
      size="sm"
      className="mt-3 gap-1.5"
      aria-label={t("查看完整公告：{0}", [title])}
      onClick={() => setOpen(true)}
    >{t("查看完整公告")}<ArrowUpRight className="h-4 w-4" /></Button>}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div
          data-announcement-full=""
          className="forwardx-rich-text min-w-0 text-sm leading-6 text-foreground/85 [overflow-wrap:anywhere]"
          dangerouslySetInnerHTML={html}
        />
        <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>{t("关闭")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
