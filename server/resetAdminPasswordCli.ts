import "dotenv/config";
import fs from "fs";
import { pathToFileURL } from "url";
import { createInterface } from "readline";
import { and, eq } from "drizzle-orm";
import { users } from "../drizzle/schema";
import {
  closeDatabase,
  connectDatabase,
  getDatabaseKind,
  getDb,
  nowDate,
  queryRaw,
  quoteDbIdentifier,
  withDatabaseTransaction,
} from "./dbRuntime";
import { ensureDatabaseSchema } from "./dbSchema";
import { hashPassword } from "./password";
import { revokeUserAuthSessions } from "./repositories/sessionRepository";

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const BUSY_RETRY_COUNT = 5;
const BUSY_RETRY_DELAY_MS = 500;

export type ResetAdminPasswordOptions = {
  selector?: string | null;
  newPassword: string;
  enableAccount?: boolean;
};

export type ResetAdminPasswordResult = {
  id: number;
  username: string;
  accountEnabled: boolean;
  twoFactorEnabled: boolean;
};

type CliOptions = {
  help: boolean;
  stdin: boolean;
  selector: string | null;
  enableAccount: boolean;
};

type AdminRow = {
  id: number;
  username: string;
  email: string | null;
  accountEnabled: boolean | number | string | null;
  twoFactorEnabled: boolean | number | string | null;
};

function usage() {
  return [
    "ForwardX administrator password reset",
    "",
    "Usage:",
    "  node dist/reset-admin-password.js",
    "  node dist/reset-admin-password.js --stdin [--username USERNAME_OR_EMAIL]",
    "",
    "Options:",
    "  --stdin              Read selector, password, and confirmation from stdin.",
    "  --username VALUE     Select an administrator by username or email.",
    "  --enable-account     Enable the selected account after resetting its password.",
    "  --help               Show this help.",
    "",
    "The password is never accepted as a command-line argument.",
    "Back up the database before resetting a password.",
  ].join("\n");
}

function takeValue(argv: string[], index: number, option: string) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

