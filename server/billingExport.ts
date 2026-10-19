import ExcelJS from "exceljs";
import { setImmediate } from "node:timers/promises";
import { createWriteStream } from "node:fs";
import { iterateBillingLedgerExport, type listBillingLedger } from "./repositories/billingRepository";

export const BILLING_XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export type BillingExportOptions = NonNullable<Parameters<typeof listBillingLedger>[0]>;
export type BillingExportRow = Awaited<ReturnType<typeof listBillingLedger>>[number];

export function billingExportScope(user: { id: number; role: string; accountEnabled?: boolean } | null, userId?: number): BillingExportOptions {
  if (!user || user.accountEnabled === false || !Number.isSafeInteger(user.id) || user.id <= 0) {
    throw new Error("UNAUTHORIZED");
  }
  return { viewerUserId: user.id, isAdmin: user.role === "admin", userId: user.role === "admin" ? userId : undefined };
}

// Excel dates have no timezone. Store China wall-clock values and label the zone.
function chinaDate(value: unknown) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isFinite(date.getTime()) ? new Date(date.getTime() + 8 * 3600_000) : null;
}

function text(value: unknown) {
  // Assign as a string (never an Excel formula or hyperlink object).
  return value == null ? "" : String(value).slice(0, 32767);
}

const columns = [
  ["流水编号", 23], ["时间（UTC+8）", 23], ["用户 ID", 13], ["用户账号", 25], ["用户名称", 22],
  ["类型", 20], ["项目", 36], ["金额", 17], ["币种", 10], ["变动后余额（CNY）", 23], ["状态", 14],
  ["关联订单号", 34], ["网关流水号", 34], ["备注", 52], ["支付时间（UTC+8）", 23],
] as const;

export async function writeBillingLedgerXlsx(
  filename: string,
  options: BillingExportOptions,
  signal?: AbortSignal,
  batches: AsyncIterable<BillingExportRow[]> = iterateBillingLedgerExport(options, signal),
) {
  signal?.throwIfAborted();
  const output = createWriteStream(filename, { mode: 0o600 });
  // Handle early disk failures as well as failures during commit.
  let outputError: Error | undefined;
  let rejectOutput!: (error: Error) => void;
  const outputFailure = new Promise<never>((_, reject) => { rejectOutput = reject; });
  // A file can fail before commit() attaches its own stream listeners.
  void outputFailure.catch(() => undefined);
  output.on("error", error => { outputError = error; rejectOutput(error); });
  output.on("close", () => { if (!output.writableFinished) rejectOutput(new Error("Export output closed early")); });
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: output, useStyles: true, useSharedStrings: false });
  const archive = (workbook as unknown as { zip: { abort(): void; on(event: "error", listener: (error: Error) => void): void } }).zip;
  archive.on("error", error => { outputError = error; output.destroy(error); });
  workbook.creator = "ForwardX";
  workbook.created = new Date();
  const abort = () => output.destroy(new Error("Export cancelled"));
  signal?.addEventListener("abort", abort, { once: true });
  const exportedAt = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  let sheet: ExcelJS.Worksheet;
  let sheetNumber = 0;
  let rowCount = 0;
  let sheetRow = 5;
  const startSheet = () => {
    sheetRow = 5;
    sheet = workbook.addWorksheet(++sheetNumber === 1 ? "账单流水" : `账单流水 ${sheetNumber}`, {
      views: [{ state: "frozen", ySplit: 5, showGridLines: false }],
      properties: { defaultRowHeight: 23, tabColor: { argb: "FF2563EB" } },
    });
    sheet.columns = columns.map(([, width]) => ({ width }));
    sheet.getRow(1).height = 8;
    const title = sheet.getRow(2);
    title.getCell(1).value = "ForwardX 账单流水";
    title.font = { name: "Arial", size: 15, bold: true, color: { argb: "FF1E293B" } };
    title.height = 30;
    const note = sheet.getRow(3);
    note.getCell(1).value = `导出时间：${exportedAt}    范围：${options.isAdmin && !options.userId ? "全部用户" : `用户 #${options.userId ?? options.viewerUserId}`}    各来源记录不作收入加总`;
    note.font = { name: "Arial", size: 10, italic: true, color: { argb: "FF64748B" } };
    const header = sheet.getRow(5);
    header.values = columns.map(([name]) => name);
    header.height = 28;
    header.eachCell(cell => {
      cell.font = { name: "Arial", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2563EB" } };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = { right: { style: "thin", color: { argb: "FFFFFFFF" } } };
    });
    for (let i = 1; i <= 5; i++) sheet.getRow(i).commit();
  };
  const finishSheet = () => {
    sheet.autoFilter = { from: { row: 5, column: 1 }, to: { row: sheetRow, column: columns.length } };
    sheet.commit();
  };
  try {
    signal?.throwIfAborted();
    startSheet();
    for await (const batch of batches) {
      signal?.throwIfAborted();
      if (outputError) throw outputError;
      for (const item of batch) {
        // Keep every record, even when the export exceeds Excel's per-sheet limit.
        if (sheetRow >= 1_048_576) { finishSheet(); startSheet(); }
        const row = sheet!.addRow([
          text(item.id), chinaDate(item.createdAt), text(item.userId), text(item.username), text(item.name),
          text(item.category), text(item.title), item.amountCents / 100, text(item.currency),
          "balanceAfterCents" in item && typeof item.balanceAfterCents === "number" ? item.balanceAfterCents / 100 : null,
          text(item.statusLabel), text(item.paymentOrderNo), "tradeNo" in item ? text(item.tradeNo) : "",
          text(item.description), "paidAt" in item ? chinaDate(item.paidAt) : null,
        ]);
        sheetRow++;
        row.font = { name: "Arial", size: 11, color: { argb: "FF334155" } };
        row.alignment = { vertical: "middle", horizontal: "left" };
        if (++rowCount % 2 === 0) row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
        for (const index of [2, 15]) row.getCell(index).numFmt = "yyyy-mm-dd hh:mm:ss";
        for (const index of [8, 10]) {
          row.getCell(index).numFmt = '#,##0.00;[Red]-#,##0.00;0.00';
          row.getCell(index).alignment = { vertical: "middle", horizontal: "right" };
        }
        for (const index of [1, 3, 4, 5, 12, 13]) row.getCell(index).numFmt = "@";
        row.getCell(14).alignment = { wrapText: true, vertical: "top" };
        if (String(item.description || "").length > 45) row.height = 42;
        row.commit();
      }
      await setImmediate(); // Let compression and file I/O drain between batches.
    }
    signal?.throwIfAborted();
    finishSheet();
    if (outputError) throw outputError;
    await Promise.race([workbook.commit(), outputFailure]);
    if (outputError) throw outputError;
    return rowCount;
  } catch (error) {
    // Stop the archive too, so cancellation cannot leave pending compression work.
    archive.abort();
    output.destroy();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!output.closed) await new Promise<void>(resolve => output.once("close", resolve));
  }
}
