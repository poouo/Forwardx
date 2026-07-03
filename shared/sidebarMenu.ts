export const SIDEBAR_MENU_KEYS = [
  "dashboard",
  "announcements",
  "profile",
  "payments",
  "billing",
  "plans",
  "users",
  "lookingGlass",
  "settings",
] as const;

export type SidebarMenuKey = typeof SIDEBAR_MENU_KEYS[number];
export type SidebarMenuSettings = Record<SidebarMenuKey, boolean>;

export const SIDEBAR_MENU_LABELS: Record<SidebarMenuKey, string> = {
  dashboard: "仪表盘",
  announcements: "公告",
  profile: "个人资料",
  payments: "支付对接",
  billing: "账单与兑换",
  plans: "套餐管理",
  users: "用户管理",
  lookingGlass: "网络测试",
  settings: "系统设置",
};

export const DEFAULT_SIDEBAR_MENU_SETTINGS: SidebarMenuSettings = SIDEBAR_MENU_KEYS.reduce((acc, key) => {
  acc[key] = true;
  return acc;
}, {} as SidebarMenuSettings);

export function normalizeSidebarMenuSettings(input?: Partial<Record<string, unknown>> | null): SidebarMenuSettings {
  const output: SidebarMenuSettings = { ...DEFAULT_SIDEBAR_MENU_SETTINGS };
  if (!input || typeof input !== "object") return output;
  for (const key of SIDEBAR_MENU_KEYS) {
    const value = input[key];
    if (typeof value === "boolean") output[key] = value;
  }
  return output;
}
