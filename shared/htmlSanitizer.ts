const ALLOWED_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);

const VOID_TAGS = new Set(["br", "hr"]);
const ALLOWED_ATTRS = new Set(["class", "href", "rel", "target", "title"]);
const URL_ATTRS = new Set(["href"]);

export function escapeHtml(content: string) {
  return String(content || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function decodeBasicEntities(value: string) {
  return String(value || "")
    .replace(/&colon;/gi, ":")
    .replace(/&#0*58;/gi, ":")
    .replace(/&#x0*3a;/gi, ":")
    .replace(/&tab;/gi, "\t")
    .replace(/&#0*9;/gi, "\t")
    .replace(/&#x0*9;/gi, "\t")
    .replace(/&newline;/gi, "\n")
    .replace(/&#0*10;/gi, "\n")
    .replace(/&#x0*a;/gi, "\n")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'");
}

function isSafeUrl(value: string) {
  const normalized = decodeBasicEntities(value).replace(/[\u0000-\u001f\u007f\s]+/g, "").trim();
  return /^(https?:|mailto:|tel:|\/|#)/i.test(normalized);
}

function sanitizeAttributes(rawAttrs: string, tagName: string) {
  const attrs: string[] = [];
  const attrPattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(rawAttrs))) {
    const name = match[1].toLowerCase();
    if (name.startsWith("on") || !ALLOWED_ATTRS.has(name)) continue;
    if ((name === "class" && tagName !== "code") || (name === "target" && tagName !== "a") || (name === "rel" && tagName !== "a")) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (URL_ATTRS.has(name) && !isSafeUrl(value)) continue;
    const safeValue = escapeHtml(value).replace(/\r?\n/g, " ");
    attrs.push(`${name}="${safeValue}"`);
  }
  if (tagName === "a") {
    const hasTarget = attrs.some((attr) => attr.startsWith("target="));
    const hasRel = attrs.some((attr) => attr.startsWith("rel="));
    if (!hasTarget) attrs.push('target="_blank"');
    if (!hasRel) attrs.push('rel="noopener noreferrer"');
  }
  return attrs.length ? ` ${attrs.join(" ")}` : "";
}

export function sanitizeHtml(input: string) {
  const withoutDangerousBlocks = String(input || "")
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form|input|button|textarea|select|option|svg|math)[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form|input|button|textarea|select|option|svg|math)\b[^>]*\/?\s*>/gi, "");

  return withoutDangerousBlocks.replace(/<\s*(\/)?\s*([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g, (full, closing: string, rawName: string, rawAttrs: string) => {
    const tagName = rawName.toLowerCase();
    if (!ALLOWED_TAGS.has(tagName)) return "";
    if (closing) return VOID_TAGS.has(tagName) ? "" : `</${tagName}>`;
    const attrs = sanitizeAttributes(rawAttrs || "", tagName);
    return VOID_TAGS.has(tagName) ? `<${tagName}${attrs}>` : `<${tagName}${attrs}>`;
  });
}
