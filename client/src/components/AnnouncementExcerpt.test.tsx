import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { Window } from "happy-dom";

test("announcement lists clip only overflowing content and open a complete, sanitized reader", async () => {
  const window = new Window({ url: "http://localhost" });
  const observers: { callback: () => void; disconnected: boolean }[] = [];
  class ResizeObserver {
    entry: { callback: () => void; disconnected: boolean };
    constructor(callback: () => void) {
      this.entry = { callback, disconnected: false };
      observers.push(this.entry);
    }
    observe() {}
    disconnect() { this.entry.disconnected = true; }
  }
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement,
    Node: window.Node, NodeFilter: window.NodeFilter, MutationObserver: window.MutationObserver,
    CustomEvent: window.CustomEvent, Event: window.Event, ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window), IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import("react-dom/client");
  const { default: AnnouncementExcerpt } = await import("./AnnouncementExcerpt");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (content: string) => {
    await act(async () => root.render(<AnnouncementExcerpt title="Service news" description="Published today" content={content} />));
  };
  try {
    await render("A short notice");
    const preview = container.querySelector<HTMLElement>("[data-announcement-excerpt]")!;
    let contentHeight = 48;
    Object.defineProperties(preview, {
      scrollHeight: { get: () => contentHeight },
      clientHeight: { get: () => Math.min(contentHeight, 96) },
    });
    await act(async () => observers.at(-1)!.callback());
    assert.equal(container.querySelector("button"), null, "short notices need no read-more action");
    assert.equal(preview.inert, false);

    // Width changes on mobile can make the same text overflow.
    contentHeight = 240;
    await act(async () => observers.at(-1)!.callback());
    assert.ok(container.querySelector("button"));
    assert.equal(preview.inert, true, "clipped links cannot receive focus");

    const content = '<h2>First section</h2><p>Full announcement body</p><p>Last section stays available</p><a href="javascript:alert(1)">Unsafe link</a><script>alert(1)</script>';
    await render(content);
    assert.equal(document.querySelector("[role=dialog]"), null, "a long list item does not open itself");
    await act(async () => container.querySelector("button")!.click());
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;
    assert.ok(dialog);
    assert.match(dialog.textContent || "", /Service news/);
    const full = dialog.querySelector<HTMLElement>("[data-announcement-full]")!;
    assert.match(full.innerHTML, /<h2>First section<\/h2>/);
    assert.match(full.textContent || "", /Last section stays available/);
    assert.doesNotMatch(full.innerHTML, /javascript:|<script/);
    assert.doesNotMatch(full.className, /max-h-|overflow-hidden|line-clamp/);
    assert.equal(full.inert, false);

    await render('![Release image](https://cdn.example.com/release.png)');
    const image = container.querySelector<HTMLImageElement>("[data-announcement-excerpt] img")!;
    assert.equal(image.getAttribute("src"), "https://cdn.example.com/release.png");
    assert.equal(image.getAttribute("alt"), "Release image");
    await act(async () => dialog.querySelector<HTMLButtonElement>("button")!.click());
    assert.equal(document.querySelector("[role=dialog]"), null);

    contentHeight = 24;
    await render("Updated short notice");
    assert.equal(container.querySelector("button"), null, "shortened content removes the read-more action");
    assert.equal(preview.inert, false);
    assert.ok(observers.slice(0, -1).every(observer => observer.disconnected));
  } finally {
    await act(async () => root.unmount());
    assert.ok(observers.every(observer => observer.disconnected));
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
