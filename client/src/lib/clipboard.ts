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

  let textarea: HTMLTextAreaElement | null = null;
  let previousFocus: HTMLElement | null = null;
  try {
    const host = (document.querySelector('[role="dialog"][data-state="open"]') as HTMLElement | null) || document.body;
    if (!host) return false;

    const activeElement = document.activeElement;
    previousFocus = activeElement && typeof (activeElement as HTMLElement).focus === "function"
      ? activeElement as HTMLElement
      : null;
    textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "0";
    textarea.style.top = "0";
    textarea.style.width = "1px";
    textarea.style.height = "1px";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    textarea.style.zIndex = "2147483647";

    host.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);

    return document.execCommand("copy") === true;
  } catch (error) {
    console.warn("[Clipboard] execCommand fallback failed:", error);
    return false;
  } finally {
    textarea?.remove();
    if (previousFocus && (!("isConnected" in previousFocus) || previousFocus.isConnected)) {
      try { previousFocus.focus({ preventScroll: true }); }
      catch { previousFocus.focus(); }
    }
  }
}
