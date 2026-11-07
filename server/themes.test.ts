import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { randomBytes } from "node:crypto";
import { themeTemplateFiles } from "../shared/themes";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-themes-"));
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = path.join(directory, "themes.db");
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
let runtime: typeof import("./dbRuntime");
let router: typeof import("./routers/themes").themesRouter;
let settings: typeof import("./repositories/settingsRepository");
const context = (role?: string) => ({ user: role ? { id: role === "admin" ? 1 : 2, role, username: role, accountEnabled: true } : null, req: { headers: {}, socket: {} }, res: {}, authSession: null, authFailureReason: null }) as any;
const archive = (version = "1.0.0") => {
  const files = themeTemplateFiles();
  files["theme.json"] = JSON.stringify({ ...JSON.parse(files["theme.json"]), version });
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)])))).toString("base64");
};

before(async () => {
  runtime = await import("./dbRuntime");
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
  await (await import("./dbSchema")).ensureDatabaseSchema();
  settings = await import("./repositories/settingsRepository");
  router = (await import("./routers/themes")).themesRouter;
});
after(async () => { await runtime?.closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }); });

test("theme administration is denied to anonymous and ordinary users", async () => {
  for (const role of [undefined, "user"]) {
    const caller = router.createCaller(context(role));
    const expected = role ? "FORBIDDEN" : "UNAUTHORIZED";
    for (const action of [() => caller.list(), () => caller.install({ archiveBase64: archive() }), () => caller.activate({ id: "ink" }), () => caller.remove({ id: "ink" }), () => caller.template(), () => caller.capabilities(), () => caller.importUrl({ url: "http://127.0.0.1/private" })]) {
      await assert.rejects(action(), error => (error as any).code === expected);
    }
  }
});

test("install, activate, replace and delete preserve the live theme until explicit activation", async () => {
  const caller = router.createCaller(context("admin"));
  const anonymous = router.createCaller(context());
  await settings.setSettings({ personalizationTheme: "sakura" });
  assert.equal((await caller.list()).active.id, "sakura");
  assert.equal((await caller.list()).themes.length, 6);
  const installed = await caller.install({ archiveBase64: archive() });
  assert.equal((await caller.list()).active.id, "sakura");
  assert.equal((await caller.list()).themes.length, 7);
  await assert.rejects(caller.install({ archiveBase64: archive() }), error => (error as any).code === "CONFLICT");
  await assert.rejects(anonymous.styles({ id: installed.id, revision: installed.revision }), error => (error as any).code === "NOT_FOUND");
  await caller.activate({ id: installed.id });
  const publicTheme = await anonymous.styles({ id: installed.id, revision: installed.revision });
  assert.equal(publicTheme.manifest.id, installed.id);
  await assert.rejects(caller.remove({ id: installed.id }), error => (error as any).code === "CONFLICT");
  await assert.rejects(caller.install({ archiveBase64: archive("1.1.0"), replace: true }), error => (error as any).code === "CONFLICT");
  await caller.activate({ id: "ink" });
  const upgraded = await caller.install({ archiveBase64: archive("1.1.0"), replace: true });
  assert.notEqual(upgraded.revision, installed.revision);
  assert.equal((await caller.list()).active.id, "ink");
  await assert.rejects(anonymous.styles({ id: installed.id, revision: installed.revision }), error => (error as any).code === "NOT_FOUND");
  await caller.remove({ id: installed.id });
  await assert.rejects(caller.activate({ id: installed.id }), error => (error as any).code === "NOT_FOUND");
  await assert.rejects(caller.remove({ id: "ink" }), error => (error as any).code === "BAD_REQUEST");
});

test("capabilities and templates expose usable versioned development contracts", async () => {
  const caller = router.createCaller(context("admin"));
  const capabilities = await caller.capabilities();
  assert.equal(capabilities.apiVersion, 1);
  assert.ok(capabilities.formats.includes("rar"));
  assert.ok(capabilities.parts.includes("sidebar"));
  assert.ok(capabilities.features.includes("host-fields"));
  assert.equal(capabilities.fields["host.cpuUsage"].format, "percent");
  assert.equal(Object.hasOwn(capabilities.fields, "host.agentToken"), false);
  const template = await caller.template({ base: "forest" });
  const parsed = await (await import("./themePackage")).parseThemePackage(Buffer.from(template.archiveBase64, "base64"));
  assert.equal(parsed.manifest.base, "forest");
  assert.ok(parsed.manifest.views?.hosts?.card);
  await assert.rejects(caller.install({ archiveBase64: "!!!!" }), error => (error as any).code === "BAD_REQUEST");
});

test("large Base64 archives can be installed, persisted and served after activation", async () => {
  const caller = router.createCaller(context("admin"));
  const values: Record<string, Uint8Array> = Object.fromEntries(Object.entries(themeTemplateFiles()).map(([name, text]) => [name, strToU8(text)]));
  values["assets/background.webp"] = randomBytes(8 * 1024 * 1024);
  values["assets/interface.woff2"] = randomBytes(5 * 1024 * 1024);
  values["theme.css"] = strToU8('body { background-image: url("assets/background.webp"); } @font-face { font-family: Theme; src: url("assets/interface.woff2"); }');
  const encoded = Buffer.from(zipSync(values)).toString("base64");
  assert.ok(encoded.length > 10 * 1024 * 1024);
  const installed = await caller.install({ archiveBase64: encoded });
  await caller.activate({ id: installed.id });
  const theme = await router.createCaller(context()).styles({ id: installed.id, revision: installed.revision });
  assert.ok(theme.css.length > 16 * 1024 * 1024, "embedded images and fonts may exceed the old total registry limit");
  assert.ok(theme.css.includes("data:image/webp;base64,"));
  await caller.activate({ id: "ink" });
  await caller.remove({ id: installed.id });
});
