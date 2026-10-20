import assert from "node:assert/strict";
import test from "node:test";
import { formatHostLoad, parseHostLoadAverage } from "./hostLoad";

test("load averages preserve real zero and reject invalid or missing samples", () => {
  assert.deepEqual(parseHostLoadAverage([0, 0.12, 12.34]), { load1: 0, load5: 0.12, load15: 12.34 });
  for (const value of [undefined, null, "1 2 3", {}, [null, "", false], [-1, NaN, Infinity]]) {
    assert.deepEqual(parseHostLoadAverage(value), { load1: null, load5: null, load15: null });
  }
  assert.deepEqual(parseHostLoadAverage([1.25]), { load1: 1.25, load5: null, load15: null });
  assert.equal(formatHostLoad({ load1: 0, load5: 0.126, load15: 12.34 }), "0.00 / 0.13 / 12.34");
  assert.equal(formatHostLoad(), "— / — / —");
  assert.equal(formatHostLoad({ load1: -1, load5: "0", load15: NaN }), "— / — / —");
});
