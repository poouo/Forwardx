import { Button } from "@/components/ui/button";
import { createHomepageDocument } from "@/lib/homepageHtml";
import { trpc } from "@/lib/trpc";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";

export default function HomepagePreview() {
  const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const mode = params.get("mode") || "saved";
  const previewId = params.get("id") || "";
  const [draftHtml] = useState(() => {
    if (mode !== "draft" || typeof window === "undefined") return "";
    const previewKey = previewId ? `forwardx.homepage.preview.${previewId}` : "";
    try {
      const html = (previewKey ? window.localStorage.getItem(previewKey) : "")
        || window.sessionStorage.getItem("forwardx.homepage.preview")
        || "";
      if (previewKey) window.localStorage.removeItem(previewKey);
      return html;
    } catch {
      return window.sessionStorage.getItem("forwardx.homepage.preview") || "";
    }
  });
  const { data: settings, isLoading } = trpc.system.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    retry: false,
  });

  let html = mode === "draft" ? draftHtml : settings?.homepageHtml || "";
  if (!html.trim()) {
    html = "<main style=\"min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;color:#64748b;\"><div>暂无自定义首页内容</div></main>";
  }

  return (
    <div className="min-h-svh bg-background">
      <div className="flex h-12 items-center justify-between border-b bg-background/95 px-3 backdrop-blur">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Button variant="ghost" size="sm" asChild className="gap-2">
            <Link href="/settings?tab=system">
              <ArrowLeft className="h-4 w-4" />
              返回设置
            </Link>
          </Button>
          <span className="text-muted-foreground">{mode === "draft" ? "草稿预览" : "已保存预览"}</span>
        </div>
      </div>
      {isLoading && mode !== "draft" ? null : (
        <iframe
          title="ForwardX homepage preview"
          className="h-[calc(100svh-3rem)] w-full border-0 bg-background"
          sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
          srcDoc={createHomepageDocument(html)}
        />
      )}
    </div>
  );
}
