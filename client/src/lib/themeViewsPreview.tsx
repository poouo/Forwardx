import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { LoginLayout } from "@/components/LoginLayout";
import ThemeBlocks, { themeColumnStyles } from "@/components/themes/ThemeBlocks";
import { themeHostCardExample, themeText } from "@shared/themeViews";
import { hostThemeValues } from "@shared/themeFields";
import type { ThemeDefinition, ThemeSummary } from "@shared/themes";
import { getLanguage, t } from "@/i18n";
import { themePreviewDocument } from "./themePreview";
import viewStyles from "../styles/theme-views.css?raw";
import pearlStyles from "../styles/pearl.css?raw";

/** Uses fixed sample data, never authenticated host rows or account details. */
export function renderThemeViewsPreview(theme: ThemeSummary, dark: boolean, definition: ThemeDefinition | undefined, kind: "hosts" | "login") {
  const config = definition?.manifest.views;
  let body: string;
  if (kind === "login") {
    const login = config?.login;
    body = renderToStaticMarkup(<Router ssrPath="/login"><LoginLayout themeConfig={login} siteTitle="ForwardX" version="1.0.0" mode="login" subtitle={t("登录账号以继续")} toolbar={<span>☼</span>}>
      <form><label>{themeText(login?.usernameLabel, getLanguage(), t("用户名"))}<input data-theme-part="input" disabled placeholder={themeText(login?.usernamePlaceholder, getLanguage(), "user@example.com")} /></label>
        <label>{themeText(login?.passwordLabel, getLanguage(), t("密码"))}<input data-theme-part="input" disabled type="password" value="sample" readOnly /></label>
        <button data-theme-part="button" type="button" disabled>{themeText(login?.loginButton, getLanguage(), t("登录"))}</button></form>
    </LoginLayout></Router>);
  } else {
    const hosts = config?.hosts;
    const now = Date.now();
    const sharedValues = { "site.title": "ForwardX", "site.version": "1.0.0", "viewer.name": "Demo", "viewer.role": "admin", "fleet.total": 3, "fleet.online": 2, "fleet.offline": 1, "fleet.networkInSpeed": 1_048_576, "fleet.networkOutSpeed": 524_288, "fleet.trafficIn": 5_368_709_120, "fleet.trafficOut": 1_073_741_824 };
    body = renderToStaticMarkup(<div data-theme-part="hosts" style={{ padding: 20 }}>
      <h2>{themeText(hosts?.title, getLanguage(), t("主机管理"))}</h2>
      {hosts?.intro && <ThemeBlocks node={hosts.intro} values={sharedValues} />}
      <div data-theme-part="host-grid" data-theme-host-grid="true" style={{ ...themeColumnStyles(hosts?.cardLayout === "rows" ? { mobile: 1, tablet: 1, desktop: 1 } : hosts?.columns), gap: hosts?.gap ?? 16 }}>
        {[true, true, false].map((online, index) => <article key={index} data-theme-part="card" data-theme-host-card="true" data-theme-host-status={online ? "online" : "offline"}>
          <ThemeBlocks node={hosts?.card || themeHostCardExample()} values={{ ...sharedValues, ...hostThemeValues({ id: index + 1, name: `Server ${String(index + 1).padStart(2, "0")}`, isOnline: online, ipv4: `192.0.2.${index + 1}`, geoCountryName: "Demo", geoCountryCode: "US", osInfo: "Linux", cpuInfo: "Virtual CPU", memoryTotal: 8 * 1024 ** 3, agentVersion: "1.0.0", stoppedAt: now + 30 * 86_400_000, trafficLimit: 1024 ** 4 }, [{ cpuUsage: 16.5, memoryUsage: 42, memoryUsed: 3.36 * 1024 ** 3, diskUsage: 21, diskUsed: 21 * 1024 ** 3, diskTotal: 100 * 1024 ** 3, networkSpeedIn: 1_048_576, networkSpeedOut: 524_288, uptime: 86_400, load1: 0.3, recordedAt: now }], { bytesIn: 5 * 1024 ** 3, bytesOut: 1024 ** 3 }, now) }} />
        </article>)}
      </div>
      {hosts?.outro && <ThemeBlocks node={hosts.outro} values={sharedValues} />}
    </div>);
  }
  return themePreviewDocument(theme, dark, definition, { title: t("主题预览"), navigation: t("仪表盘"), card: t("工作空间"), button: t("保存"), input: t("输入内容") }, { body, css: `${pearlStyles}\n${viewStyles}\n[data-theme-part="login"]{min-height:100vh}.auth-login-main{padding:16px}.auth-login-frame{height:auto!important}.auth-login-form-panel{padding:24px}label{display:block;margin-bottom:12px}` });
}
