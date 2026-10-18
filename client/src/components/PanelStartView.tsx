import { t } from "@/i18n";
import { ForwardXLogo } from "./ForwardXLogo";

// Public, usable shell, not an authentication snapshot or an overlay. Private
// numbers and role-dependent controls are mounted only after server verification.
export default function PanelStartView() {
  return <div className="min-h-svh bg-background text-foreground">
    <header className="flex h-16 items-center justify-between border-b border-border/50 px-6">
      <a href="/" className="flex items-center gap-3 font-semibold"><ForwardXLogo className="h-8 w-8" />ForwardX</a>
      <a href="/login" className="text-sm text-muted-foreground hover:text-primary">{t("登录")}</a>
    </header>
    <main className="mx-auto max-w-7xl space-y-6 px-6 py-8" aria-busy="true">
      <div><h1 className="text-xl font-bold">{t("仪表盘")}</h1><p className="mt-2 text-sm text-muted-foreground" role="status">{t("正在验证登录，数据将自动更新")}</p></div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {["转发规则", "入站流量", "出站流量", "运行状态"].map(label => <section key={label} className="rounded-xl border border-border/50 bg-card p-5"><h2 className="text-sm text-muted-foreground">{t(label)}</h2><p className="mt-3 text-2xl">—</p></section>)}
      </div>
    </main>
  </div>;
}
