import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmDialogProvider, useConfirmDialog } from "./confirm-dialog";
import { readFileSync } from "node:fs";
import { DialogFooter } from "./dialog";
import { Button } from "./button";

function Consumer() {
  const confirm = useConfirmDialog();
  return <span>{typeof confirm === "function" ? "context connected" : "missing"}</span>;
}

test("confirmation actions keep spacing at every breakpoint in Chinese and English", () => {
  const source = readFileSync("client/src/components/ui/confirm-dialog.tsx", "utf8");
  assert.match(source, /<DialogFooter>/);
  assert.doesNotMatch(source, /sm:gap-0/);
  for (const [cancel, confirm] of [["Cancel", "Confirm this operation"], ["取消", "确认切换语言"]]) {
    const html = renderToStaticMarkup(<DialogFooter><Button variant="outline">{cancel}</Button><Button>{confirm}</Button></DialogFooter>);
    assert.match(html, /responsive-actions/);
    assert.match(html, /gap-2/);
    assert.match(html, /sm:flex-wrap/);
    assert.doesNotMatch(html, /gap-0/);
  }
  const css = readFileSync("client/src/index.css", "utf8");
  const actions = css.match(/\.responsive-actions > :is\(button, a\[role="button"\]\)\s*\{([^}]+)\}/)?.[1];
  assert.ok(actions);
  assert.match(actions, /white-space: normal/);
  assert.match(actions, /max-width: 100%/);
});

test("Confirmation consumers require the provider and work inside it", () => {
  assert.throws(() => renderToStaticMarkup(<Consumer />), /within ConfirmDialogProvider/);
  assert.match(renderToStaticMarkup(<ConfirmDialogProvider><Consumer /></ConfirmDialogProvider>), /context connected/);
});

test("Re-evaluated dialog UI shares context with existing providers and consumers", async () => {
  // A distinct module URL simulates a Vite update while the mounted tree still
  // contains components from the previous version of the UI module.
  const url = new URL("./confirm-dialog.tsx?confirm-dialog-refresh-regression", import.meta.url);
  const refreshed: typeof import("./confirm-dialog") = await import(url.href);
  assert.notEqual(refreshed.ConfirmDialogProvider, ConfirmDialogProvider);
  function RefreshedConsumer() {
    const confirm = refreshed.useConfirmDialog();
    return <span>{typeof confirm === "function" ? "refreshed context connected" : "missing"}</span>;
  }
  assert.match(renderToStaticMarkup(<ConfirmDialogProvider><RefreshedConsumer /></ConfirmDialogProvider>), /refreshed context connected/);
  const RefreshedProvider = refreshed.ConfirmDialogProvider;
  assert.match(renderToStaticMarkup(<RefreshedProvider><Consumer /></RefreshedProvider>), /context connected/);
});
