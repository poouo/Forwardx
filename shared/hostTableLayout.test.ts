import assert from "node:assert/strict";
import test from "node:test";
import { HOST_TABLE_COLUMNS, defaultHostTableLayout, hostTableColumns, hostTableLayoutSchema, normalizeHostTableLayout } from "./hostTableLayout";

test("missing, invalid and oversized host layouts use compact defaults", () => {
  for (const input of [null, undefined, "broken", "x".repeat(16_385), {}, { ...defaultHostTableLayout(), widths: { name: Infinity } }]) {
    assert.deepEqual(normalizeHostTableLayout(input), defaultHostTableLayout());
  }
  const defaults = hostTableColumns(defaultHostTableLayout());
  assert.ok(defaults.some(column => column.id === "name"));
  assert.ok(defaults.some(column => column.id === "actions"));
  assert.ok(!defaults.some(column => column.id === "version"));
  assert.equal(hostTableColumns(defaultHostTableLayout(), true).length, HOST_TABLE_COLUMNS.length);
});

test("host layout normalizes order, protects required columns and clamps per-column widths", () => {
  const input = { order: ["address", "name", "address"], hidden: ["status", "name", "actions", "status"], widths: { name: 48, cpu: 900, address: 240 } };
  const normalized = normalizeHostTableLayout(input);
  assert.deepEqual(normalized.order.slice(0, 2), ["address", "name"]);
  assert.equal(new Set(normalized.order).size, HOST_TABLE_COLUMNS.length);
  assert.deepEqual(normalized.hidden, ["status"]);
  assert.deepEqual(normalized.widths, { name: 120, cpu: 400, address: 240 });
  assert.deepEqual(normalizeHostTableLayout(JSON.stringify(input)), normalized);
  const visible = hostTableColumns(normalized);
  assert.equal(visible[0].id, "address");
  assert.equal(visible[0].width, 240);
  assert.ok(!visible.some(column => column.id === "status"));
});

test("all host detail columns can be controlled independently", () => {
  const columns = hostTableColumns({ ...defaultHostTableLayout(), hidden: [] });
  for (const id of ["status", "region", "address", "version", "load", "uptime", "expiry", "cpu", "memory", "disk", "total", "network", "system"]) {
    assert.ok(columns.some(column => column.id === id && !column.required), id);
  }
});

test("host layout API schema rejects unknown fields, excessive arrays and invalid widths", () => {
  const layout = defaultHostTableLayout();
  for (const input of [
    { ...layout, extra: true }, { ...layout, order: ["unknown"] },
    { ...layout, hidden: Array(100).fill("status") }, { ...layout, widths: { name: 1e9 } },
    { ...layout, widths: { name: 120.5 } }, { ...layout, widths: { nonexistent: 150 } },
  ]) assert.equal(hostTableLayoutSchema.safeParse(input).success, false);
});
