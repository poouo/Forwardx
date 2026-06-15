import { escapeHtml, sanitizeHtml } from "@shared/htmlSanitizer";

export function looksLikeHtml(content: string) {
  return /<\/?[a-z][\s\S]*>/i.test(content.trim());
}

export function looksLikeMarkdown(content: string) {
  const value = content.trim();
  return /(^|\n)\s{0,3}#{1,6}\s+\S/.test(value) ||
    /(^|\n)\s{0,3}>\s+\S/.test(value) ||
    /(^|\n)\s{0,3}([-*+])\s+\S/.test(value) ||
    /(^|\n)\s{0,3}\d+\.\s+\S/.test(value) ||
    /```[\s\S]*```/.test(value) ||
    /`[^`\n]+`/.test(value) ||
    /\*\*[^*\n]+\*\*/.test(value) ||
    /__[^_\n]+__/.test(value) ||
    /\[[^\]\n]+\]\([^)]+\)/.test(value);
}

export function textToHtml(content: string) {
  return escapeHtml(String(content || "")).replace(/\r?\n/g, "<br>");
}

function escapeAttribute(content: string) {
  return textToHtml(content).replace(/<br>/g, " ");
}

function safeHref(url: string) {
  const value = url.trim();
  if (/^(https?:|mailto:|tel:|\/|#)/i.test(value)) return value;
  return "#";
}

function renderInlineMarkdown(content: string) {
  let html = textToHtml(content).replace(/<br>/g, "\n");
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  html = html.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) => {
    return `<a href="${escapeAttribute(safeHref(url.replace(/&amp;/g, "&")))}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  html = html.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  html = html.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  return html;
}

export function markdownToHtml(content: string) {
  const lines = String(content || "").replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let inCode = false;
  let codeLines: string[] = [];

  const closeList = () => {
    if (!listType) return;
    blocks.push(`</${listType}>`);
    listType = null;
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inCode) {
        blocks.push(`<pre><code>${textToHtml(codeLines.join("\n")).replace(/<br>/g, "\n")}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      closeList();
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const quote = line.match(/^\s{0,3}>\s?(.*)$/);
    if (quote) {
      closeList();
      blocks.push(`<blockquote>${renderInlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }

    const unordered = line.match(/^\s{0,3}[-*+]\s+(.+)$/);
    if (unordered) {
      if (listType !== "ul") {
        closeList();
        listType = "ul";
        blocks.push("<ul>");
      }
      blocks.push(`<li>${renderInlineMarkdown(unordered[1])}</li>`);
      continue;
    }

    const ordered = line.match(/^\s{0,3}\d+\.\s+(.+)$/);
    if (ordered) {
      if (listType !== "ol") {
        closeList();
        listType = "ol";
        blocks.push("<ol>");
      }
      blocks.push(`<li>${renderInlineMarkdown(ordered[1])}</li>`);
      continue;
    }

    closeList();
    blocks.push(`<p>${renderInlineMarkdown(line)}</p>`);
  }

  if (inCode) {
    blocks.push(`<pre><code>${textToHtml(codeLines.join("\n")).replace(/<br>/g, "\n")}</code></pre>`);
  }
  closeList();
  return blocks.join("\n");
}

export function renderMixedHtml(content: string) {
  const value = String(content || "");
  if (looksLikeHtml(value)) return sanitizeHtml(value);
  if (looksLikeMarkdown(value)) return sanitizeHtml(markdownToHtml(value));
  return textToHtml(value);
}

export function describeContentFormat(content: string) {
  if (looksLikeHtml(content)) return "H5/HTML";
  if (looksLikeMarkdown(content)) return "Markdown";
  return "普通文本";
}