export function parseResetAdminPasswordArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    help: false,
    stdin: false,
    selector: null,
    enableAccount: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--stdin") options.stdin = true;
    else if (arg === "--enable-account") options.enableAccount = true;
    else if (arg === "--username") {
      options.selector = takeValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith("--username=")) {
      const value = arg.slice("--username=".length).trim();
      if (!value) throw new Error("--username requires a value");
      options.selector = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

export function validateResetAdminPassword(value: string) {
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
  if (!value.trim()) throw new Error("Password cannot be blank");
}

function normalizeSelector(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function isEnabled(value: unknown) {
  return value === true || value === 1 || String(value ?? "").trim().toLowerCase() === "true" || String(value ?? "").trim() === "1";
}

function isBusyDatabaseError(error: unknown) {
  const code = String((error as any)?.code || "").toUpperCase();
  const message = error instanceof Error ? error.message : String(error);
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /database is locked|database table is locked/i.test(message);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function withBusyRetry<T>(work: () => Promise<T>) {
  let lastError: unknown;
  for (let attempt = 0; attempt < BUSY_RETRY_COUNT; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (!isBusyDatabaseError(error) || attempt === BUSY_RETRY_COUNT - 1) throw error;
      await sleep(BUSY_RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function resetAdminPasswordInTransaction(input: ResetAdminPasswordOptions): Promise<ResetAdminPasswordResult> {
  validateResetAdminPassword(input.newPassword);
  const db = await getDb();
  if (!db) throw new Error("Database is not configured");

  const selector = normalizeSelector(input.selector);
  const admins: AdminRow[] = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      accountEnabled: users.accountEnabled,
      twoFactorEnabled: users.twoFactorEnabled,
    })
    .from(users)
    .where(eq(users.role, "admin"))
    .orderBy(users.id);

  const matches = selector
    ? admins.filter((admin: AdminRow) => normalizeSelector(admin.username) === selector || normalizeSelector(admin.email) === selector)
    : admins;
  if (matches.length === 0) {
    throw new Error(selector ? `No administrator matched '${input.selector}'` : "No administrator account exists");
  }
  if (matches.length > 1) {
    const names = matches.map((admin: AdminRow) => admin.username).join(", ");
    throw new Error(`Administrator selection is ambiguous. Specify --username; candidates: ${names}`);
  }

  const target = matches[0];
  const quote = quoteDbIdentifier;
  const lockSuffix = getDatabaseKind() === "sqlite" ? "" : " FOR UPDATE";
  const locked = await queryRaw<{ id: number; username: string; accountEnabled: any; twoFactorEnabled: any }>(
    `SELECT ${quote("id")} AS ${quote("id")}, ${quote("username")} AS ${quote("username")}, ${quote("accountEnabled")} AS ${quote("accountEnabled")}, ${quote("twoFactorEnabled")} AS ${quote("twoFactorEnabled")} FROM ${quote("users")} WHERE ${quote("id")} = ? AND ${quote("role")} = ?${lockSuffix}`,
    [target.id, "admin"],
  );
  if (locked.length !== 1) throw new Error("The selected administrator no longer exists");
  const current = locked[0];

  await revokeUserAuthSessions(target.id, { reason: "password_reset_cli" });
  const patch: Record<string, unknown> = {
    password: hashPassword(input.newPassword),
    updatedAt: nowDate(),
  };
  if (input.enableAccount) patch.accountEnabled = true;
  await db.update(users).set(patch as any).where(and(eq(users.id, target.id), eq(users.role, "admin")));

  return {
    id: target.id,
    username: String(current.username || target.username),
    accountEnabled: input.enableAccount || isEnabled(current.accountEnabled),
    twoFactorEnabled: isEnabled(current.twoFactorEnabled),
  };
}

export async function resetAdminPassword(input: ResetAdminPasswordOptions) {
  validateResetAdminPassword(input.newPassword);
  return withBusyRetry(() => withDatabaseTransaction(() => resetAdminPasswordInTransaction(input)));
}

async function readLinesFromStdin(selectorOverride: string | null) {
  const content = fs.readFileSync(0, "utf8");
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (selectorOverride) {
    return {
      selector: selectorOverride,
      password: lines[0] ?? "",
      confirmation: lines[1] ?? "",
    };
  }
  return {
    selector: lines[0]?.trim() || null,
    password: lines[1] ?? "",
    confirmation: lines[2] ?? "",
  };
}

async function readLine(prompt: string) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const result = await new Promise<string>((resolve) => rl.question(prompt, resolve));
    return result;
  } finally {
    rl.close();
  }
}

async function readHidden(prompt: string) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return readLine(prompt);
  }
  process.stderr.write(prompt);
  process.stdin.resume();
  process.stdin.setRawMode(true);
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const onData = (chunk: Buffer | string) => {
      const text = String(chunk);
      for (const char of text) {
        if (char === "\u0003") {
          cleanup();
          reject(new Error("Input cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
        } else {
          value += char;
        }
      }
    };
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode?.(false);
    };
    process.stdin.on("data", onData);
  });
}

async function collectInput(options: CliOptions) {
  if (options.stdin) {
    const input = await readLinesFromStdin(options.selector);
    return {
      selector: options.selector || input.selector,
      password: input.password,
      confirmation: input.confirmation,
    };
  }
  if (!process.stdin.isTTY) throw new Error("Use --stdin when input is not an interactive terminal");
  const selector = options.selector || (await readLine("Administrator username or email (blank if only one): ")).trim() || null;
  const password = await readHidden("New password: ");
  const confirmation = await readHidden("Confirm new password: ");
  return { selector, password, confirmation };
}

async function main() {
  const options = parseResetAdminPasswordArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const input = await collectInput(options);
  if (input.password !== input.confirmation) throw new Error("Password confirmation does not match");
  validateResetAdminPassword(input.password);

  try {
    const db = await connectDatabase();
    if (!db || !getDatabaseKind()) throw new Error("Database is not configured");
    await ensureDatabaseSchema();
    const result = await resetAdminPassword({
      selector: input.selector,
      newPassword: input.password,
      enableAccount: options.enableAccount,
    });
    console.log(`[DONE] Administrator password reset: ${result.username}`);
    console.log(`[INFO] All existing sessions were revoked. Two-factor authentication: ${result.twoFactorEnabled ? "enabled (unchanged)" : "disabled"}.`);
    if (!result.accountEnabled) {
      console.warn("[WARN] This administrator account remains disabled. Re-run with --enable-account only if that is intentional.");
    }
  } finally {
    await closeDatabase();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[ERROR] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
