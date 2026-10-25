import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { devBackendArguments, devBackendProxy, latestBackendPort } from "./dev-panel-runtime.mjs";

test("backend announcements select the latest valid port and update the proxy after restarts", () => {
  assert.equal(latestBackendPort("starting..."), null);
  assert.equal(latestBackendPort("ForwardX panel started on HTTP port 65536"), null);
  let port = latestBackendPort("ForwardX panel started on HTTP port 3000 startupMs=15");
  const proxy = devBackendProxy(() => port);
  assert.equal(proxy.target, "http://127.0.0.1:3000");
  const runtimeOptions = { ...proxy };
  proxy.configure({ options: runtimeOptions });
  port = latestBackendPort("ForwardX panel started on HTTP port 3000\nRestarting\nForwardX panel started on HTTP port 3001 startupMs=20");
  assert.equal(port, 3001);
  const options = { ...proxy };
  assert.equal(proxy.bypass({}, {}, options), undefined);
  assert.equal(options.target, "http://127.0.0.1:3001");
  assert.equal(runtimeOptions.target, "http://127.0.0.1:3001");
});

test("development backend reloads imported TypeScript changes, not just the entry file", { timeout: 40_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-dev-watch-"));
  const dependency = path.join(directory, "route.ts");
  const entry = path.join(directory, "server.ts");
  fs.writeFileSync(dependency, 'export const value = "before";');
  fs.writeFileSync(entry, 'import { value } from "./route.ts"; console.log("watch-ready:" + value); setInterval(() => {}, 1000);');
  const child = spawn(process.execPath, devBackendArguments(entry), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const readers = new Set();
  const receive = chunk => {
    output = (output + chunk.toString()).slice(-8192);
    for (const reader of readers) reader();
  };
  child.stdout.on("data", receive);
  child.stderr.on("data", receive);
  const waitFor = expected => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { readers.delete(check); reject(new Error(`Missing ${expected}: ${output}`)); }, 10_000);
    const check = () => {
      if (!output.includes(expected)) return;
      clearTimeout(timer);
      readers.delete(check);
      resolve();
    };
    readers.add(check);
    check();
  });
  try {
    await waitFor("watch-ready:before");
    fs.writeFileSync(dependency, 'export const value = "after";');
    await waitFor("watch-ready:after");
    assert.equal(child.exitCode, null);
  } finally {
    // Never await a kill without a bound: a watcher that ignores the signal, or
    // an unresponsive taskkill, would otherwise hang the whole test run instead
    // of failing it.
    await new Promise(resolve => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once("exit", done);
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
        killer.once("exit", done);
        killer.once("error", done);
      } else {
        child.kill("SIGTERM");
      }
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The process already exited.
        }
        done();
      }, 5_000);
      timer.unref?.();
    });
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
