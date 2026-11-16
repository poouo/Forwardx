import assert from "node:assert/strict";
import test from "node:test";
import { copyTextToClipboard } from "./clipboard";

function withGlobals<T>(values: Record<string, unknown>, callback: () => T): T {
  const target = globalThis as Record<string, unknown>;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  }
  try {
    return callback();
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else delete target[key];
    }
  }
}

function makeFallbackDocument(execResult: boolean) {
  let textarea: (HTMLTextAreaElement & { removed?: boolean }) | null = null;
  let appended = false;
  let selected = false;
  const body: any = {
    appendChild(element: any) {
      textarea = element;
      element.parentNode = body;
      appended = true;
      return element;
    },
  };
  const document = {
    activeElement: null,
    body,
    querySelector: () => null,
    createElement: (tag: string) => {
      assert.equal(tag, "textarea");
      return {
        value: "",
        style: {} as CSSStyleDeclaration,
        setAttribute() {},
        focus() {},
        select() { selected = true; },
        setSelectionRange() { selected = true; },
        remove() {
          if (textarea) textarea.removed = true;
        },
      } as any;
    },
    execCommand: (command: string) => {
      assert.equal(command, "copy");
      return execResult;
    },
  } as unknown as Document;
  return { document, getTextarea: () => textarea, get appended() { return appended; }, get selected() { return selected; } };
}

test("copies over HTTP with textarea fallback when Clipboard API is unavailable", async () => {
  const fallback = makeFallbackDocument(true);
  let clipboardCalls = 0;
  const result = await withGlobals({
    window: { isSecureContext: false },
    navigator: { clipboard: { writeText: async () => { clipboardCalls++; } } },
    document: fallback.document,
    HTMLElement: class {},
  }, () => copyTextToClipboard("203.0.113.8:443"));

  assert.equal(result, true);
  assert.equal(clipboardCalls, 0);
  assert.equal(fallback.appended, true);
  assert.equal(fallback.selected, true);
  assert.equal(fallback.getTextarea()?.value, "203.0.113.8:443");
  assert.equal(fallback.getTextarea()?.removed, true);
});

test("reports failure when the browser rejects both clipboard methods", async () => {
  const fallback = makeFallbackDocument(false);
  const result = await withGlobals({
    window: { isSecureContext: false },
    navigator: {},
    document: fallback.document,
    HTMLElement: class {},
  }, () => copyTextToClipboard("203.0.113.8:443"));

  assert.equal(result, false);
  assert.equal(fallback.getTextarea()?.removed, true);
});

test("uses Clipboard API in secure contexts", async () => {
  let copied = "";
  const result = await withGlobals({
    window: { isSecureContext: true },
    navigator: { clipboard: { writeText: async (text: string) => { copied = text; } } },
  }, () => copyTextToClipboard("203.0.113.8:443"));

  assert.equal(result, true);
  assert.equal(copied, "203.0.113.8:443");
});
