import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { commissionCents, AFFILIATE_DEFAULTS } from "../shared/affiliate";
import { normalizeSidebarMenuSettings } from "../shared/sidebarMenu";
import {
  captureAffiliateReferral,
  getAffiliateReferral,
  affiliateRequestKey,
} from "../client/src/lib/affiliateReferral";

const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), "forwardx-affiliate-test-"),
);
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = path.join(directory, "db.sqlite");
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
let runtime: typeof import("./dbRuntime");
let repo: typeof import("./repositories/affiliateRepository");
let settings: typeof import("./repositories/settingsRepository");
let router: typeof import("./routers/affiliates").affiliatesRouter;
before(async () => {
  runtime = await import("./dbRuntime");
  await runtime.connectDatabase({
    type: "sqlite",
    sqlite: { path: process.env.SQLITE_PATH! },
  });
  await (await import("./dbSchema")).ensureDatabaseSchema();
  repo = await import("./repositories/affiliateRepository");
  settings = await import("./repositories/settingsRepository");
  router = (await import("./routers/affiliates")).affiliatesRouter;
  for (let id = 1; id <= 40; id++)
    await runtime.insertAndGetId("users", {
      id,
      username: `affiliate-${id}@test.local`,
      password: "unused",
      role: id === 1 ? "admin" : "user",
    });
});
after(async () => {
  await runtime?.closeDatabase();
  assert.equal(
    path.dirname(path.resolve(directory)),
    path.resolve(os.tmpdir()),
  );
  fs.rmSync(directory, { recursive: true, force: true });
});
const enabled = (value: boolean) =>
  settings.setSetting("sidebarMenu", JSON.stringify({ affiliates: value }));
const config = (values = {}) =>
  repo.saveAffiliateConfig({ ...AFFILIATE_DEFAULTS, ...values });
const key = () => crypto.randomUUID();
const caller = (id: number, role = "user") =>
  router.createCaller({
    user: { id, role } as any,
    req: {
      headers: {},
      path: "/api/trpc",
      protocol: "https",
      get: () => "panel.test",
      socket: {},
    } as any,
    res: {} as any,
    authSession: null,
    authFailureReason: null,
  });
async function refer(owner: number, userId: number) {
  const code = await repo.createAffiliateCode(owner);
  await repo.bindAffiliateReferral(userId, code.code);
  return code;
}
async function order(userId: number, outTradeNo: string, extra = {}) {
  await runtime.insertAndGetId("payment_orders", {
    userId,
    outTradeNo,
    provider: "alipay",
    paymentType: "alipay",
    status: "completed",
    subject: "Plan",
    amountCents: 10000,
    currency: "CNY",
    planId: 1,
    orderType: "plan",
    createdAt: Math.floor(Date.now() / 1000),
    ...extra,
  });
  await repo.accrueAffiliateCommission(outTradeNo);
}
async function wallet(userId: number) {
  return (await repo.affiliateOverview(userId)).availableCents;
}

