import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useTheme } from "@/contexts/ThemeContext";
import { createHomepageDocument } from "@/lib/homepageHtml";
import { trpc } from "@/lib/trpc";
import { ArrowRight, Gauge, Lock, Network, Server, ShieldCheck, WalletCards, Zap } from "lucide-react";
import { toast } from "sonner";
import { Link } from "wouter";

const REGISTRATION_CLOSED_MESSAGE = "当前注册未开放，请联系管理员";

const features = [
  { title: "多主机 Agent 管理", text: "统一接入多台 Linux 服务器，面板不保存 SSH 密钥。", icon: Server },
  { title: "端口与隧道转发", text: "支持 TCP、UDP、GOST 隧道和 ForwardX 加密隧道。", icon: Network },
  { title: "权限与套餐", text: "按用户控制主机、隧道、端口、流量和到期时间。", icon: ShieldCheck },
  { title: "流量统计与提醒", text: "展示转发流量趋势，并可通过邮件提醒临期和流量不足。", icon: Gauge },
];

export function CustomPublicHome({ html }: { html: string }) {
  const srcDoc = createHomepageDocument(html);
  return (
    <iframe
      title="ForwardX custom homepage"
      className="h-svh w-full border-0 bg-background"
      sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
      srcDoc={srcDoc}
    />
  );
}

export default function PublicHome() {
  const { resolvedTheme } = useTheme();
  const { data: info } = trpc.system.publicInfo.useQuery(undefined, { refetchOnWindowFocus: false });
  const registrationEnabled = info?.registrationEnabled !== false;

  const handleRegisterClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (registrationEnabled) return;
    event.preventDefault();
    toast.info(REGISTRATION_CLOSED_MESSAGE);
  };

  return (
    <div className="public-home-shell min-h-screen text-foreground">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-5">
        <Link href="/" className="flex items-center gap-3">
          <img src={resolvedTheme === "dark" ? "/logo-dark.png" : "/logo-light.png"} alt="ForwardX" className="h-9 w-9 object-contain" />
          <span className="text-lg font-semibold tracking-tight">ForwardX</span>
        </Link>
        <div className="flex items-center gap-2">
          <Button variant="ghost" asChild>
            <Link href="/login">登录</Link>
          </Button>
          <Button asChild>
            <Link href="/login?mode=register" onClick={handleRegisterClick}>注册</Link>
          </Button>
        </div>
      </header>

      <main>
        <section className="mx-auto grid min-h-[calc(100vh-84px)] w-full max-w-6xl items-center gap-8 px-4 pb-12 pt-6 lg:grid-cols-[1.05fr_0.95fr]">
          <div className="space-y-6">
            <Badge variant="outline" className="w-fit gap-2 border-emerald-500/30 bg-background/55 px-3 py-1.5 text-emerald-700 backdrop-blur dark:text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              面向 Linux 服务器的转发管理面板
            </Badge>
            <div className="space-y-4">
              <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">ForwardX</h1>
              <p className="max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
                统一管理转发、隧道、用户和流量。
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button size="lg" asChild>
                <Link href="/login">
                  进入面板
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link href="/login?mode=register" onClick={handleRegisterClick}>创建账号</Link>
              </Button>
            </div>
          </div>

          <div className="grid gap-3">
            <Card disableEnterAnimation className="border-border/50 bg-card/85 shadow-xl shadow-foreground/5 backdrop-blur-xl">
              <CardContent className="p-5">
                <div className="grid gap-3 sm:grid-cols-2">
                  {features.map((feature) => {
                    const Icon = feature.icon;
                    return (
                      <div key={feature.title} className="rounded-lg border border-border/40 bg-background/75 p-4">
                        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                          <Icon className="h-4 w-4" />
                        </div>
                        <h2 className="mt-3 text-sm font-semibold">{feature.title}</h2>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">{feature.text}</p>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg border border-border/50 bg-card/80 p-3 text-center shadow-sm backdrop-blur">
                <Zap className="mx-auto h-4 w-4 text-amber-500" />
                <p className="mt-2 text-xs text-muted-foreground">在线升级</p>
              </div>
              <div className="rounded-lg border border-border/50 bg-card/80 p-3 text-center shadow-sm backdrop-blur">
                <WalletCards className="mx-auto h-4 w-4 text-emerald-600" />
                <p className="mt-2 text-xs text-muted-foreground">套餐支付</p>
              </div>
              <div className="rounded-lg border border-border/50 bg-card/80 p-3 text-center shadow-sm backdrop-blur">
                <Lock className="mx-auto h-4 w-4 text-primary" />
                <p className="mt-2 text-xs text-muted-foreground">加密通讯</p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 pb-6 text-xs text-muted-foreground">
        <span>ForwardX v{info?.version || "-"}</span>
        <div className="flex items-center gap-3">
          <a href={info?.repoUrl || "#"} target="_blank" rel="noopener noreferrer" className="hover:text-foreground">
            GitHub
          </a>
          <span className="text-muted-foreground/45">|</span>
          <a href="https://t.me/ForwardX_panel" target="_blank" rel="noopener noreferrer" className="hover:text-foreground">
            TG群组
          </a>
        </div>
      </footer>
    </div>
  );
}
