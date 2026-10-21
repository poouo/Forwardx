import { t } from "@/i18n";
import { ForwardXLogo } from "./ForwardXLogo";
import { ArrowRightLeft, LayoutDashboard, PanelLeft, UserRound } from "lucide-react";
import { readSiteBranding, type SiteBranding } from "@/lib/siteBranding";
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar } from "./ui/sidebar";
import { cn } from "@/lib/utils";

// Match the real workspace geometry while auth is pending. No saved identity,
// private numbers, custom menus or role-dependent controls are trusted here.
export default function PanelStartView({ branding = readSiteBranding() }: { branding?: SiteBranding } = {}) {
  return <SidebarProvider className="pearl-shell"><PendingWorkspace branding={branding} /></SidebarProvider>;
}

function PendingWorkspace({ branding }: { branding: SiteBranding }) {
  const { state, isMobile, toggleSidebar } = useSidebar();
  const collapsed = !isMobile && state === "collapsed";
  const logo = <ForwardXLogo size={28} alt={branding.siteTitle} src={branding.siteLogoDataUrl} />;
  const items = [{ path: "/", label: "仪表盘", icon: LayoutDashboard }, { path: "/rules", label: "转发规则", icon: ArrowRightLeft }, { path: "/profile", label: "个人资料", icon: UserRound }];
  return <>
    <Sidebar collapsible="icon" className="pearl-sidebar border-r border-sidebar-border/60">
      <SidebarHeader className="h-16 md:h-[var(--pearl-header-height)] justify-center mobile-sidebar-header">
        <div className={cn("flex w-full items-center gap-3", collapsed ? "justify-center px-0" : "px-2")}>
          {collapsed ? <button onClick={toggleSidebar} className="collapsed-sidebar-logo-button flex h-9 w-9 items-center justify-center rounded-lg" aria-label={t("展开侧边栏")}>{logo}</button> : <div className="flex min-w-0 flex-1 items-center justify-between"><a href="/" className="flex min-w-0 items-center gap-2">{logo}<span className="truncate text-base font-bold tracking-tight">{branding.siteTitle}</span></a><button onClick={toggleSidebar} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-accent" aria-label={t("收起侧边栏")}><PanelLeft className="h-4 w-4 text-muted-foreground" /></button></div>}
        </div>
      </SidebarHeader>
      <SidebarContent className="gap-1 pb-2 mobile-sidebar-content"><SidebarGroup className="pb-2 mobile-sidebar-group"><SidebarGroupLabel>{t("主菜单")}</SidebarGroupLabel><SidebarMenu className={cn("py-1 mobile-sidebar-menu", collapsed ? "items-center px-0" : "px-2")}>{items.map(item => <SidebarMenuItem key={item.path}><SidebarMenuButton asChild tooltip={t(item.label)}><a href={item.path}><item.icon className="h-4 w-4" /><span>{t(item.label)}</span></a></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></SidebarGroup></SidebarContent>
    </Sidebar>
    <SidebarInset className="pearl-workspace">
      {!isMobile && <header className="pearl-topbar"><div className="pearl-topbar-crumb"><span className="text-muted-foreground">{branding.siteTitle}</span><span className="text-muted-foreground/50" aria-hidden="true">/</span><span className="font-medium">{t("仪表盘")}</span></div><a href="/login" className="text-sm text-muted-foreground hover:text-primary">{t("登录")}</a></header>}
      {isMobile && <header data-mobile-header="true" className="glass-surface fixed inset-x-0 top-0 z-40 flex min-h-14 items-center gap-2 border-b px-2"><SidebarTrigger className="h-9 w-9 rounded-lg bg-background" /><span>{branding.siteTitle}</span></header>}
    <main data-mobile-main="true" className="min-w-0 flex-1 space-y-6 px-3 pb-3 pt-3 sm:p-6" aria-busy="true">
      <div><h1 className="text-xl font-bold">{t("仪表盘")}</h1><p className="mt-2 text-sm text-muted-foreground" role="status">{t("正在验证登录，数据将自动更新")}</p></div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {["转发规则", "入站流量", "出站流量", "运行状态"].map(label => <section key={label} className="rounded-xl border border-border/50 bg-card p-5"><h2 className="text-sm text-muted-foreground">{t(label)}</h2><p className="mt-3 text-2xl">—</p></section>)}
      </div>
    </main>
    </SidebarInset>
  </>;
}
