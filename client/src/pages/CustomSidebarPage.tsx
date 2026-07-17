import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import DataSectionLoading from "@/components/DataSectionLoading";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { ExternalLink, Globe2 } from "lucide-react";

export default function CustomSidebarPage({ pageId }: { pageId: string }) {
  const { user } = useAuth();
  const { data: pages = [], isLoading } = trpc.system.sidebarPages.useQuery(undefined, {
    enabled: !!user,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const page = pages.find((item) => item.id === pageId);

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
                <span className="hidden sm:inline">新窗口打开</span>
              </a>
            </Button>
          </div>
          <div className="h-[calc(100svh-9.5rem)] min-h-[32rem] overflow-hidden rounded-md border border-border/50 bg-background shadow-sm">
            <iframe
              key={page.url}
              src={page.url}
              title={page.name}
              className="h-full w-full border-0 bg-background"
              sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
              allow="clipboard-read; clipboard-write"
              referrerPolicy="no-referrer"
            />
          </div>
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
