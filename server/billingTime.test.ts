import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  BILLING_DATE_TIME_FORMAT_OPTIONS,
  billingAddMonthsClamped,
  billingCalendarParts,
  billingMonthStart,
  billingMonthlyBoundary,
  billingStartOfCalendarDay,
} from "../shared/billingTime";

test("billing calendar boundaries use Asia/Shanghai instead of the process time zone", () => {
  const reference = new Date("2026-08-03T02:00:00.000Z");
  assert.equal(billingMonthStart(reference).toISOString(), "2026-07-31T16:00:00.000Z");
  assert.equal(billingMonthlyBoundary(reference, 23).toISOString(), "2026-08-22T16:00:00.000Z");
  assert.equal(billingMonthlyBoundary(reference, 23, 1).toISOString(), "2026-09-22T16:00:00.000Z");
  assert.equal(
    billingMonthlyBoundary(new Date("2027-02-10T00:00:00.000Z"), 31, 0, 31).toISOString(),
    "2027-02-27T16:00:00.000Z",
  );
  assert.equal(
    billingAddMonthsClamped(new Date("2026-01-30T20:15:00.000Z"), 1).toISOString(),
    "2026-02-27T20:15:00.000Z",
  );
  assert.equal(
    billingStartOfCalendarDay(billingAddMonthsClamped(new Date("2026-01-30T20:15:00.000Z"), 1)).toISOString(),
    "2026-02-27T16:00:00.000Z",
  );

  assert.deepEqual(billingCalendarParts("2026-08-22T15:59:59.000Z"), {
    year: 2026,
    month: 8,
    day: 22,
    hour: 23,
    minute: 59,
    second: 59,
  });
  assert.deepEqual(billingCalendarParts("2026-08-22T16:00:00.000Z"), {
    year: 2026,
    month: 8,
    day: 23,
    hour: 0,
    minute: 0,
    second: 0,
  });
});

test("billing boundaries and display stay identical across process time zones", () => {
  const moduleUrl = pathToFileURL(path.join(process.cwd(), "shared/billingTime.ts")).href;
  const script = String.raw`
    const billing = await import(${JSON.stringify(moduleUrl)});
    const reference = new Date("2026-08-03T02:00:00.000Z");
    const boundary = billing.billingMonthlyBoundary(reference, 23);
    process.stdout.write(JSON.stringify({
      boundary: boundary.toISOString(),
      monthStart: billing.billingMonthStart(reference).toISOString(),
      currentDay: billing.billingCalendarParts("2026-08-22T16:00:00.000Z").day,
      anchored: billing.billingAddMonthsClamped("2026-01-30T20:15:00.000Z", 1).toISOString(),
      anchoredBoundary: billing.billingStartOfCalendarDay(
        billing.billingAddMonthsClamped("2026-01-30T20:15:00.000Z", 1),
      ).toISOString(),
      display: boundary.toLocaleString("zh-CN", billing.BILLING_DATE_TIME_FORMAT_OPTIONS),
    }));
  `;

  const results = ["UTC", "Asia/Shanghai", "America/Los_Angeles"].map((timeZone) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, TZ: timeZone },
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(result.status, 0, `${timeZone}: ${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout);
  });

  for (const result of results) {
    assert.deepEqual(result, results[0]);
    assert.equal(result.boundary, "2026-08-22T16:00:00.000Z");
    assert.equal(result.monthStart, "2026-07-31T16:00:00.000Z");
    assert.equal(result.currentDay, 23);
    assert.equal(result.anchored, "2026-02-27T20:15:00.000Z");
    assert.equal(result.anchoredBoundary, "2026-02-27T16:00:00.000Z");
    assert.match(result.display, /00:00:00/);
  }
});

test("billing display options do not expose the UTC storage offset", () => {
  const boundary = new Date("2026-08-22T16:00:00.000Z");
  assert.match(boundary.toLocaleString("zh-CN", BILLING_DATE_TIME_FORMAT_OPTIONS), /2026\/8\/23 00:00:00/);
});

test("user and host monthly reset selection changes at the billing boundary in every process time zone", () => {
  const moduleUrl = (file: string) => pathToFileURL(path.join(process.cwd(), file)).href;
  const script = String.raw`
    const runtime = await import(${JSON.stringify(moduleUrl("server/dbRuntime.ts"))});
    const schema = await import(${JSON.stringify(moduleUrl("server/dbSchema.ts"))});
    const users = await import(${JSON.stringify(moduleUrl("server/repositories/userRepository.ts"))});
    const hosts = await import(${JSON.stringify(moduleUrl("server/repositories/hostRepository.ts"))});
    const epoch = (value) => Math.floor(new Date(value).getTime() / 1000);
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      for (const [id, resetDay, lastReset] of [
        [1, 23, null],
        [2, 24, null],
        [3, 23, epoch("2026-07-31T16:00:00.000Z")],
        [4, 23, epoch("2026-07-31T15:59:59.000Z")],
      ]) {
        await runtime.executeRaw(
          'INSERT INTO "users" ("id", "username", "password", "role", "trafficAutoReset", "trafficResetDay", "lastTrafficReset") VALUES (?, ?, ?, ?, ?, ?, ?)',
          [id, "billing-user-" + id, "hash", "user", 1, resetDay, lastReset],
        );
        await runtime.executeRaw(
          'INSERT INTO "hosts" ("id", "name", "ip", "userId", "portRangeStart", "portRangeEnd", "trafficAutoReset", "trafficResetDay", "lastTrafficReset") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [id, "billing-host-" + id, "127.0.0." + id, id, 10000 + id, 10000 + id, 1, resetDay, lastReset],
        );
      }

      const before = new Date("2026-08-22T15:59:59.000Z");
      const boundary = new Date("2026-08-22T16:00:00.000Z");
      const ids = (rows) => rows.map((row) => Number(row.id)).sort((left, right) => left - right);
      process.stdout.write("\n__BILLING_RESULT__" + JSON.stringify({
        usersBefore: ids(await users.getUsersForAutoReset(before)),
        usersAt: ids(await users.getUsersForAutoReset(boundary)),
        hostsBefore: ids(await hosts.getHostsForTrafficAutoReset(before)),
        hostsAt: ids(await hosts.getHostsForTrafficAutoReset(boundary)),
      }));
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `;

  const results = ["UTC", "Asia/Shanghai"].map((timeZone) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-billing-boundary-"));
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TZ: timeZone,
          DATABASE_TYPE: "sqlite",
          FORWARDX_TEST_DB: path.join(directory, "billing-boundary.db"),
        },
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(result.status, 0, `${timeZone}: ${result.stdout}\n${result.stderr}`);
      return JSON.parse(result.stdout.split("__BILLING_RESULT__").pop() || "");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  assert.deepEqual(results, [
    { usersBefore: [], usersAt: [1, 4], hostsBefore: [], hostsAt: [1, 4] },
    { usersBefore: [], usersAt: [1, 4], hostsBefore: [], hostsAt: [1, 4] },
  ]);
});
