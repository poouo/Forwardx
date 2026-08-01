import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import DataSectionLoading from "@/components/DataSectionLoading";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { ExternalLink, Globe2 } from "lucide-react";
import { useEffect, useState } from "react";

type EmbedState = "loading" | "loaded" | "error";

function getCustomSidebarEmbedUrl(value: string) {
  if (typeof window === "undefined") return value;
  try {
    const target = new URL(value, window.location.href);
    if (target.origin !== window.location.origin) return value;
    target.searchParams.set("__forwardx_embed", "1");
    return target.toString();
  } catch {
    return value;
  }
}

export default function CustomSidebarPage({ pageId }: { pageId: string }) {
  const { user } = useAuth();
  const { data: pages = [], isLoading } = trpc.system.sidebarPages.useQuery(undefined, {
    enabled: !!user,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const page = pages.find((item) => item.id === pageId);
  const embedUrl = page ? getCustomSidebarEmbedUrl(page.url) : "";
  const [embedState, setEmbedState] = useState<EmbedState>("loading");

  useEffect(() => {
    if (!page || page.openMode === "external") return;
    setEmbedState("loading");
    const timeout = window.setTimeout(() => setEmbedState("error"), 12_000);
    return () => window.clearTimeout(timeout);
  }, [page?.id, page?.url, page?.openMode]);

  return (
    <DashboardLayout>
      {isLoading ? (
        <DataSectionLoading label="正在加载页面" minHeight="min-h-[320px]" />
      ) : page ? (
        <div className="space-y-4">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/50 bg-muted/30">
                {page.iconDataUrl ? (
                  <img src={page.iconDataUrl} alt="" className="h-6 w-6 object-contain" />
                ) : (
                  <Globe2 className="h-5 w-5 text-primary" />
                )}
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-xl font-bold tracking-tight sm:text-2xl">{page.name}</h1>
                <p className="mt-1 truncate text-xs text-muted-foreground" title={page.url}>{page.url}</p>
              </div>
            </div>
            <Button variant="outline" className="shrink-0 gap-2" asChild>
              <a href={page.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" />
                <span className="hidden sm:inline">{page.openMode === "external" ? "打开页面" : "新窗口打开"}</span>
              </a>
            </Button>
          </div>
          {page.openMode === "external" ? (
            <div className="grid h-[calc(100svh-9.5rem)] min-h-[32rem] place-items-center rounded-md border border-dashed border-border/60 bg-muted/15 px-6 text-center">
              <div className="max-w-md">
                <ExternalLink className="mx-auto h-8 w-8 text-primary" />
                <p className="mt-3 font-medium">此页面使用新窗口打开</p>
                <p className="mt-2 text-sm text-muted-foreground">目标网站禁止在面板内嵌入，点击上方按钮继续访问。</p>
                <Button variant="outline" className="mt-4 gap-2" asChild>
                  <a href={page.url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-4 w-4" />
                    打开页面
                  </a>
                </Button>
              </div>
            </div>
          ) : (
            <div className="relative h-[calc(100svh-9.5rem)] min-h-[32rem] overflow-hidden rounded-md border border-border/50 bg-background shadow-sm">
              <iframe
                key={embedUrl}
                src={embedUrl}
                title={page.name}
                className="h-full w-full border-0 bg-background"
                sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-presentation allow-same-origin allow-scripts allow-storage-access-by-user-activation allow-top-navigation-by-user-activation"
                allow="clipboard-read; clipboard-write; fullscreen"
                referrerPolicy="no-referrer"
                onLoad={() => setEmbedState("loaded")}
                onError={() => setEmbedState("error")}
              />
              {embedState === "error" && (
                <div className="absolute inset-0 z-10 grid place-items-center bg-background/95 px-6 text-center">
                  <div className="max-w-md">
                    <Globe2 className="mx-auto h-8 w-8 text-muted-foreground" />
                    <p className="mt-3 font-medium">此网站不允许嵌入或加载超时</p>
                    <p className="mt-2 text-sm text-muted-foreground">请使用新窗口打开；如果是面板内页面，请确认地址与当前面板使用同一个域名。</p>
                    <Button variant="outline" className="mt-4 gap-2" asChild>
                      <a href={page.url} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-4 w-4" />
                        新窗口打开
                      </a>
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="grid min-h-[320px] place-items-center rounded-md border border-dashed border-border/60 bg-muted/15 px-6 text-center">
          <div>
            <Globe2 className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="mt-3 font-medium">页面不存在或当前账号不可见</p>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
