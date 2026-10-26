// Summarize JSON output and CPU profiles without connecting to any database.
// node scripts/load-test/agent-analyze.mjs <result.json> [...] --fixtures=<exported tmp>
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const fixtureRoot = args.find(arg => arg.startsWith("--fixtures="))?.slice(11);
const files = args.filter(arg => !arg.startsWith("--"));
if (!files.length) throw Error("Supply one or more benchmark JSON files");
const summaries = [];
for (const file of files) {
  const result = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const scenario of result.scenarios) {
    for (const stage of scenario.stages) {
      const directory = fixtureRoot ? path.join(fixtureRoot, path.basename(scenario.directory)) : scenario.directory;
      const filename = path.join(directory, `${stage.name}.cpuprofile`);
      let hotspots = [];
      if (fs.existsSync(filename)) {
        const profile = JSON.parse(fs.readFileSync(filename, "utf8"));
        const nodes = new Map(profile.nodes.map(node => [node.id, node]));
        const totals = new Map();
        for (let i = 0; i < profile.samples.length; i++) {
          const frame = nodes.get(profile.samples[i]).callFrame;
          if (["(idle)", "(program)"].includes(frame.functionName)) continue;
          const key = `${frame.functionName || "(anonymous)"} ${frame.url}:${frame.lineNumber + 1}`;
          totals.set(key, (totals.get(key) || 0) + (profile.timeDeltas[i] || 0));
        }
        const total = [...totals.values()].reduce((sum, value) => sum + value, 0);
        hotspots = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([frame, us]) => ({ frame, sampledMs: us / 1000, activeSamplePercent: us * 100 / total }));
      }
      const sqlByEndpoint = {};
      for (const sql of stage.server.sql) for (const [endpoint, count] of Object.entries(sql.endpoints)) {
        const row = sqlByEndpoint[endpoint] || { callsAmongTopSql: 0, estimatedMs: 0 };
        row.callsAmongTopSql += count; row.estimatedMs += sql.ms * count / sql.calls; sqlByEndpoint[endpoint] = row;
      }
      const summary = { database: result.database, scenario: scenario.name, stage: stage.name, viewers: stage.viewers, requests: stage.requests, errors: stage.errors,
        missed: stage.missed, rps: stage.rps, p95Ms: stage.p95Ms, p99Ms: stage.p99Ms, cpuOneCorePercent: stage.server.cpuOneCorePercent,
        peakRssMiB: stage.server.peakRssMiB, loopP99Ms: stage.server.loopP99Ms, sqlCalls: stage.server.sqlCalls, sqlMs: stage.server.sqlMs,
        maxPoolWaiting: stage.server.maxPoolWaiting, sqlByEndpoint, hotspots };
      summaries.push(summary);
      console.log(`${result.database}/${scenario.name}/${stage.name}: P95 ${stage.p95Ms.toFixed(0)}ms, P99 ${stage.p99Ms.toFixed(0)}ms, CPU ${stage.server.cpuOneCorePercent.toFixed(0)}%, RSS ${stage.server.peakRssMiB.toFixed(0)}MiB, missed ${stage.missed}, errors ${stage.errors}`);
    }
  }
}
fs.writeFileSync(path.join(path.dirname(path.resolve(files[0])), "agent-analysis.json"), JSON.stringify(summaries, null, 2));
