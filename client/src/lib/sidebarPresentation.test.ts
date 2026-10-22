import assert from "node:assert/strict";
import test from "node:test";
import { clearSidebarPresentation, readSidebarPresentation, saveSidebarPresentation } from "./sidebarPresentation";

test("sidebar snapshots are tab/panel scoped, owner checked and presentation-only", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const memory = new Map<string, string>();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { sessionStorage: {
    getItem: (key: string) => memory.get(key), setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key),
  } } });
  try {
    const scope = "https://panel.test";
    saveSidebarPresentation("1:admin", [{ label: "主菜单", items: [
      { path: "/rules", label: "转发规则", token: "SECRET", userId: 1 } as any,
      { path: "javascript:alert(1)", label: "invalid" },
      { path: "//other.test", label: "invalid" },
      { path: "/rules?token=SECRET", label: "invalid" },
      { path: "/login", label: "invalid" },
    ] }], scope, 1000);
    assert.equal(readSidebarPresentation(undefined, scope, 1001)[0].items.length, 1);
    assert.deepEqual(readSidebarPresentation("2:user", scope, 1001), []);
    assert.deepEqual(readSidebarPresentation("1:admin", "https://other.test", 1001), []);
    assert.deepEqual(readSidebarPresentation(undefined, scope, 1000 + 9 * 3600_000), []);
    assert.deepEqual(readSidebarPresentation(undefined, scope, 999), []);
    assert.doesNotMatch([...memory.values()].join(""), /SECRET|token|userId/);
    clearSidebarPresentation(scope);
    assert.deepEqual(readSidebarPresentation(undefined, scope, 1001), []);
    memory.set("forwardx.sidebar.presentation.v1:" + scope, "{");
    assert.deepEqual(readSidebarPresentation(undefined, scope, 1001), []);
  } finally { if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window"); }
});

test("storage failures never break startup", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { get sessionStorage() { throw Error("blocked"); } } });
  try {
    assert.deepEqual(readSidebarPresentation(undefined, "panel"), []);
    assert.doesNotThrow(() => saveSidebarPresentation("1", [], "panel"));
    assert.doesNotThrow(() => clearSidebarPresentation("panel"));
  } finally { if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window"); }
});
