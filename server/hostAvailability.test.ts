import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostAvailabilityRecorder, availabilityDays, addAvailabilityInterval, finishAvailabilityDays, type AvailabilityInterval } from "./hostAvailability";

function memoryRecorder() {
  const rows: AvailabilityInterval[] = [];
  const recorder = new HostAvailabilityRecorder({
    async insert(row) { rows.push({ ...row }); },
    async extend(key, endAt) { rows.find((row) => row.observationKey === key)!.endAt = endAt; },
  });
  return { rows, recorder };
}

test("availability counts one incident per transition, not per sweep; ignores stale observations", async () => {
  const { recorder, rows } = memoryRecorder();
  for (const [at, online] of [[1000, true], [1030, true], [1050, false], [1080, false], [1110, false], [1120, true], [1150, true]] as const) await recorder.observe(1, online, at * 1000);
  await recorder.observe(1, false, 1100 * 1000);
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((row) => row.offlineIncident).length, 1);
  assert.equal(rows[0].endAt, 1050);
  assert.equal(rows[1].endAt - rows[1].startAt, 70);
  assert.equal(recorder.snapshot(1)?.online, true);
});

test("initial offline, panel downtime and recorder restart do not invent transitions or uptime", async () => {
  const { recorder, rows } = memoryRecorder();
  await recorder.observe(1, false, 1000_000);
  await recorder.observe(1, false, 1030_000);
  await recorder.observe(1, true, 1040_000);
  await recorder.observe(1, false, 1300_000);
  assert.equal(rows.filter((row) => row.offlineIncident).length, 0);
  assert.equal(rows[1].endAt, 1040);
  assert.equal(rows[2].startAt, 1300);
  const restarted = new HostAvailabilityRecorder({ async insert(row) { rows.push({ ...row }); }, async extend() { throw new Error("must not extend a previous process interval"); } });
  await restarted.observe(1, true, 1400_000);
  const days = availabilityDays([1000, 1500], 1500);
  rows.forEach((row) => addAvailabilityInterval(days, row));
  const result = finishAvailabilityDays(days)[0];
  assert.equal(result.offlineSeconds, 40);
  assert.equal(result.onlineSeconds, 0);
  assert.equal(result.unknownSeconds, 460);
  assert.equal(result.uptimePercent, 0);
  assert.equal(result.coveragePercent, 8);
});

test("cross-midnight outage splits duration but not incident count; day rate is duration weighted", () => {
  const days = availabilityDays([0, 86400, 172800], 172800);
  const row = (online: boolean, startAt: number, endAt: number, offlineIncident = false) => ({ observationKey: "test", hostId: 1, online, startAt, endAt, offlineIncident });
  [row(true, 0, 86340), row(false, 86340, 86460, true), row(true, 86460, 172800)].forEach((r) => addAvailabilityInterval(days, r));
  for (const [index, day] of finishAvailabilityDays(days).entries()) {
    assert.equal(day.offlineCount, index === 0 ? 1 : 0);
    assert.equal(day.offlineSeconds, 60);
    assert.equal(day.uptimePercent, 86340 / 86400 * 100);
    assert.equal(day.coveragePercent, 100);
  }
  assert.equal(finishAvailabilityDays(availabilityDays([0, 100], 100))[0].uptimePercent, null);
});

test("per-host concurrent observations serialize and store failures remain retryable", async () => {
  const { recorder, rows } = memoryRecorder();
  await Promise.all([recorder.observe(1, true, 1000_000), recorder.observe(1, false, 1010_000), recorder.observe(1, false, 1020_000), recorder.observe(1, true, 1030_000)]);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].offlineIncident, true);
  let failing = true;
  const retryRows: AvailabilityInterval[] = [];
  const retry = new HostAvailabilityRecorder({
    async insert(row) { if (failing) throw new Error("unavailable"); retryRows.push(row); }, async extend() {},
  });
  await assert.rejects(retry.observe(2, true, 1000_000));
  assert.equal(retry.snapshot(2), undefined);
  failing = false;
  await retry.observe(2, true, 1010_000);
  assert.equal(retryRows.length, 1);
});

