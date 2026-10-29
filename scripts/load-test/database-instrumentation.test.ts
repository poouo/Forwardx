import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { instrumentPoolConnections } from "./database-instrumentation";

for (const kind of ["mysql", "postgresql"] as const) test(`${kind}: SQL instrumentation never overwrites guarded pool methods or recurses into acquisition`, () => {
  const existing = { id: 1 }, fresh = { id: 2 };
  const raw = Object.assign(new EventEmitter(), kind === "mysql"
    ? { _allConnections: { toArray: () => [existing] } } : { _clients: [existing] });
  const pool = new Proxy(kind === "mysql" ? { pool: raw } : raw, {
    get(target: any, key) { const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; },
    set() { throw Error("Do not overwrite pool methods"); },
  });
  const seen: any[] = [];
  const stop = instrumentPoolConnections(pool, kind, client => { seen.push(client); });
  assert.deepEqual(seen, [existing]);
  raw.emit(kind === "mysql" ? "connection" : "connect", fresh);
  assert.deepEqual(seen, [existing, fresh]);
  stop(); raw.emit(kind === "mysql" ? "connection" : "connect", { id: 3 });
  assert.equal(seen.length, 2);
});
