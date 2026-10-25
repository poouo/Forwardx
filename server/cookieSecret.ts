import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function usableSecret(value: string) {
  return value.length >= 32 && !/^change[-_ ]?me/i.test(value) && !/^(.)\1+$/.test(value);
}

export function resolveCookieSecret(secret: string, candidates: string[], warn = console.warn): string {
  secret = secret.trim();
  if (usableSecret(secret)) return secret;
  if (secret) warn("[Security] JWT_SECRET is weak or a placeholder; replacing it with a persistent random secret. Existing sessions must sign in again.");

  for (const filePath of candidates) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").trim() : "";
      if (usableSecret(existing)) return existing;
      const generated = crypto.randomBytes(32).toString("hex");
      try {
        fs.writeFileSync(filePath, `${generated}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // Another process may have initialized the shared volume meanwhile.
        const current = fs.readFileSync(filePath, "utf8").trim();
        if (usableSecret(current)) return current;
        fs.writeFileSync(filePath, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
        fs.chmodSync(filePath, 0o600);
      }
      warn("[Security] Using a generated persistent cookie secret.");
      return generated;
    } catch {
      // Try the next persistent path before falling back to process-local state.
    }
  }
  warn("[Security] No writable secret path was found; using an in-memory cookie secret.");
  return crypto.randomBytes(32).toString("hex");
}
