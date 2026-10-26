import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("batched quota accounting is narrow, atomic and bounded across users", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-quota-batch-"));
  try {
    const script = String.raw`
      import assert from 'node:assert/strict';
      const runtime = await import('./server/dbRuntime.ts');
      const schema = await import('./server/dbSchema.ts');
      const users = await import('./server/repositories/userRepository.ts');
      const billing = await import('./server/repositories/trafficBillingRepository.ts');
      try {
        await runtime.connectDatabase({ type: 'sqlite', sqlite: { path: process.env.FORWARDX_TEST_DB } });
        await schema.ensureDatabaseSchema();
        for (let id=1; id<=130; id++) await runtime.executeRaw('INSERT INTO users (id,username,password,trafficLimit,expiresAt) VALUES (?,?,?,?,?)', [id,'batch-'+id,'unusable',id===1?150:0,id===2?1700000000:null]);
        let queries=0;
        await runtime.withSqliteExclusive(sqlite => {
          const prepare=sqlite.prepare.bind(sqlite);
          sqlite.prepare=(...args)=>{ queries++; return prepare(...args); };
        });
        const rows=await runtime.withDatabaseTransaction(async()=>{
          await billing.lockTrafficBillingUserRows(Array.from({length:129},(_,n)=>129-n));
          return users.addUsersTrafficBatch([...Array.from({length:129},(_,n)=>[n+1,100]),[1,100],[0,50],[130,0],[130,-10],[130,NaN]]);
        });
        assert.equal(rows.length,129); assert.ok(queries<=9, 'query count must not scale per user: '+queries);
        assert.deepEqual(Object.keys(rows[0]).sort(),['expiresAt','id','trafficLimit','trafficUsed']);
        assert.equal(rows.find(row=>row.id===1).trafficUsed,200);
        assert.equal(rows.find(row=>row.id===1).trafficLimit,150);
        assert.equal(rows.find(row=>row.id===2).expiresAt.getTime(),1700000000000);
        assert.equal((await runtime.queryRaw('SELECT trafficUsed FROM users WHERE id=130'))[0].trafficUsed,0);
        await assert.rejects(runtime.withDatabaseTransaction(async()=>{
          await users.addUsersTrafficBatch([[1,500]]); throw Error('rollback');
        }),/rollback/);
        assert.equal((await runtime.queryRaw('SELECT trafficUsed FROM users WHERE id=1'))[0].trafficUsed,200);
        await Promise.all(Array.from({length:8},()=>users.addUsersTrafficBatch([[1,10],[2,20]])));
        assert.equal((await runtime.queryRaw('SELECT trafficUsed FROM users WHERE id=1'))[0].trafficUsed,280);
        assert.equal((await runtime.queryRaw('SELECT trafficUsed FROM users WHERE id=2'))[0].trafficUsed,260);
        await assert.rejects(runtime.withDatabaseTransaction(()=>billing.lockTrafficBillingUserRows([1,999])),/User not found/);
      } finally { await runtime.closeDatabase(); }
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "fixture.db") }, encoding: "utf8", timeout: 60000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
