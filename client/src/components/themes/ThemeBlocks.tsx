import type { CSSProperties } from "react";
import { THEME_FIELDS, type ThemeField, type ThemeValues } from "@shared/themeFields";
import { themeText, type ThemeColumns, type ThemeNode } from "@shared/themeViews";
import { getFormatLocale, getLanguage, t } from "@/i18n";
import { formatBytes, formatUptime } from "@/components/hosts/hostDisplay";

export function themeColumnStyles(columns?: ThemeColumns, fallback = 1): CSSProperties {
  return { "--theme-columns-mobile": columns?.mobile ?? fallback, "--theme-columns-tablet": columns?.tablet ?? columns?.mobile ?? fallback, "--theme-columns-desktop": columns?.desktop ?? columns?.tablet ?? columns?.mobile ?? fallback } as CSSProperties;
}

export function formatThemeField(field: ThemeField, value: ThemeValues[ThemeField], precision?: number) {
  if (value === null || value === undefined) return null;
  const format = THEME_FIELDS[field].format;
  if (format === "status") return value ? t("在线") : t("离线");
  if (format === "text") return String(value);
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (format === "bytes") return formatBytes(value);
  if (format === "speed") return `${formatBytes(value)}/s`;
  if (format === "duration") return value === 0 ? "0s" : formatUptime(value);
  if (format === "date") return new Date(value).toLocaleString(getFormatLocale());
  const number = value.toLocaleString(getFormatLocale(), { maximumFractionDigits: precision ?? (format === "percent" ? 1 : 2) });
  return format === "percent" ? `${number}%` : number;
}

/** React renders every value as text. Bindings cannot evaluate code or traverse objects. */
export default function ThemeBlocks({ node, values }: { node: ThemeNode; values: ThemeValues }) {
  const online = values["host.online"];
  if (node.when === "online" && online !== true || node.when === "offline" && online !== false) return null;
  const style = { "--theme-node-span": node.span ?? 1 } as CSSProperties;
  if (node.type === "group") {
    return <div data-theme-part="theme-group" data-theme-node={node.id} data-theme-direction={node.direction || "column"} style={{ ...style, ...themeColumnStyles(node.columns), gap: node.gap ?? 12 }}>
      {node.children.map((child, index) => <ThemeBlocks key={child.id || index} node={child} values={values} />)}
    </div>;
  }
  if (node.type === "text") return <div data-theme-part="theme-text" data-theme-node={node.id} data-theme-variant={node.variant || "body"} style={style}>{themeText(node.text, getLanguage())}</div>;
  const value = formatThemeField(node.field, values[node.field], node.precision);
  if (node.when === "available" && value === null) return null;
  const label = node.label === false ? null : themeText(node.label, getLanguage(), t(THEME_FIELDS[node.field].label));
  const display = node.display || "text";
  return <div data-theme-part="theme-field" data-theme-node={node.id} data-theme-field={node.field} data-theme-display={display} data-theme-tone={node.tone || "default"} data-theme-available={value !== null} style={style}>
    {label !== null && <span data-theme-part="theme-label">{label}</span>}
    <span data-theme-part="theme-value">{value === null ? themeText(node.missing, getLanguage(), "—") : `${themeText(node.prefix, getLanguage())}${value}${themeText(node.suffix, getLanguage())}`}</span>
    {display === "progress" && value !== null && <div className="theme-field-progress" role="progressbar" aria-label={label || t(THEME_FIELDS[node.field].label)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.max(0, Math.min(100, Number(values[node.field])))}><span style={{ width: `${Math.max(0, Math.min(100, Number(values[node.field])))}%` }} /></div>}
  </div>;
}
