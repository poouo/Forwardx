import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createSidebarScrollMemory } from "./sidebarScroll";

function viewport(max = 600) {
  let top = 0;
  return {
    max,
    get scrollTop() { return top; },
    set scrollTop(value: number) { top = Math.max(0, Math.min(this.max, value)); },
  };
}

test("sidebar keeps its lower scroll offset across page shell remounts and rapid navigation", () => {
  const remember = createSidebarScrollMemory();
  const first = viewport();
  const previous = remember(first, "admin:expanded");
  previous.restore();
  first.scrollTop = 420;
  previous.save();
  for (let page = 0; page < 5; page++) {
    const next = viewport();
    const scroll = remember(next, "admin:expanded");
    scroll.restore();
    assert.equal(next.scrollTop, 420);
    scroll.save();
  }
});

test("sidebar remembers intentional scrolling back to the top", () => {
  const remember = createSidebarScrollMemory();
  const content = viewport();
  const scroll = remember(content, "admin:expanded");
  scroll.restore();
  content.scrollTop = 420;
  scroll.save();
  content.scrollTop = 0;
  scroll.save();
  const next = viewport();
  remember(next, "admin:expanded").restore();
  assert.equal(next.scrollTop, 0);
});

test("account, desktop expansion and mobile offsets are isolated", () => {
  const remember = createSidebarScrollMemory();
  for (const [key, top] of [["admin:expanded", 420], ["admin:collapsed", 180], ["admin:mobile", 260], ["user:expanded", 60]] as const) {
    const content = viewport();
    const scroll = remember(content, key);
    scroll.restore();
    assert.equal(content.scrollTop, 0);
    content.scrollTop = top;
    scroll.save();
  }
  for (const [key, top] of [["admin:expanded", 420], ["admin:collapsed", 180], ["admin:mobile", 260], ["user:expanded", 60]] as const) {
    const content = viewport();
    remember(content, key).restore();
    assert.equal(content.scrollTop, top);
  }
});

test("async menus retry a clamped restore without losing the saved position", () => {
  const remember = createSidebarScrollMemory();
  const first = viewport();
  const previous = remember(first, "admin:expanded");
  previous.restore();
  first.scrollTop = 420;
  previous.save();
  const next = viewport(100);
  const scroll = remember(next, "admin:expanded");
  scroll.restore();
  assert.equal(next.scrollTop, 100);
  scroll.save(); // Includes scroll events and cleanup before menus finish loading.
  const retry = remember(next, "admin:expanded");
  next.max = 600;
  retry.restore();
  assert.equal(next.scrollTop, 420);
  next.scrollTop = 250;
  retry.save();
  retry.restore(); // Later marker/resize measurements must not undo user scrolling.
  assert.equal(next.scrollTop, 250);
});

test("user scrolling cancels a pending restoration", () => {
  const remember = createSidebarScrollMemory();
  const first = viewport();
  const previous = remember(first, "admin:expanded");
  previous.restore();
  first.scrollTop = 420;
  previous.save();
  const next = viewport(100);
  const scroll = remember(next, "admin:expanded");
  scroll.restore();
  scroll.interrupt();
  next.scrollTop = 30;
  scroll.save();
  next.max = 600;
  scroll.restore();
  assert.equal(next.scrollTop, 30);
  const later = viewport();
  remember(later, "admin:expanded").restore();
  assert.equal(later.scrollTop, 30);
});

test("sidebar connects scroll memory to layout measurement and cleans up listeners", () => {
  const source = readFileSync("client/src/components/PearlSidebarContent.tsx", "utf8");
  const layout = readFileSync("client/src/components/DashboardLayout.tsx", "utf8");
  assert.match(layout, /scrollKey=\{`\$\{user\?\.id\}:\$\{user\?\.role\}`\}/);
  assert.match(source, /useLayoutEffect\([\s\S]*rememberSidebarScroll/);
  assert.match(source, /scroll\.restore\(\);[\s\S]*const active = content\.querySelector/);
  assert.match(source, /addEventListener\("scroll", scroll\.save, \{ passive: true \}\)/);
  assert.match(source, /return \(\) => \{\s*scroll\.save\(\);\s*content\.removeEventListener\("scroll", scroll\.save\)/);
  assert.match(source, /\[activeKey, scrollKey, state, isMobile\]/);
});
