import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveCookieSecret } from "./cookieSecret";

test("missing/weak/placeholder secrets become random and persist across restarts", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fwx-cookie-secret-"));
  try {
    for (const [index, weak] of ["", "change-me-to-a-random-string", "change-me-to-a-random-string-please", "short-secret", "x".repeat(64)].entries()) {
      const secretPath = path.join(directory, String(index), "jwt.secret");
      const warnings: string[] = [];
      const first = resolveCookieSecret(weak, [secretPath], (message) => warnings.push(message));
      assert.match(first, /^[a-f0-9]{64}$/);
      assert.notEqual(first, weak);
      assert.equal(resolveCookieSecret(weak, [secretPath], () => {}), first);
      assert.equal(fs.readFileSync(secretPath, "utf8").trim(), first);
      if (weak) assert.ok(warnings.every((message) => !message.includes(weak)));
      if (process.platform !== "win32") assert.equal(fs.statSync(secretPath).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("configured strong secrets remain unchanged; insecure stored secrets rotate", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fwx-cookie-secret-"));
  const secretPath = path.join(directory, "jwt.secret");
  const strong = "existing-random-test-secret-with-32-characters";
  try {
    assert.equal(resolveCookieSecret(strong, [], () => {}), strong);
    fs.writeFileSync(secretPath, "change-me-to-a-random-string-with-padding");
    const rotated = resolveCookieSecret("", [secretPath], () => {});
    assert.match(rotated, /^[a-f0-9]{64}$/);
    assert.equal(resolveCookieSecret("", [secretPath], () => {}), rotated);
    const first = resolveCookieSecret("", [directory], () => {});
    assert.notEqual(resolveCookieSecret("", [directory], () => {}), first);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("deployment templates no longer supply a shared signing secret", () => {
  for (const name of ["docker-compose.yml", "scripts/install-panel-docker.sh", ".env.example"]) {
    assert.doesNotMatch(fs.readFileSync(name, "utf8"), /JWT_SECRET[^\r\n]*change-me-to-a-random-string/);
  }
});
