import assert from "node:assert/strict";
import test from "node:test";
import { pruneMapEntries, setBoundedMapValue } from "./boundedCache";

test("bounded maps evict the oldest entry and refresh updated keys", () => {
  const cache = new Map<string, number>();
  setBoundedMapValue(cache, "a", 1, 2);
  setBoundedMapValue(cache, "b", 2, 2);
  setBoundedMapValue(cache, "a", 3, 2);
  setBoundedMapValue(cache, "c", 4, 2);
  assert.deepEqual(Array.from(cache.entries()), [["a", 3], ["c", 4]]);

  assert.equal(pruneMapEntries(cache, (value) => value < 4), 1);
  assert.deepEqual(Array.from(cache.entries()), [["c", 4]]);
});
