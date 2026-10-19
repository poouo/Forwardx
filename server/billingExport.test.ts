import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import ExcelJS from "exceljs";
import { billingExportScope, writeBillingLedgerXlsx, type BillingExportRow } from "./billingExport";

test("export scope cannot be widened by ordinary users or disabled accounts", () => {
  assert.deepEqual(billingExportScope({ id: 2, role: "user" }, 3), { viewerUserId: 2, isAdmin: false, userId: undefined });
  assert.equal(billingExportScope({ id: 1, role: "admin" }).userId, undefined);
  assert.equal(billingExportScope({ id: 1, role: "admin" }, 3).userId, 3);
  for (const user of [null, { id: 2, role: "user", accountEnabled: false }, { id: 0, role: "user" }]) {
    assert.throws(() => billingExportScope(user), /UNAUTHORIZED/);
  }
});

test("XLSX retains styled, typed financial data and treats untrusted content as literal text", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forwardx-xlsx-test-"));
  try {
    const filename = path.join(directory, "ledger.xlsx");
    const item = {
      id: "balance-42", userId: 2, username: "=HYPERLINK(\"https://example.test\")", name: "+SUM(1,2)",
      category: "余额消费", title: "余额消费", amountCents: -12345, currency: "CNY", balanceAfterCents: 6789,
      statusLabel: "已完成", paymentOrderNo: "0001234567890123456789012345", description: "@literal\n备注",
      createdAt: new Date("2026-10-19T00:12:34Z"),
    } as BillingExportRow;
    async function* rows() { yield [item]; yield [{ ...item, id: "subscription-2", balanceAfterCents: undefined } as unknown as BillingExportRow]; }
    assert.equal(await writeBillingLedgerXlsx(filename, { viewerUserId: 2 }, undefined, rows()), 2);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filename);
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.rowCount, 7);
    assert.equal(sheet.getCell("A6").value, "balance-42");
    assert.equal(sheet.getCell("B6").type, ExcelJS.ValueType.Date);
    assert.equal((sheet.getCell("B6").value as Date).toISOString(), "2026-10-19T08:12:34.000Z");
    assert.equal(sheet.getCell("D6").value, item.username);
    assert.equal(sheet.getCell("D6").type, ExcelJS.ValueType.String);
    assert.equal(sheet.getCell("H6").value, -123.45);
    assert.equal(sheet.getCell("J6").value, 67.89);
    assert.equal(sheet.getCell("J7").value, null);
    assert.equal(sheet.getCell("L6").value, item.paymentOrderNo);
    assert.equal(sheet.getCell("L6").numFmt, "@");
    assert.equal(sheet.getCell("B5").value, "时间（UTC+8）");
    assert.equal(sheet.getCell("H6").numFmt, '#,##0.00;[Red]-#,##0.00;0.00');
    assert.equal(sheet.getRow(5).getCell(1).font.color?.argb, "FFFFFFFF");
    assert.equal(sheet.getCell("A5").fill.type, "pattern");
    assert.notDeepEqual(sheet.getCell("A6").fill, sheet.getCell("A7").fill);
    assert.deepEqual(sheet.autoFilter, "A5:O7");
    assert.equal(sheet.views[0].state, "frozen");
    assert.equal((sheet.views[0] as ExcelJS.WorksheetViewFrozen).ySplit, 5);
    assert.equal(sheet.views[0].showGridLines, false);
    assert.match(String(sheet.getCell("A3").value), /用户 #2/);
    assert.equal(sheet.getCell("N6").value, item.description);
    async function* empty() { /* no records */ }
    await writeBillingLedgerXlsx(filename, { isAdmin: true, viewerUserId: 1 }, undefined, empty());
    const blank = new ExcelJS.Workbook();
    await blank.xlsx.readFile(filename);
    assert.equal(blank.worksheets[0].rowCount, 5);
    assert.match(String(blank.worksheets[0].getCell("A3").value), /全部用户/);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(writeBillingLedgerXlsx(filename, { viewerUserId: 2 }, abort.signal, empty()));
    const midAbort = new AbortController();
    async function* cancelled() { yield [item]; midAbort.abort(); yield [item]; }
    await assert.rejects(writeBillingLedgerXlsx(filename, { viewerUserId: 2 }, midAbort.signal, cancelled()));
    async function* failed() { yield [item]; throw new Error("database failed"); }
    await assert.rejects(writeBillingLedgerXlsx(filename, { viewerUserId: 2 }, undefined, failed()), /database failed/);
    await assert.rejects(writeBillingLedgerXlsx(path.join(directory, "missing", "export.xlsx"), { viewerUserId: 2 }, undefined, empty()), /ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
