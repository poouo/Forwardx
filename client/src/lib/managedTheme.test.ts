import assert from "node:assert/strict";
import test from "node:test";
import { applyManagedTheme, clearManagedTheme } from "./managedTheme";
import { getPersonalizationThemePreset } from "@shared/personalization";
import { themeTemplateFiles, type ThemeDefinition } from "@shared/themes";

function fakeRoot() {
  const styles = new Map<string, string>(), attributes = new Map<string, string>(), nodes: any[] = [];
  let dark = false;
  const root = {
    classList: { contains: () => dark }, style: { setProperty: (key: string, value: string) => styles.set(key, value), removeProperty: (key: string) => styles.delete(key) },
    setAttribute: (key: string, value: string) => attributes.set(key, value), removeAttribute: (key: string) => attributes.delete(key),
    ownerDocument: { getElementById: (id: string) => nodes.find(node => node.id === id), createElement: () => {
      const node = { id: "", textContent: "", remove: () => nodes.splice(nodes.indexOf(node), 1) }; return node;
    }, head: { appendChild: (node: unknown) => nodes.push(node) } },
  } as unknown as HTMLElement;
  return { root, styles, attributes, nodes, dark: () => { dark = true; } };
}

test("switching custom themes and color modes clears old variables, aliases and stylesheet", () => {
  const dom = fakeRoot();
  const definition: ThemeDefinition = { manifest: JSON.parse(themeTemplateFiles()["theme.json"]), css: 'body { border: 0 }', revision: "test" };
  definition.manifest.variables = { light: { "--primary": "red", "--radius": "3px", "--font-sans": "serif" }, dark: { "--primary": "blue" } };
  definition.manifest.views = { shell: { navigation: "right", sidebarWidth: 260, contentWidth: 1400, spacing: "compact" } };
  applyManagedTheme("teal", definition, dom.root);
  assert.equal(dom.styles.get("--primary"), "red");
  assert.equal(dom.styles.get("--color-primary"), "red");
  assert.equal(dom.styles.get("--font-sans"), "serif");
  assert.equal(dom.nodes.length, 1);
  assert.equal(dom.attributes.get("data-theme-navigation"), "right");
  assert.equal(dom.styles.get("--theme-sidebar-width"), "260px");
  assert.equal(dom.styles.get("--theme-content-width"), "1400px");
  dom.dark(); applyManagedTheme("teal", definition, dom.root);
  assert.equal(dom.styles.get("--primary"), "blue");
  assert.equal(dom.nodes.length, 1);
  applyManagedTheme("sakura", null, dom.root);
  assert.equal(dom.styles.get("--primary"), getPersonalizationThemePreset("sakura").dark.primary);
  assert.equal(dom.styles.has("--radius"), false);
  assert.equal(dom.styles.has("--font-sans"), false);
  assert.equal(dom.styles.has("--theme-sidebar-width"), false);
  assert.equal(dom.attributes.has("data-theme-navigation"), false);
  assert.equal(dom.nodes.length, 0);
  assert.equal(dom.attributes.get("data-forwardx-theme"), "sakura");
  clearManagedTheme(dom.root);
  assert.equal(dom.styles.size, 0); assert.equal(dom.attributes.size, 0);
});
