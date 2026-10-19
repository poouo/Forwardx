import { Router } from "express";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { createContext } from "./_core/context";
import { appendPanelLog } from "./_core/panelLogger";
import { billingExportScope, BILLING_XLSX_MIME, writeBillingLedgerXlsx } from "./billingExport";
import { SlidingWindowRateLimiter } from "./ai/rateLimiter";

const querySchema = z.object({
  userId: z.coerce.number().int().positive().optional(),
  includeCancelledSubscriptions: z.enum(["true", "false"]).default("true").transform(value => value === "true"),
}).strict();

export function createBillingExportRouter(resolveContext = createContext) {
  const router = Router();
  const activeUsers = new Set<number>();
  const limiter = new SlidingWindowRateLimiter({ limit: 3, windowMs: 60_000 });
  router.get("/api/billing/ledger.xlsx", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    let directory: string | undefined;
    let activeUserId: number | undefined;
    const abort = new AbortController();
    const onClose = () => { if (!res.writableFinished) abort.abort(); };
    const timeout = setTimeout(() => {
      abort.abort();
      if (res.headersSent && !res.writableFinished) res.destroy();
    }, 10 * 60_000);
    timeout.unref();
    res.on("close", onClose);
    try {
      const { user } = await resolveContext({ req, res, info: {} as never });
      if (!user || user.accountEnabled === false) { res.status(401).json({ error: "请先登录" }); return; }
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) { res.status(400).json({ error: "导出参数无效" }); return; }
      const scope = { ...billingExportScope(user, parsed.data.userId), includeCancelledSubscriptions: parsed.data.includeCancelledSubscriptions };
      if (activeUsers.has(user.id) || activeUsers.size >= 2 || !limiter.consume(user.id).allowed) {
        res.setHeader("Retry-After", "60");
        res.status(429).json({ error: "导出繁忙，请稍后重试" }); return;
      }
      activeUsers.add(user.id);
      activeUserId = user.id;
      directory = await mkdtemp(path.join(os.tmpdir(), "forwardx-billing-export-"));
      const filename = path.join(directory, "ledger.xlsx");
      const count = await writeBillingLedgerXlsx(filename, scope, abort.signal);
      abort.signal.throwIfAborted();
      res.type(BILLING_XLSX_MIME);
      const date = new Date().toISOString().slice(0, 10);
      const exportName = `forwardx-billing-${scope.isAdmin && !scope.userId ? "all" : `user-${scope.userId ?? scope.viewerUserId}`}-${date}.xlsx`;
      await new Promise<void>((resolve, reject) => res.download(filename, exportName, error => error ? reject(error) : resolve()));
      appendPanelLog("info", `[BillingExport] actor=${user.id} scope=${scope.isAdmin && !scope.userId ? "all" : scope.userId ?? scope.viewerUserId} rows=${count}`);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        const unavailable = (error as { code?: string })?.code === "SERVICE_UNAVAILABLE";
        res.status(unavailable ? 503 : abort.signal.aborted ? 408 : 500).json({ error: unavailable ? "数据库暂不可用" : abort.signal.aborted ? "导出超时，请缩小范围后重试" : "账单导出失败，请稍后重试" });
      } else if (!res.writableFinished) res.destroy();
      if (!abort.signal.aborted) console.error("[BillingExport] export failed", error);
    } finally {
      clearTimeout(timeout);
      res.off("close", onClose);
      if (activeUserId !== undefined) activeUsers.delete(activeUserId);
      if (directory) await rm(directory, { recursive: true, force: true }).catch(error => console.warn("[BillingExport] temporary file cleanup failed", error));
    }
  });
  return router;
}

export const billingExportRouter = createBillingExportRouter();
