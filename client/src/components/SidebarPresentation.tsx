import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { mobileAuth } from "@/lib/mobileAuth";
import type { SidebarPresentationGroup } from "@/lib/sidebarPresentation";
import { resolveClientRoute } from "@shared/clientRoutes";
import { ArrowRightLeft, CreditCard, Globe2, Handshake, LayoutDashboard, LifeBuoy, Megaphone, Package, Puzzle, ReceiptText, Route, Server, Settings, ShoppingBag, UserRound, Users, WalletCards } from "lucide-react";
import { SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "./ui/sidebar";

const pages = {
  Home: ["仪表盘", LayoutDashboard], Hosts: ["主机管理", Server], Tunnels: ["链路管理", Route], Rules: ["转发规则", ArrowRightLeft],
  Profile: ["个人资料", UserRound], Operations: ["运维看板", LayoutDashboard], Payments: ["支付对接", CreditCard], Billing: ["账单与兑换", WalletCards],
  Plans: ["套餐管理", Package], Users: ["用户管理", Users], LookingGlass: ["网络测试", Globe2], Settings: ["系统设置", Settings],
  Plugins: ["插件管理", Puzzle], Store: ["商店", ShoppingBag], Subscriptions: ["我的订阅", Package], Wallet: ["账单中心", ReceiptText],
  Announcements: ["公告", Megaphone], SupportTickets: ["工单支持", LifeBuoy], Affiliates: ["推广返佣", Handshake],
  ForwardGroups: ["转发组", Route], TrafficBilling: ["按量计费", ReceiptText], EmailSettings: ["邮件设置", Settings], CustomSidebarPage: ["自定义页面", Globe2],
} as const;

export function pendingPageTitle(path: string, groups: SidebarPresentationGroup[] = []) {
  const cached = groups.flatMap(group => group.items).find(item => item.path === path.split(/[?#]/)[0]);
  if (cached) return cached.label;
  if (path.split(/[?#]/)[0] === "/affiliate-management") return t("推广管理");
  const page = resolveClientRoute(path)?.page;
  return t(page && page in pages ? pages[page as keyof typeof pages][0] : "加载中");
}

/** Cached navigation is inert until the server has verified the session/config. */
export function SidebarPresentation({ groups, path }: { groups: SidebarPresentationGroup[]; path: string }) {
  const { state, isMobile } = useSidebar();
  const collapsed = !isMobile && state === "collapsed";
  return <>{groups.map((group, index) => <SidebarGroup key={index} className={cn(
    index === 0 ? "pb-2 mobile-sidebar-group" : "mt-1 shrink-0 border-t border-sidebar-border/50 pt-2 mobile-sidebar-group mobile-sidebar-admin-group",
    mobileAuth.isNative && (index === 0 ? "pb-1.5" : "mt-0 pt-2"),
  )}>
    <SidebarGroupLabel className="text-xs text-muted-foreground/60 uppercase tracking-wider">{group.label}</SidebarGroupLabel>
    <SidebarMenu className={cn("py-1 mobile-sidebar-menu", collapsed ? "items-center px-0" : "px-2")}>
      {group.items.map(item => {
        const page = resolveClientRoute(item.path)?.page;
        const Icon = page && page in pages ? pages[page as keyof typeof pages][1] : Globe2;
        return <SidebarMenuItem key={item.path}>
          <SidebarMenuButton asChild isActive={item.path === path} tooltip={item.label} className={cn("h-10 font-normal mobile-sidebar-menu-button", collapsed && "justify-center", mobileAuth.isNative && "text-[13px]")}>
            <span aria-disabled="true" aria-current={item.path === path ? "page" : undefined}>
              <Icon className={cn("sidebar-nav-icon h-4 w-4", collapsed && "h-[18px] w-[18px]")} />
              <span className={cn(collapsed && "sr-only")}>{item.label}</span>
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>;
      })}
    </SidebarMenu>
  </SidebarGroup>)}</>;
}