test("availability history uses configured DB, scopes host access, pages full histories and retains 30 days", async () => {
  process.env.DATABASE_TYPE = "sqlite";
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  const repository = await import("./repositories/hostAvailabilityRepository");
  const { hostsRouter } = await import("./routers/hosts");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-availability-"));
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: path.join(directory, "history.db") } });
    await ensureDatabaseSchema();
    const now = Math.floor(Date.now() / 1000);
    const start = Math.floor(now / 86400) * 86400 - 2 * 86400;
    const end = start + 86400;
    await runtime.withSqliteExclusive((sqlite) => {
      sqlite.prepare("INSERT INTO hosts (id, name, ip, userId) VALUES (1, 'test', '127.0.0.1', 1), (2, 'other', '127.0.0.2', 2)").run();
      const insert = sqlite.prepare("INSERT INTO host_availability_intervals (observationKey, hostId, online, offlineIncident, startAt, endAt) VALUES (?, ?, ?, ?, ?, ?)");
      insert.run("outside", 1, 0, 1, start - 60, start);
      for (let index = 0; index < 2100; index++) insert.run(`row-${index}`, 1, index % 2 === 0 ? 1 : 0, index % 2, start + index * 2, start + (index + 1) * 2);
      insert.run("next-day", 1, 0, 1, end, end + 60);
      insert.run("other-host", 2, 0, 1, start, end);
      insert.run("expired", 1, 1, 0, now - 32 * 86400, now - 31 * 86400);
      insert.run("ongoing-old", 2, 1, 0, now - 32 * 86400, now - 29 * 86400);
    });
    const input = { since: new Date(start * 1000), until: new Date(end * 1000) };
    const result = await repository.getHostAvailability(1, input);
    assert.equal(result.intervals.length, 2100);
    assert.equal(result.days[0].offlineCount, 1050);
    assert.equal(result.days[0].offlineSeconds, 2100);
    assert.equal(result.days[0].onlineSeconds, 2100);
    assert.equal(result.days[0].uptimePercent, 50);
    assert.equal(result.days[0].unknownSeconds, 86400 - 4200);
    const boundaries = Array.from({ length: 31 }, (_, index) => new Date((end - 29 * 86400 + index * 86400) * 1000));
    const summary = await repository.getHostAvailability(1, { since: boundaries[0], until: boundaries[30], dayBoundaries: boundaries });
    assert.equal(summary.days.length, 30);
    assert.equal(summary.intervals.length, 0);
    assert.equal(summary.days.find((day) => day.startAt === start)?.offlineCount, 1050);
    const context = (id: number, role = "user") => ({ req: { headers: {} }, res: {}, user: { id, role, accountEnabled: true } } as any);
    const routeInput = { hostId: 1, hours: 24, startAt: input.since, endAt: input.until };
    assert.equal((await hostsRouter.createCaller(context(1)).availabilityHistory(routeInput)).days[0].offlineCount, 1050);
    await assert.rejects(hostsRouter.createCaller(context(2)).availabilityHistory(routeInput), /无权/);
    await assert.rejects(hostsRouter.createCaller({ ...context(1), user: null }).availabilityHistory(routeInput));
    assert.equal((await hostsRouter.createCaller(context(2, "admin")).availabilityHistory(routeInput)).days[0].uptimePercent, 50);
    await repository.cleanOldHostAvailability();
    assert.equal((await runtime.queryRaw("SELECT * FROM host_availability_intervals WHERE observationKey = 'expired'")).length, 0);
    assert.equal((await runtime.queryRaw("SELECT * FROM host_availability_intervals WHERE observationKey = 'ongoing-old'")).length, 1);
    const empty = await repository.getHostAvailability(3, input);
    assert.equal(empty.days[0].uptimePercent, null);
    await repository.recordHostAvailability(1, true, (now - 40) * 1000);
    await repository.recordHostAvailability(1, true, (now - 10) * 1000);
    const live = await repository.getHostAvailability(1, { since: new Date((now - 40) * 1000), until: new Date((now + 60) * 1000) }, now * 1000);
    assert.equal(live.days[0].onlineSeconds, 40, "live tail must extend to now, not the next sweep");
    const stalled = await repository.getHostAvailability(1, { since: new Date((now - 40) * 1000), until: new Date((now + 200) * 1000) }, (now + 100) * 1000);
    assert.equal(stalled.days[0].onlineSeconds, 30, "stalled monitoring must not project uptime");
  } finally {
    repository.hostAvailabilityRecorder.forget(1);
    await runtime.closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
