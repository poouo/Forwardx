export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  if (typeof navigator !== "undefined" && typeof window !== "undefined" && navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      console.warn("[Clipboard] navigator.clipboard failed, falling back:", error);
    }
  }

  if (typeof document === "undefined") return false;

  const host = (document.querySelector('[role="dialog"][data-state="open"]') as HTMLElement | null) || document.body;
  if (!host) return false;

  const textarea = document.createElement("textarea");
  try {
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "0";
    textarea.style.top = "0";
    textarea.style.width = "1px";
    textarea.style.height = "1px";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    textarea.style.zIndex = "-1";

    host.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);

    return document.execCommand("copy");
  } catch (error) {
    console.warn("[Clipboard] execCommand fallback failed:", error);
    return false;
  } finally {
    textarea.remove();
  }
}
