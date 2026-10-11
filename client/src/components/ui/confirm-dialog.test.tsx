import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmDialogProvider, useConfirmDialog } from "./confirm-dialog";

function Consumer() {
  const confirm = useConfirmDialog();
  return <span>{typeof confirm === "function" ? "context connected" : "missing"}</span>;
}

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
