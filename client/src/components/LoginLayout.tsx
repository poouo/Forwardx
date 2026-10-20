import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useMotionEnabled } from "./MotionPolicy";
import { Link } from "wouter";
import { ArrowUpRight, Network, Server, ShieldCheck, Zap } from "lucide-react";
import { ForwardXLogo } from "./ForwardXLogo";
import { t } from "@/i18n";
import { loginContentMotion } from "@/lib/loginTransition";

export function LoginLayout({ siteTitle, logo, version, mode, subtitle, toolbar, children }: {
  siteTitle: string;
  logo?: string | null;
  version?: string;
  mode: "login" | "register";
  subtitle: string;
  toolbar: ReactNode;
  children: ReactNode;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const formPanelRef = useRef<HTMLElement>(null);
  const [frameHeight, setFrameHeight] = useState<number>();
  const reduceMotion = !useMotionEnabled();
  useEffect(() => {
    const panel = formPanelRef.current;
    const frame = frameRef.current;
    if (!panel || !frame) return;
    const measure = () => {
      const minimum = Number.parseFloat(getComputedStyle(frame).minHeight) || 0;
      setFrameHeight(Math.max(minimum, Math.ceil(panel.getBoundingClientRect().height) + 2));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, []);

  return (
    <div className="mobile-login-screen auth-shell auth-login-shell">
      <header className="auth-login-header">
        <Link href="/" className="auth-login-brand">
          <ForwardXLogo size={32} alt={siteTitle} src={logo} />
          <span>{siteTitle}</span>
        </Link>
        <div className="auth-login-toolbar">{toolbar}</div>
      </header>

      <main className="auth-login-main">
        <motion.div ref={frameRef} className="auth-login-frame auth-route-enter" initial={false}
          animate={frameHeight === undefined ? {} : { height: frameHeight }}
          transition={{ duration: reduceMotion ? 0 : .46, ease: [.22, 1, .36, 1] }}>
          <aside className="auth-login-visual">
            <div className="auth-login-eyebrow"><span />{t("网络控制台")}</div>
            <h2>{t("连接每一条线路")}<span className="auth-login-heading-dot">.</span></h2>
            <p className="auth-login-intro">{t("管理多主机转发、隧道和流量。")}</p>

            <div className="auth-network-art" aria-hidden="true">
              <div className="auth-network-orbit" />
              <svg className="auth-network-lines" viewBox="0 0 360 190" fill="none">
                <path d="M48 110C108 110 104 74 180 74S252 110 312 110" />
                <path className="auth-network-line-secondary" d="M48 110C108 110 104 154 180 154S252 110 312 110" />
                <path className="auth-network-line-trace" d="M48 110C108 110 104 74 180 74S252 110 312 110" />
                <circle cx="102" cy="92" r="4" />
                <circle cx="258" cy="128" r="3" />
              </svg>
              <div className="auth-network-node auth-network-entry"><Server /><span>{t("入口")}</span></div>
              <div className="auth-network-node auth-network-hub"><Network /><span>{t("转发")}</span></div>
              <div className="auth-network-node auth-network-exit"><Server /><span>{t("出口")}</span></div>
              <div className="auth-network-caption">TCP / UDP <ArrowUpRight size={12} /> TLS</div>
            </div>

            <div className="auth-login-features">
              <span><Server />{t("多主机管理")}</span>
              <span><ShieldCheck />{t("权限控制")}</span>
              <span><Zap />{t("故障转移")}</span>
            </div>
          </aside>

          <section ref={formPanelRef} className="auth-login-form-panel" aria-labelledby="auth-login-title">
            <div className="auth-login-form-heading">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.div key={mode} {...loginContentMotion(!!reduceMotion)}>
                  <h1 id="auth-login-title">{t(mode === "login" ? "欢迎回来" : "创建账号")}</h1>
                  <p>{subtitle}</p>
                </motion.div>
              </AnimatePresence>
            </div>
            <div className="auth-login-form-content">
              {children}
            </div>
          </section>
        </motion.div>
      </main>

      <footer className="auth-login-footer">ForwardX{version ? <span>v{version}</span> : null}</footer>
    </div>
  );
}
