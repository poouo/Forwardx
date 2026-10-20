// Read-only post-test SQL A/B experiment and CPU profile summary.
// node scripts/load-test/analyze.mjs dist/load-test/result.json
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";

const resultPath = path.resolve(process.argv[2] || "dist/load-test/result.json");
const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
const database = new Database(path.join(result.directory, "fixture.db"), { readonly: true });
try {
  // This experiment only proves the direction for this direct-rule fixture.
  // A production rewrite must preserve managed parent attribution and orphan history.
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM forward_rules WHERE forwardGroupRuleId IS NOT NULL").get().n, 0);
  const ids = database.prepare("SELECT id FROM forward_rules WHERE userId = 2 ORDER BY id").all().map((row) => row.id);
  assert.equal(ids.length, 20);
  const since = Math.floor(Date.now() / 1000) - 86400;
  const queries = result.stages.flatMap((stage) => stage.server.sql);
  const trend = queries.find((row) => row.sql.includes('AS "bucket"') && row.sql.includes('COALESCE(parent."userId", fr."userId") = ?'));
  const breakdown = queries.find((row) => row.sql.includes('FROM "traffic_stat_buckets" b') && row.sql.includes('COALESCE(parent."userId", fr."userId", b."userId") = ?') && !row.sql.includes(' IN ('));
  // The old comparison is meaningful only for the pre-optimization SQL.
  // Optimized runs still produce profiles/plans without fabricating a comparison.
  const cases = trend && breakdown ? [
    { name: "dashboard.trafficSeries", sql: trend.sql, args: [since, 2], narrowedSql: trend.sql.replace('AND COALESCE(parent."userId", fr."userId") = ?', `AND ts."ruleId" IN (${ids.map(() => "?").join(",")})`), narrowedArgs: [since, ...ids] },
    { name: "dashboard.trafficBreakdown", sql: breakdown.sql, args: [30, Math.floor(since / 1800) * 1800, 2], narrowedSql: breakdown.sql.replace('GROUP BY b.', `AND b."ruleId" IN (${ids.map(() => "?").join(",")}) GROUP BY b.`), narrowedArgs: [30, Math.floor(since / 1800) * 1800, 2, ...ids] },
  ] : [];
  const experiments = cases.map((item) => {
    const original = database.prepare(item.sql), narrowed = database.prepare(item.narrowedSql);
    const normalize = (rows) => rows.map((row) => JSON.stringify(row)).sort();
    assert.deepEqual(normalize(original.all(...item.args)), normalize(narrowed.all(...item.narrowedArgs)));
    const originalTimes = [], narrowedTimes = [];
    const measure = (statement, args, times) => { const start = performance.now(); statement.all(...args); times.push(performance.now() - start); };
    for (let i = 0; i < 20; i++) {
      if (i % 2) { measure(narrowed, item.narrowedArgs, narrowedTimes); measure(original, item.args, originalTimes); }
      else { measure(original, item.args, originalTimes); measure(narrowed, item.narrowedArgs, narrowedTimes); }
    }
    const average = (times) => times.reduce((a, b) => a + b, 0) / times.length;
    return {
      name: item.name, iterations: 20, fixtureResultsEqual: true,
      originalAvgMs: average(originalTimes), narrowedAvgMs: average(narrowedTimes),
      speedup: average(originalTimes) / average(narrowedTimes),
      originalSql: item.sql, narrowedSql: item.narrowedSql,
      originalPlan: database.prepare(`EXPLAIN QUERY PLAN ${item.sql}`).all(...item.args),
      narrowedPlan: database.prepare(`EXPLAIN QUERY PLAN ${item.narrowedSql}`).all(...item.narrowedArgs),
    };
  });
  const profilePath = path.join(result.directory, "server.cpuprofile");
  let cpuHotspots = [];
  if (fs.existsSync(profilePath)) {
    const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
    const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
    const totals = new Map();
    profile.samples.forEach((id, i) => {
      const frame = nodes.get(id).callFrame;
      const key = `${frame.functionName || "(anonymous)"} ${frame.url}:${frame.lineNumber + 1}`;
      totals.set(key, (totals.get(key) || 0) + (profile.timeDeltas[i] || 0));
    });
    const totalUs = [...totals.values()].reduce((a, b) => a + b, 0);
    cpuHotspots = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([location, us]) => ({ location, sampledMs: us / 1000, percent: us * 100 / totalUs }));
  }
  const output = path.join(path.dirname(resultPath), `${path.basename(resultPath, ".json")}-analysis.json`);
  fs.writeFileSync(output, JSON.stringify({ generatedAt: new Date().toISOString(), caveat: experiments.length ? "Read-only experiment on synthetic direct rules, not a production fix or proof for managed/orphan history" : "Optimized SQL detected; baseline-only rewrite experiment skipped. CPU profile and recorded query plans remain available.", experiments, cpuHotspots }, null, 2));
  console.log(JSON.stringify({ experiments: experiments.map(({ name, originalAvgMs, narrowedAvgMs, speedup }) => ({ name, originalAvgMs, narrowedAvgMs, speedup })), cpuHotspots: cpuHotspots.slice(0, 8), output }, null, 2));
} finally { database.close(); }
