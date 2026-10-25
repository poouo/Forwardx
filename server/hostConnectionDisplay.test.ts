import assert from "node:assert/strict";
import fs from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { getAgentConnectionStats, recordAgentConnectionStats } from "./agentConnectionStats";

test("host list and live status project the latest connection snapshot without database writes", () => {
  const text = fs.readFileSync("server/routers/hosts.ts", "utf8");
  const source = ts.createSourceFile("hosts.ts", text, ts.ScriptTarget.Latest, true);
  const now = Date.now();
  const report = {
    version: 1, scope: "network-namespace", source: "proc-sockstat", sampledAt: Math.floor(now / 1000),
    tcp: { status: "ok", total: 14, inUse: 7, timeWait: 7, ipv6Included: true },
    udp: { status: "ok", total: 0, inUse: 0, ipv6Included: false },
  };
  for (const name of ["compactHostForList", "compactHostStatus"]) {
    assert.equal(recordAgentConnectionStats(1001, report, now), true);
    const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration);
    const code = ts.transpileModule(`(${declaration.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const project = runInNewContext(code, { getAgentConnectionStats });
    const host = project({ id: 1001, name: "host", isOnline: true, agentToken: "secret" });
    assert.equal(host.connectionStats.stats.tcp.total, 14);
    assert.equal(host.connectionStats.stats.udp.total, 0);
    assert.equal(host.agentToken, undefined);
    assert.equal(project({ id: 1002 }).connectionStats, null);
    assert.equal(recordAgentConnectionStats(1001, { ...report, tcp: { ...report.tcp, total: 15, inUse: 8 } }, now), true);
    assert.equal(project({ id: 1001 }).connectionStats.stats.tcp.total, 15, "fresh snapshots are read outside database query caches");
  }
  // These projectors only run after normal list/page/status host ACL filtering.
  assert.match(text, /getVisibleHostsForUser\(ctx.user\)[\s\S]*?hosts.map\(compactHostForList\)/);
  assert.match(text, /db.getHostStatusRows\(query\)[\s\S]*?\.map\(compactHostStatus\)/);
});
