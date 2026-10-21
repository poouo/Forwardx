import assert from "node:assert/strict";
import test from "node:test";
import { RULE_TABLE_COLUMNS, defaultRuleTableLayout, normalizeRuleTableLayout, ruleTableColumns, ruleTableLayoutSchema } from "./ruleTableLayout";

test("missing, corrupt or oversized preferences use defaults", () => {
  for (const value of [undefined, null, "", "{invalid", " ".repeat(20_000), { order: ["unknown"] }, { ...defaultRuleTableLayout(), widths: { unknown: 100 } }]) {
    assert.deepEqual(normalizeRuleTableLayout(value), defaultRuleTableLayout());
  }
});

test("normalization deduplicates, appends new columns, protects required columns and clamps widths", () => {
  const layout = normalizeRuleTableLayout({ order: ["entry", "entry", "name"], hidden: ["name", "actions", "daily", "daily"], widths: { name: 48, actions: 50, entry: 900, status: 200 } });
  assert.equal(layout.order.length, RULE_TABLE_COLUMNS.length);
  assert.deepEqual(layout.order.slice(0, 2), ["entry", "name"]);
  assert.deepEqual(layout.hidden, ["daily"]);
  assert.deepEqual(layout.widths, { name: 96, actions: 200, entry: 900, status: 120 });
  assert.deepEqual(normalizeRuleTableLayout(JSON.stringify(layout)), layout);
});

test("visible columns follow saved order and role without exposing the owner column to customers", () => {
  const layout = normalizeRuleTableLayout({ order: ["entry", "owner"], hidden: ["daily", "status"], widths: { entry: 500 } });
  const own = ruleTableColumns(layout, false);
  assert.equal(own[0].id, "entry"); assert.equal(own[0].width, 500);
  assert.ok(!own.some(column => ["owner", "daily", "status"].includes(column.id)));
  assert.ok(ruleTableColumns(layout, true).some(column => column.id === "owner"));
  assert.ok(ruleTableColumns(layout, false, true).some(column => column.id === "daily"));
  assert.ok(!ruleTableColumns(layout, false, true).some(column => column.id === "owner"));
  assert.equal(ruleTableColumns(defaultRuleTableLayout(), true).length, RULE_TABLE_COLUMNS.length);
});

test("API schema rejects unbounded, malformed and unknown settings", () => {
  for (const change of [{ order: Array(RULE_TABLE_COLUMNS.length + 1).fill("name") }, { hidden: ["unknown"] }, { widths: { name: 1e9 } }, { widths: { name: 120.5 } }, { widths: { name: "120" } }, { arbitrary: true }]) {
    assert.equal(ruleTableLayoutSchema.safeParse({ ...defaultRuleTableLayout(), ...change }).success, false);
  }
});

test("group column is available to all accounts without resetting saved list preferences", () => {
  const oldOrder = RULE_TABLE_COLUMNS.filter(column => column.id !== "groups").map(column => column.id);
  const layout = normalizeRuleTableLayout({ order: oldOrder, hidden: ["daily"], widths: { name: 180 } });
  assert.deepEqual(layout.order.slice(0, -1), oldOrder);
  assert.equal(layout.order.at(-1), "groups");
  assert.equal(layout.widths.name, 180);
  assert.deepEqual(layout.hidden, ["daily"]);
  for (const admin of [true, false]) {
    assert.ok(ruleTableColumns(layout, admin).some(column => column.id === "groups"));
    assert.ok(!ruleTableColumns({ ...layout, hidden: [...layout.hidden, "groups"] }, admin).some(column => column.id === "groups"));
  }
});

test("quota is an independent optional column and older saved layouts keep their preferences", () => {
  const previous = { order: RULE_TABLE_COLUMNS.filter(column => column.id !== "quota").map(column => column.id), hidden: ["daily"], widths: { total: 170 } };
  const layout = normalizeRuleTableLayout(previous);
  assert.deepEqual(layout.order.slice(0, -1), previous.order);
  assert.equal(layout.order.at(-1), "quota");
  assert.equal(layout.widths.total, 170);
  assert.deepEqual(layout.hidden, ["daily"]);
  assert.ok(ruleTableColumns(layout, false).some(column => column.id === "quota"));
  assert.ok(!ruleTableColumns({ ...layout, hidden: [...layout.hidden, "quota"] }, false).some(column => column.id === "quota"));
});