test("affiliate feature is disabled by default and APIs enforce new-code opt-in", async () => {
  assert.equal(normalizeSidebarMenuSettings().affiliates, false);
  assert.equal(await repo.affiliatesEnabled(), false);
  await assert.rejects(() => caller(2).createCode(), { code: "FORBIDDEN" });
  assert.equal((await caller(2).me()).availableCents, 0);
  await enabled(true);
});
test("commission calculation uses cents, floors fractions and rejects unsafe values", () => {
  assert.equal(commissionCents(1800, 2000), 360);
  assert.equal(commissionCents(1, 1500), 0);
  assert.throws(() => commissionCents(-1, 1000));
  assert.throws(() => commissionCents(100, 10001));
  assert.throws(() => commissionCents(Number.MAX_SAFE_INTEGER + 1, 100));
});
test("registration binds once, rejects self/disabled/unknown codes and keeps old referrals when code is disabled", async () => {
  const code = await refer(2, 3);
  assert.equal(await repo.bindAffiliateReferral(2, code.code), false);
  assert.equal(await repo.bindAffiliateReferral(4, "missingcode"), false);
  await assert.rejects(() => repo.bindAffiliateReferral(3, code.code));
  await repo.setAffiliateCodeActive(2, code.id, false);
  assert.equal(await repo.bindAffiliateReferral(4, code.code), false);
  await config({ confirmationDays: 0 });
  await order(3, "first-3");
  assert.equal(await wallet(2), 1500);
});
test("duplicate callbacks accrue only once and first-order mode excludes renewals", async () => {
  await Promise.all(
    Array.from({ length: 5 }, () => repo.accrueAffiliateCommission("first-3")),
  );
  assert.equal(await wallet(2), 1500);
  await order(3, "renewal-3");
  assert.equal(await wallet(2), 1500);
  const rows = await caller(2).list({ kind: "commissions" });
  assert.equal(rows.total, 1);
});
test("continuous commissions use independent user rate, only fulfilled CNY plan payments count", async () => {
  await config({ confirmationDays: 0, firstOrderOnly: false });
  await refer(4, 5);
  await repo.updateAffiliateAccount(1, 4, false, 2000);
  await order(5, "foreign", { currency: "USD" });
  await order(5, "recharge", { planId: null, orderType: "balance" });
  await order(5, "test", { orderType: "test" });
  await order(5, "notpaid", { status: "pending" });
  await order(5, "zero", { amountCents: 0 });
  assert.equal(await wallet(4), 0);
  await order(5, "valid-5");
  await order(5, "valid-5-2");
  assert.equal(await wallet(4), 4000);
});
test("confirmation delay persists, early spending is forbidden, due settlement is idempotent", async () => {
  await config({ confirmationDays: 7, firstOrderOnly: false });
  await refer(6, 7);
  await order(7, "delayed-7");
  assert.equal(await wallet(6), 0);
  assert.equal((await repo.affiliateOverview(6)).pendingCents, 1500);
  await assert.rejects(() =>
    caller(6).transfer({ amountCents: 100, requestKey: key() }),
  );
  await runtime.executeRaw(
    'UPDATE affiliate_commissions SET "confirmAt" = 0 WHERE "userId" = ?',
    [6],
  );
  await Promise.all([
    repo.settleAffiliateCommissions(),
    repo.settleAffiliateCommissions(),
  ]);
  assert.equal(await wallet(6), 1500);
});
test("withdrawal reserves money once; concurrent attempts cannot overspend; reject refunds once", async () => {
  const input = {
    amountCents: 1000,
    method: "alipay" as const,
    payee: "Customer",
    account: "account",
    requestKey: key(),
  };
  const [one, two] = await Promise.all([
    caller(6).requestWithdrawal(input),
    caller(6).requestWithdrawal(input),
  ]);
  assert.equal(one.id, two.id);
  assert.equal(await wallet(6), 500);
  await assert.rejects(() =>
    caller(6).requestWithdrawal({ ...input, requestKey: key() }),
  );
  await caller(1, "admin").reviewWithdrawal({
    id: one.id,
    status: "rejected",
    note: "invalid account",
  });
  await assert.rejects(
    () =>
      caller(1, "admin").reviewWithdrawal({
        id: one.id,
        status: "rejected",
        note: "repeat",
      }),
    { code: "CONFLICT" },
  );
  assert.equal(await wallet(6), 1500);
});
test("transfer is atomic, idempotent and creates exactly one regular balance credit", async () => {
  const input = { amountCents: 500, requestKey: key() };
  await repo.transferAffiliateBalance(6, input.amountCents, input.requestKey);
  await repo.transferAffiliateBalance(6, input.amountCents, input.requestKey);
  assert.equal(await wallet(6), 1000);
  const [user] = await runtime.queryRaw<{ balanceCents: number }>(
    'SELECT "balanceCents" FROM users WHERE id = 6',
  );
  assert.equal(Number(user.balanceCents), 500);
  const [transactions] = await runtime.queryRaw<{ total: number }>(
    'SELECT COUNT(*) AS total FROM balance_transactions WHERE "userId" = 6',
  );
  assert.equal(Number(transactions.total), 1);
});
test("disabled feature stops accrual but preserves history, settlement, withdrawals and transfer obligations", async () => {
  await enabled(false);
  await order(5, "disabled-5");
  assert.equal(await wallet(4), 4000);
  await assert.rejects(() => caller(4).createCode(), { code: "FORBIDDEN" });
  assert.deepEqual(await caller(4).status(), {
    enabled: false,
    hasHistory: true,
  });
  const withdrawal = await caller(4).requestWithdrawal({
    amountCents: 1000,
    method: "bank",
    account: "bank account",
    payee: "Customer",
    requestKey: key(),
  });
  await caller(1, "admin").reviewWithdrawal({
    ...withdrawal,
    status: "paid",
    note: "bank receipt #123",
  });
  assert.equal(await wallet(4), 3000);
  await enabled(true);
});
test("reversal is auditable and idempotent; spent commission becomes debt and pending payout is blocked", async () => {
  const withdrawal = await caller(2).requestWithdrawal({
    amountCents: 1500,
    method: "alipay",
    account: "a",
    payee: "b",
    requestKey: key(),
  });
  const rows = await caller(2).list({ kind: "commissions" });
  await caller(1, "admin").cancelCommission({
    id: rows.items[0].id,
    reason: "refunded order",
  });
  await caller(1, "admin").cancelCommission({
    id: rows.items[0].id,
    reason: "repeat",
  });
  assert.equal(await wallet(2), -1500);
  await assert.rejects(() =>
    caller(1, "admin").reviewWithdrawal({
      ...withdrawal,
      status: "paid",
      note: "do not pay",
    }),
  );
  await caller(1, "admin").reviewWithdrawal({
    ...withdrawal,
    status: "rejected",
    note: "order refunded",
  });
  assert.equal(await wallet(2), 0);
});
test("user APIs ignore forged user filters and prohibit administrator actions", async () => {
  const own = await caller(2).list({ kind: "commissions", userId: 4 });
  assert.ok(own.items.every((row) => Number(row.userId) === 2));
  await assert.rejects(() => caller(2).adminList({ kind: "withdrawals" }), {
    code: "FORBIDDEN",
  });
  await assert.rejects(() => caller(2).saveConfig(AFFILIATE_DEFAULTS), {
    code: "FORBIDDEN",
  });
  await assert.rejects(
    () => caller(2).cancelCommission({ id: 1, reason: "forged" }),
    { code: "FORBIDDEN" },
  );
  await assert.rejects(
    () => caller(4).transfer({ amountCents: -1, requestKey: key() }),
    { code: "BAD_REQUEST" },
  );
});
test("blocked affiliates cannot bind, accrue, withdraw or transfer; historical commission remains", async () => {
  await repo.updateAffiliateAccount(1, 4, true, null);
  const code = (await repo.affiliateOverview(4)).codes[0];
  assert.equal(await repo.bindAffiliateReferral(8, code.code), false);
  await order(5, "blocked-5");
  assert.equal(await wallet(4), 3000);
  await assert.rejects(() =>
    caller(4).transfer({ amountCents: 1, requestKey: key() }),
  );
  await assert.rejects(() =>
    caller(4).requestWithdrawal({
      amountCents: 1000,
      method: "bank",
      account: "a",
      payee: "b",
      requestKey: key(),
    }),
  );
});
test("pending cancellation never credits money and ledger always reconciles with wallet", async () => {
  await refer(8, 9);
  await order(9, "cancel-pending-9");
  const rows = await caller(8).list({ kind: "commissions" });
  await caller(1, "admin").cancelCommission({
    id: rows.items[0].id,
    reason: "refunded before confirmation",
  });
  await runtime.executeRaw(
    'UPDATE affiliate_commissions SET "confirmAt" = 0 WHERE "userId" = 8',
  );
  assert.equal(await wallet(8), 0);
  const accounts = await runtime.queryRaw<{
    userId: number;
    availableCents: number;
  }>("SELECT * FROM affiliate_accounts");
  for (const account of accounts) {
    const [sum] = await runtime.queryRaw<{ total: number }>(
      'SELECT COALESCE(SUM("amountCents"),0) AS total FROM affiliate_ledger WHERE "userId" = ?',
      [account.userId],
    );
    assert.equal(Number(sum.total), Number(account.availableCents));
  }
});
test("referral browser storage validates codes, expiration and unavailable storage", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  captureAffiliateReferral("?ref=abcd1234", storage);
  assert.equal(getAffiliateReferral(storage), "abcd1234");
  captureAffiliateReferral("?ref=%3Cscript%3E", storage);
  assert.equal(getAffiliateReferral(storage), "abcd1234");
  storage.setItem(
    "forwardx.referral",
    JSON.stringify({ code: "abcd1234", at: 1 }),
  );
  assert.equal(getAffiliateReferral(storage), undefined);
  assert.doesNotThrow(() =>
    captureAffiliateReferral("?ref=abcd1234", {
      setItem: () => {
        throw new Error("disabled");
      },
    }),
  );
});

