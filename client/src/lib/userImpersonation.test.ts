import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createImpersonationWindow, openUserBackend } from "./userImpersonation";

function token(expires = Date.now() + 3_600_000) {
  return `fxi.header.${Buffer.from(JSON.stringify({ exp: Math.floor(expires / 1000) })).toString("base64url")}.signature`;
}
function browser(hash = "") {
  const storage = new Map<string, string>();
  const changes: unknown[] = [];
  return {
    name: "", location: { origin: "https://panel.test", href: "https://panel.test/", pathname: "/", search: "?lang=en", hash },
    history: { state: null, replaceState(...args: unknown[]) { changes.push(args); } },
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } },
    storage, changes,
  };
}
function entry(b: ReturnType<typeof browser>) { return createImpersonationWindow(b as any); }
function fetchSpy() {
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => { calls.push({ input, init }); return new Response("{}"); };
  return { fetch, calls };
}

test("entry removes the secret fragment, stores only in this window and survives a refresh", () => {
  const credential = token();
  const b = browser(`#user-session=${encodeURIComponent(credential)}&other=value`);
  const state = entry(b);
  state.initialize();
  assert.equal(state.getState().mode, "active");
  assert.deepEqual(b.changes, [[null, "", "/?lang=en#other=value"]]);
  b.location.hash = "";
  const reloaded = entry(b);
  reloaded.initialize();
  assert.equal(reloaded.getState().mode, "active");
  const originalWindow = entry(browser());
  originalWindow.initialize();
  assert.equal(originalWindow.getState().mode, "normal");
});

test("same-origin APIs override Cookie/native credentials with delegated bearer, including Request objects", async () => {
  const credential = token();
  const b = browser(`#user-session=${credential}`), state = entry(b), spy = fetchSpy();
  state.initialize();
  const fetch = state.wrapFetch(spy.fetch);
  await fetch("/api/trpc/auth.me", { credentials: "include", headers: { Authorization: "Bearer administrator", "X-Test": "ok" } });
  await fetch(new Request("https://panel.test/api/billing/ledger.xlsx", { credentials: "include", headers: { "X-Request": "ok" } }));
  for (const call of spy.calls) {
    assert.equal(call.init?.credentials, "omit");
    assert.equal(new Headers(call.init?.headers).get("Authorization"), `Bearer ${credential}`);
  }
  assert.equal(new Headers(spy.calls[0].init?.headers).get("X-Test"), "ok");
  assert.equal(new Headers(spy.calls[1].init?.headers).get("X-Request"), "ok");
});

test("external hosts and public assets never receive the delegated credential", async () => {
  const b = browser(`#user-session=${token()}`), state = entry(b), spy = fetchSpy();
  state.initialize();
  const fetch = state.wrapFetch(spy.fetch);
  for (const url of ["https://evil.test/api/trpc/auth.me", "https://panel.test.evil.test/api/data", "/assets/app.js"]) await fetch(url);
  for (const call of spy.calls) assert.equal(call.init, undefined);
});

test("ending a session prevents all further API requests and cannot fall back to administrator Cookies after reload", async () => {
  const b = browser(`#user-session=${token()}`), state = entry(b), spy = fetchSpy();
  state.initialize();
  let changed = 0;
  const unsubscribe = state.subscribe(() => { changed++; });
  state.finish();
  assert.equal(changed, 1);
  unsubscribe();
  await assert.rejects(state.wrapFetch(spy.fetch)("/api/trpc/auth.me"), /用户代入已结束/);
  assert.equal(spy.calls.length, 0);
  b.location.hash = "";
  const reloaded = entry(b);
  reloaded.initialize();
  assert.equal(reloaded.getState().mode, "ended");
  await assert.rejects(reloaded.wrapFetch(spy.fetch)("/api/trpc/auth.me"));
  assert.equal(spy.calls.length, 0);
});

test("malformed, expired and unpersistable tokens fail closed even when storage is unavailable", () => {
  for (const value of ["", "broken", "fxi.bad", token(Date.now() - 1000), "x".repeat(4097)]) {
    const b = browser(`#user-session=${value}`), state = entry(b);
    state.initialize();
    assert.equal(state.getState().mode, "ended");
  }
  const b = browser(`#user-session=${token()}`);
  b.sessionStorage.getItem = () => { throw new Error("private mode"); };
  b.sessionStorage.setItem = () => { throw new Error("private mode"); };
  const state = entry(b);
  state.initialize();
  assert.equal(state.getState().mode, "ended");
  b.location.hash = "";
  const reloaded = entry(b);
  reloaded.initialize();
  assert.equal(reloaded.getState().mode, "ended");
});

test("normal administrator window requests remain unchanged", async () => {
  const state = entry(browser()), spy = fetchSpy();
  state.initialize();
  const init = { credentials: "include" as const, headers: { Authorization: "Bearer original" } };
  await state.wrapFetch(spy.fetch)("/api/trpc/users.list", init);
  assert.equal(spy.calls[0].init, init);
  state.finish();
  assert.equal(state.getState().mode, "normal");
});

test("menu opens synchronously, detaches opener and navigates only after receiving credentials", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const order: string[] = [];
  let destination = "";
  const popup = { opener: {} as unknown, name: "", closed: false, close() { this.closed = true; }, location: { replace(url: string) { destination = url; order.push("navigate"); } } };
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://panel.test" }, open() { order.push("open"); return popup; } } });
    await openUserBackend(async () => {
      order.push("issue");
      assert.equal(popup.opener, null);
      return { token: "secret-value" };
    });
    assert.deepEqual(order, ["open", "issue", "navigate"]);
    assert.equal(destination, "https://panel.test/#user-session=secret-value");
    (globalThis as any).window.open = () => null;
    await assert.rejects(openUserBackend(async () => { throw new Error("must not issue"); }), /请允许浏览器/);
    (globalThis as any).window.open = () => popup;
    await assert.rejects(openUserBackend(async () => { throw new Error("server rejected"); }), /server rejected/);
    assert.equal(popup.closed, true);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("UI shows entry identity, disables unscoped cached statistics and isolates logout/cache clearing", () => {
  const main = readFileSync("client/src/main.tsx", "utf8");
  assert.match(main, /userEntry\.initialize\(\)/);
  assert.match(main, /userEntry\.isEntry\(\) \? \{ clear\(\) \{\} \}/);
  const auth = readFileSync("client/src/_core/hooks/useAuth.ts", "utf8");
  assert.ok(auth.indexOf("if (userEntry.isEntry())") < auth.indexOf("mobileAuth.clear()"));
  const boundary = readFileSync("client/src/components/UserEntryBoundary.tsx", "utf8");
  assert.match(boundary, /正在以 \{0\} 的身份操作/);
  assert.match(boundary, /StatValuePersistenceContext.Provider value=\{state.mode === "normal"\}/);
  assert.match(boundary, /state.mode === "ended"/);
  const styles = readFileSync("client/src/components/UserEntryBoundary.css", "utf8");
  assert.match(styles, /data-mobile-header/);
  assert.match(styles, /data-sidebar="container"/);
  assert.match(styles, /--user-entry-height/);
  const menu = readFileSync("client/src/pages/Users.tsx", "utf8");
  assert.match(menu, /onSelect=\{\(\) => enterBackend\(u.id\)\}/);
  assert.match(menu, /u.role === "admin" \|\| u.accountEnabled === false/);
  const en = JSON.parse(readFileSync("client/src/i18n/en.json", "utf8"));
  for (const key of ["进入后台", "退出代入", "用户代入已结束", "正在以 {0} 的身份操作"]) assert.ok(en[key]);
});
