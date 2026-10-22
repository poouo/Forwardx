import { t } from "@/i18n";
import { ForwardXLogo } from "./ForwardXLogo";
import { PanelLeft } from "lucide-react";
import { readSiteBranding, type SiteBranding } from "@/lib/siteBranding";
import { Sidebar, SidebarContent, SidebarHeader, SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from "./ui/sidebar";
import { cn } from "@/lib/utils";
import { readSidebarPresentation } from "@/lib/sidebarPresentation";
import { pendingPageTitle, SidebarPresentation } from "./SidebarPresentation";

// Presentation only while auth is pending: never restore private data or controls.
export default function PanelStartView({ branding = readSiteBranding() }: { branding?: SiteBranding } = {}) {
  return <SidebarProvider className="pearl-shell"><PendingWorkspace branding={branding} /></SidebarProvider>;
}

function PendingWorkspace({ branding }: { branding: SiteBranding }) {
  const { state, isMobile, toggleSidebar } = useSidebar();
  const collapsed = !isMobile && state === "collapsed";
  const logo = <ForwardXLogo size={28} alt={branding.siteTitle} src={branding.siteLogoDataUrl} />;
  const groups = readSidebarPresentation();
  const path = typeof window === "undefined" ? "/" : window.location.pathname;
  const pageTitle = pendingPageTitle(path, groups);
  return <>
    <Sidebar collapsible="icon" className="pearl-sidebar border-r border-sidebar-border/60">
      <SidebarHeader className="h-16 md:h-[var(--pearl-header-height)] justify-center mobile-sidebar-header">
        <div className={cn("flex w-full items-center gap-3", collapsed ? "justify-center px-0" : "px-2")}>
          {collapsed ? <button onClick={toggleSidebar} className="collapsed-sidebar-logo-button flex h-9 w-9 items-center justify-center rounded-lg" aria-label={t("展开侧边栏")}>{logo}</button> : <div className="flex min-w-0 flex-1 items-center justify-between"><a href="/" className="flex min-w-0 items-center gap-2">{logo}<span className="truncate text-base font-bold tracking-tight">{branding.siteTitle}</span></a><button onClick={toggleSidebar} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-accent" aria-label={t("收起侧边栏")}><PanelLeft className="h-4 w-4 text-muted-foreground" /></button></div>}
        </div>
      </SidebarHeader>
      <SidebarContent className="pearl-nav-content gap-1 pb-2 mobile-sidebar-content"><SidebarPresentation groups={groups} path={path} /></SidebarContent>
    </Sidebar>
    <SidebarInset className="pearl-workspace">
      {!isMobile && <header className="pearl-topbar"><div className="pearl-topbar-crumb"><span className="text-muted-foreground">{branding.siteTitle}</span><span className="text-muted-foreground/50" aria-hidden="true">/</span><span className="font-medium">{pageTitle}</span></div></header>}
      {isMobile && <header data-mobile-header="true" className="glass-surface fixed inset-x-0 top-0 z-40 flex min-h-14 items-center gap-2 border-b px-2"><SidebarTrigger className="h-9 w-9 rounded-lg bg-background" /><span>{branding.siteTitle}</span></header>}
    <main data-mobile-main="true" className="min-w-0 flex-1 space-y-6 px-3 pb-3 pt-3 sm:p-6" aria-busy="true">
      <h1 className="text-xl font-bold sm:text-2xl">{pageTitle}</h1>
      <span className="sr-only" role="status">{t("正在验证登录，数据将自动更新")}</span>
    </main>
    </SidebarInset>
  </>;
}