test("request identifiers work without secure-context randomUUID and are unique", () => {
  const keys = new Set(Array.from({ length: 100 }, affiliateRequestKey));
  assert.equal(keys.size, 100);
  for (const value of keys)
    assert.match(
      value,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
});
test("wallet and regular balance both roll back when a transfer transaction fails", async () => {
  const before = await wallet(6);
  const requestKey = key();
  await assert.rejects(() =>
    runtime.withDatabaseTransaction(async () => {
      await repo.transferAffiliateBalance(6, 100, requestKey);
      throw new Error("simulated transaction failure");
    }),
  );
  assert.equal(await wallet(6), before);
  const [user] = await runtime.queryRaw<{ balanceCents: number }>(
    'SELECT "balanceCents" FROM users WHERE id = 6',
  );
  assert.equal(Number(user.balanceCents), 500);
  const entries = await runtime.queryRaw(
    "SELECT id FROM affiliate_ledger WHERE reference = ?",
    [requestKey],
  );
  assert.equal(entries.length, 0);
});
test("code quotas, zero custom rates and first orders during zero-rate periods remain enforced", async () => {
  await config({ maxCodes: 1, confirmationDays: 0, rateBps: 0 });
  const code = await refer(14, 15);
  await assert.rejects(() => caller(14).createCode());
  await order(15, "zero-rate-first");
  await config({ confirmationDays: 0 });
  await order(15, "after-zero-rate-renewal");
  assert.equal(await wallet(14), 0);
  await repo.setAffiliateCodeActive(14, code.id, false);
  await refer(16, 17);
  await repo.updateAffiliateAccount(1, 16, false, 0);
  await order(17, "custom-zero");
  assert.equal(await wallet(16), 0);
  await runtime.executeRaw("DELETE FROM users WHERE id = 16");
  const invite = (await repo.affiliateOverview(16)).codes[0];
  assert.equal(await repo.bindAffiliateReferral(18, invite.code), false);
});
test("actual email and Google first registrations bind referrals, existing Google logins never rebind", async () => {
  await settings.setSetting("authCaptchaEnabled", "false");
  await settings.setSetting("registrationEnabled", "true");
  const code = await repo.createAffiliateCode(18);
  const { authRouter } = await import("./routers/auth");
  const auth = authRouter.createCaller({
    user: null,
    req: { ip: "127.0.0.1", headers: {}, socket: {} } as any,
    res: {} as any,
    authSession: null,
    authFailureReason: null,
  });
  const email = await auth.register({
    username: "referred-new@test.local",
    password: "test-password-123",
    referralCode: code.code,
  });
  const { resolveGoogleAccount } = await import("./googleAccounts");
  const google = await resolveGoogleAccount(
    {
      subject: "affiliate-google",
      email: "google-affiliate@test.local",
      name: "Google affiliate",
    },
    undefined,
    code.code,
  );
  const otherCode = await repo.createAffiliateCode(20);
  await resolveGoogleAccount(
    {
      subject: "affiliate-google",
      email: "google-affiliate@test.local",
      name: "Google affiliate",
    },
    undefined,
    otherCode.code,
  );
  const rows = await runtime.queryRaw<{
    userId: number;
    affiliateUserId: number;
  }>('SELECT * FROM affiliate_referrals WHERE "userId" IN (?, ?)', [
    email.id,
    google.id,
  ]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => Number(row.affiliateUserId) === 18));
});
test("actual signed payment webhook fulfills the plan and accrues once; invalid signatures do neither", async () => {
  await config({ confirmationDays: 0 });
  await refer(22, 23);
  const planId = await runtime.insertAndGetId("subscription_plans", {
    name: "Affiliate paid plan",
    priceCents: 10000,
    portCount: 1,
  });
  const hostId = await runtime.insertAndGetId("hosts", {
    userId: 1,
    name: "Fixture host",
    ip: "127.0.0.1",
    portRangeStart: 20000,
    portRangeEnd: 21000,
  });
  await runtime.insertAndGetId("subscription_plan_hosts", { planId, hostId });
  await runtime.insertAndGetId("payment_orders", {
    userId: 23,
    outTradeNo: "webhook-affiliate",
    provider: "easypay",
    paymentType: "alipay",
    status: "pending",
    subject: "Plan",
    amountCents: 10000,
    currency: "CNY",
    planId,
    orderType: "plan",
    createdAt: Math.floor(Date.now() / 1000),
  });
  await settings.setSetting(
    "paymentConfig",
    JSON.stringify({
      enabled: true,
      easypay: {
        enabled: true,
        pid: "fixture",
        pkey: "fixture-payment-secret",
      },
    }),
  );
  const express = (await import("express")).default;
  const app = express();
  app.use((await import("./payment")).paymentCallbackRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const params: Record<string, string> = {
      pid: "fixture",
      trade_status: "TRADE_SUCCESS",
      trade_no: "fixture-paid",
      out_trade_no: "webhook-affiliate",
      money: "100.00",
    };
    const url = `http://127.0.0.1:${port}/api/payment/webhook/easypay`;
    assert.equal(
      (
        await fetch(
          `${url}?${new URLSearchParams({ ...params, sign: "invalid" })}`,
        )
      ).status,
      400,
    );
    assert.equal(await wallet(22), 0);
    const sign = crypto
      .createHash("md5")
      .update(
        Object.keys(params)
          .sort()
          .map((key) => `${key}=${params[key]}`)
          .join("&") + "fixture-payment-secret",
      )
      .digest("hex");
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(
        `${url}?${new URLSearchParams({ ...params, sign })}`,
      );
      assert.equal(
        response.status,
        200,
        JSON.stringify(
          await (await import("./_core/panelLogger")).getPanelLogs(),
        ),
      );
      assert.equal(await response.text(), "success");
    }
    assert.equal(await wallet(22), 1500);
    const [payment] = await runtime.queryRaw<{ status: string }>(
      'SELECT status FROM payment_orders WHERE "outTradeNo" = ?',
      ["webhook-affiliate"],
    );
    assert.equal(payment.status, "completed");
    const [subscriptions] = await runtime.queryRaw<{ total: number }>(
      'SELECT COUNT(*) AS total FROM user_subscriptions WHERE "paymentOrderNo" = ?',
      ["webhook-affiliate"],
    );
    assert.equal(Number(subscriptions.total), 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});
test("concurrent distinct withdrawal and transfer requests cannot overspend the wallet", async () => {
  await config({ confirmationDays: 0 });
  await refer(24, 25);
  await order(25, "race-wallet-25");
  const withdrawal = {
    amountCents: 1000,
    method: "bank" as const,
    account: "a",
    payee: "b",
  };
  const results = await Promise.allSettled([
    caller(24).requestWithdrawal({ ...withdrawal, requestKey: key() }),
    caller(24).requestWithdrawal({ ...withdrawal, requestKey: key() }),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(await wallet(24), 500);
  const transfers = await Promise.allSettled([
    repo.transferAffiliateBalance(24, 400, key()),
    repo.transferAffiliateBalance(24, 400, key()),
  ]);
  assert.equal(
    transfers.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(await wallet(24), 100);
});
test("live backup exports keep affiliate wallet and ledger consistent while transfers occur", async () => {
  const { exportMigrationSnapshot } = await import("./migration");
  const { validateAffiliateSnapshot } = await import("./affiliateMigration");
  for (let i = 0; i < 3; i++) {
    const [snapshot] = await Promise.all([
      exportMigrationSnapshot(undefined, { dataScope: "essential" }),
      repo.transferAffiliateBalance(24, 10, key()),
    ]);
    assert.equal(validateAffiliateSnapshot(snapshot.tables), true);
  }
});
test("affiliate migration preserves remapped ledger references and rejects unsafe incremental financial merges before writes", async () => {
  const { AFFILIATE_TABLES, validateAffiliateSnapshot } = await import(
    "./affiliateMigration"
  );
  const tables: Record<string, Record<string, any>[]> = {
    users: await runtime.queryRaw("SELECT * FROM users"),
  };
  for (const name of AFFILIATE_TABLES)
    tables[name] = await runtime.queryRaw(`SELECT * FROM ${name}`);
  assert.equal(validateAffiliateSnapshot(tables), true);
  assert.throws(() =>
    validateAffiliateSnapshot({
      affiliate_accounts: tables.affiliate_accounts,
    }),
  );
  assert.throws(() =>
    validateAffiliateSnapshot({ ...tables, affiliate_ledger: [] }),
  );
  const { importMigrationSnapshot } = await import("./migration");
  const snapshot = { version: 1 as const, exportedAt: Date.now(), tables };
  await assert.rejects(
    () => importMigrationSnapshot(snapshot),
    /目标已有推广数据/,
  );
  await runtime.closeDatabase();
  const target = {
    type: "sqlite" as const,
    sqlite: { path: path.join(directory, "target.sqlite") },
  };
  runtime.writeDatabaseConfig(target);
  await runtime.connectDatabase(target);
  await (await import("./dbSchema")).ensureDatabaseSchema();
  await runtime.insertAndGetId("users", {
    id: 100,
    username: "target-admin@test.local",
    password: "unused",
    role: "admin",
  });
  const result = await importMigrationSnapshot(snapshot);
  assert.equal(result.partial, false, JSON.stringify(result.warnings));
  const [owner] = await runtime.queryRaw<{ id: number }>(
    "SELECT id FROM users WHERE username = ?",
    ["affiliate-22@test.local"],
  );
  assert.notEqual(Number(owner.id), 22);
  assert.equal(await wallet(Number(owner.id)), 1500);
  const commissions = await runtime.queryRaw<{ id: number; userId: number }>(
    'SELECT id, "userId" FROM affiliate_commissions',
  );
  const withdrawals = await runtime.queryRaw<{ id: number; userId: number }>(
    'SELECT id, "userId" FROM affiliate_withdrawals',
  );
  const rows = await runtime.queryRaw<{
    type: string;
    reference: string;
    userId: number;
  }>("SELECT * FROM affiliate_ledger");
  for (const row of rows) {
    const refs = ["commission", "reversal", "cancellation"].includes(row.type)
      ? commissions
      : ["withdrawal", "withdrawal_return", "payout"].includes(row.type)
        ? withdrawals
        : null;
    if (refs)
      assert.ok(
        refs.some(
          (ref) =>
            Number(ref.id) === Number(row.reference) &&
            Number(ref.userId) === Number(row.userId),
        ),
      );
  }
  const [orphan] = await runtime.queryRaw<{ userId: number }>(
    'SELECT "userId" FROM affiliate_accounts WHERE "userId" = -16',
  );
  assert.equal(Number(orphan.userId), -16);
  const before = (await runtime.queryRaw("SELECT id FROM users")).length;
  await assert.rejects(
    () => importMigrationSnapshot(snapshot),
    /目标已有推广数据/,
  );
  assert.equal((await runtime.queryRaw("SELECT id FROM users")).length, before);
});
test("MySQL and PostgreSQL generate all affiliate tables with monetary types and unique constraints", async () => {
  const { ensureDatabaseSchema, getDatabaseTableDefs } = await import(
    "./dbSchema"
  );
  for (const kind of ["mysql", "postgresql"] as const) {
    const queries: string[] = [];
    const pool = {
      query: async (sql: string) => {
        queries.push(sql);
        return kind === "mysql" ? [[], []] : { rows: [] };
      },
      execute: async () => [[], []],
      ...(kind === "mysql"
        ? {
            getConnection() {
              throw new Error("unused");
            },
          }
        : {}),
    };
    await ensureDatabaseSchema(pool as any);
    for (const def of getDatabaseTableDefs().filter((table) =>
      table.name.startsWith("affiliate_"),
    )) {
      const create = queries.find(
        (sql) =>
          sql.startsWith("CREATE TABLE IF NOT EXISTS") &&
          sql.includes(def.name),
      );
      assert.ok(create, `${kind}: ${def.name}`);
      if (def.name === "affiliate_accounts") {
        assert.match(create!, /BIGINT/i);
        assert.match(create!, /UNIQUE/i);
      }
      if (def.name === "affiliate_commissions") {
        assert.match(create!, /UNIQUE/i);
        assert.match(create!, /orderNo/);
      }
    }
  }
});
