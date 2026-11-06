import { getPersonalizationThemePreset } from "@shared/personalization";
import type { ThemeDefinition, ThemeSummary } from "@shared/themes";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

/** A script-free document, isolated from the live panel and its authenticated data. */
export function themePreviewDocument(theme: ThemeSummary, dark: boolean, definition: ThemeDefinition | undefined, labels: { title: string; navigation: string; card: string; button: string; input: string }, rendered?: { body: string; css: string }) {
  const preset = getPersonalizationThemePreset(theme.base);
  const tokens: Record<string, string> = {
    "--background": dark ? "#161b1e" : "#f4f6f5", "--foreground": dark ? "#edf3f2" : "#1b2825",
    "--card": dark ? "#20272a" : "#ffffff", "--border": dark ? "#3b4548" : "#dce4e0", "--radius": "1rem",
  };
  for (const [key, value] of Object.entries(dark ? preset.dark : preset.light)) {
    tokens[`--${key.replace(/[A-Z]/g, character => `-${character.toLowerCase()}`).replace(/^chart(\d)/, "chart-$1")}`] = value;
  }
  Object.assign(tokens, definition?.manifest.variables?.light, dark ? definition?.manifest.variables?.dark : {});
  const shell = definition?.manifest.views?.shell;
  if (shell?.contentWidth) tokens["--theme-content-width"] = `${shell.contentWidth}px`;
  const variables = Object.entries(tokens).map(([key, value]) => `${key}:${value}`).join(";");
  // Escape closing style tags without changing media ranges such as (width < 600px).
  const escapeStyle = (value: string) => value.replace(/<\/style/gi, "\\3c /style");
  const css = escapeStyle(definition?.css || "");
  const document = `<!doctype html><html class="${dark ? "dark" : "light"}" data-theme-api="1" data-forwardx-theme="${escapeHtml(theme.id)}" data-theme-navigation="${shell?.navigation || "left"}"${shell?.contentWidth ? ' data-theme-content-width="true"' : ""}><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<style>:root{${escapeStyle(variables)}}*{box-sizing:border-box}body{margin:0;background:var(--background);color:var(--foreground);font:14px system-ui,sans-serif}
[data-theme-part="shell"]{display:flex;min-height:440px}[data-theme-part="sidebar"]{width:150px;padding:22px 16px;border-right:1px solid var(--border);background:var(--card)}
[data-theme-navigation="right"] [data-theme-part="shell"]{flex-direction:row-reverse}
[data-theme-content-width] [data-theme-part="content"]{max-width:var(--theme-content-width);margin-inline:auto;width:100%}
nav p{padding:10px;border-radius:8px}nav p:first-child{background:var(--accent);color:var(--accent-foreground)}[data-theme-part="workspace"]{flex:1;min-width:0}
[data-theme-part="header"]{padding:20px;border-bottom:1px solid var(--border)}[data-theme-part="content"]{padding:22px}
[data-theme-part="card"]{background:var(--card);padding:22px;border:1px solid var(--border);border-radius:var(--radius);margin-bottom:18px}
[data-theme-part="button"]{background:var(--primary);color:var(--primary-foreground);border:0;padding:10px 18px;border-radius:8px}
[data-theme-part="input"]{padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--background);color:var(--foreground);width:100%;margin:0 0 14px}
table{width:100%;text-align:left;border-collapse:collapse}td,th{padding:10px;border-bottom:1px solid var(--border)}
@media(max-width:500px){[data-theme-part="sidebar"]{width:100px;padding:14px 8px}[data-theme-part="content"]{padding:12px}}</style><style>${escapeStyle(rendered?.css || "")}</style><style>${css}</style></head>
<body><div data-theme-part="shell"><aside data-theme-part="sidebar"><strong>ForwardX</strong><nav><p>${escapeHtml(labels.navigation)}</p><p>Hosts</p><p>Settings</p></nav></aside>
<section data-theme-part="workspace"><header data-theme-part="header">${escapeHtml(labels.title)}</header><main data-theme-part="content">
<article data-theme-part="card"><h2>${escapeHtml(labels.card)}</h2><input data-theme-part="input" placeholder="${escapeHtml(labels.input)}"><button data-theme-part="button">${escapeHtml(labels.button)}</button></article>
<article data-theme-part="card"><table data-theme-part="table"><thead><tr><th>Host</th><th>Status</th></tr></thead><tbody><tr><td>Server 01</td><td>● Online</td></tr><tr><td>Server 02</td><td>● Online</td></tr></tbody></table></article>
</main></section></div></body></html>`;
  // Only application-rendered React markup may be passed here; package text is escaped by React.
  return rendered ? document.replace(/<body>[\s\S]*<\/body>/, () => `<body>${rendered.body}</body>`) : document;
}
