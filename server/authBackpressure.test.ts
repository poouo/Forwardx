import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseHealthTracker, isDatabaseBusyError } from "./databaseHealthState";
import { createRequestWorkPool } from "./requestWorkPool";

test("driver pool saturation is transient, including nested errors", () => {
  for (const error of [new Error("Queue limit reached."), new Error("wrapper", { cause: new Error("Queue limit reached.") }),
    new AggregateError([{ code: "POOL_ENQUEUELIMIT" }]), { code: "53300" }, { code: "SQLITE_BUSY" }]) {
    assert.equal(isDatabaseBusyError(error), true);
    const health = new DatabaseHealthTracker(() => {});
    health.healthy();
    assert.equal(health.unavailable(error), false);
    assert.equal(health.unavailable(error, false, true), false);
    assert.equal(health.snapshot().state, "healthy");
  }
  assert.equal(isDatabaseBusyError({ code: "ECONNREFUSED" }), false);
  assert.equal(isDatabaseBusyError(new Error("business SQL failed")), false);
});

test("bounded work rejects excess waiters without releasing slow SQL slots", async () => {
  const pool = createRequestWorkPool({ concurrency: 2, maxQueued: 2, queueTimeoutMs: 20 });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const running = [pool.run(() => blocked), pool.run(() => blocked)];
  const waiting = [pool.run(async () => 1), pool.run(async () => 2)];
  const rejections = waiting.map((task) => assert.rejects(task, { code: "SERVICE_UNAVAILABLE" }));
  await assert.rejects(pool.run(async () => 3), { code: "SERVICE_UNAVAILABLE" });
  await Promise.all(rejections);
  assert.deepEqual(pool.stats(), { active: 2, queued: 0 });
  release(); await Promise.all(running);
  assert.equal(await pool.run(async () => 4), 4);
});

test("real auth survives pool errors and bursts; revocation and account checks remain live", { timeout: 30_000 }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-auth-backpressure-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import jwt from "jsonwebtoken";
    const runtime = await import("./server/dbRuntime.ts");
    const { createContext, updateMultiDeviceLoginSettingCache } = await import("./server/_core/context.ts");
    const sessions = await import("./server/repositories/sessionRepository.ts");
    const { encodeSessionLease } = await import("./server/session.ts");
    const { databaseHealth } = await import("./server/databaseHealthState.ts");
    const { protectedProcedure, publicProcedure, router } = await import("./server/_core/trpc.ts");
    const { SERVICE_BUSY_MESSAGE } = await import("./shared/databaseHealth.ts");
    const { COOKIE_NAME } = await import("./shared/const.ts");
    let sqlite, prepare, injected, reads = 0, injectedSql = /from "users"/i;
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH } });
      await (await import("./server/dbSchema.ts")).ensureDatabaseSchema();
      await runtime.executeRaw('INSERT INTO users (id,username,password,role,browserSessionToken) VALUES (1,?,?,?,?),(2,?,?,?,?)',
        ["alice","x","user",encodeSessionLease("a"),"bob","x","admin",encodeSessionLease("b")]);
      for (const [userId,sid] of [[1,"a"],[2,"b"]]) await sessions.createAuthSession({ userId,sid,kind:"browser",expiresAt:new Date(Date.now()+60000) });
      updateMultiDeviceLoginSettingCache(false);
      databaseHealth.healthy();
      const token = jwt.sign({ userId:1,sid:"a",kind:"browser" },process.env.JWT_SECRET,{expiresIn:"1h"});
      const request = async (value=token,bearer=false) => {
        let cleared = false;
        const req = { headers: bearer ? {authorization:"Bearer "+value} : {}, cookies: bearer ? {} : {[COOKIE_NAME]:value} };
        const res = { clearCookie() { cleared=true; } };
        try { return { ctx:await createContext({req,res,info:{}}),cleared }; }
        catch(error) { return {error,cleared}; }
      };
      await runtime.withSqliteExclusive((db) => {
        sqlite=db; prepare=db.prepare;
        db.prepare=function(sql) {
          if (/select/i.test(sql) && /from "users"/i.test(sql)) reads++;
          if (injected && injectedSql.test(sql)) throw injected;
          return prepare.call(this,sql);
        };
      });
      assert.equal((await request()).ctx.user.id,1);
      assert.equal(reads,1,"a verified request uses one joined read, not two reads");
      for (const injectedError of [new Error("Queue limit reached."),new Error("wrapped",{cause:new Error("Queue limit reached.")}),new Error("unexpected query failure")]) {
        injected=injectedError;
        for (const bearer of [false,true]) {
          const result=await request(token,bearer);
          assert.equal(result.cleared,false);
          assert.ok(["SERVICE_UNAVAILABLE","INTERNAL_SERVER_ERROR"].includes(result.error.code));
          assert.equal(result.ctx,undefined,"never authorize from stale data on failure");
          assert.equal(databaseHealth.snapshot().state,"healthy");
        }
      }
      injected=undefined;
      assert.equal((await request()).ctx.user.id,1,"same cookie works after recovery");
      for (const payload of [{userId:1,sid:"b",kind:"browser"},{userId:1,sid:"a",kind:"mobile"}]) {
        const invalidSessionToken=jwt.sign(payload,process.env.JWT_SECRET,{expiresIn:"1h"});
        const result=await request(invalidSessionToken);
        assert.equal(result.ctx.user,null,"joined identity cannot cross users or session kinds");
        assert.equal(result.ctx.authFailureReason,"session_replaced");
      }
      await runtime.executeRaw('UPDATE auth_sessions SET expiresAt=1 WHERE sid=?',["a"]);
      assert.equal((await request()).ctx.authFailureReason,"session_replaced");
      await runtime.executeRaw('UPDATE auth_sessions SET expiresAt=? WHERE sid=?',[Math.floor(Date.now()/1000)+60,"a"]);
      // Occupy the SQLite connection to model slow SQL, then flood real contexts.
      let release,entered;
      const ready=new Promise(resolve=>{entered=resolve;});
      const blocked=runtime.withSqliteExclusive(async()=>{entered();await new Promise(resolve=>{release=resolve;});});
      await ready;
      const burst=Promise.all(Array.from({length:320},()=>request()));
      await new Promise(resolve=>setTimeout(resolve,2200));
      release();await blocked;
      const results=await burst;
      const accepted=results.filter(result=>result.ctx?.user?.id===1);
      const rejected=results.filter(result=>result.error?.code==="SERVICE_UNAVAILABLE");
      assert.equal(accepted.length,8,"only eight auth reads may reach a slow driver");
      assert.equal(rejected.length,312);
      assert.ok(results.every(result=>!result.cleared));
      console.log(JSON.stringify({burst:320,accepted:accepted.length,busy:rejected.length,cookiesCleared:0}));
      assert.equal((await request()).ctx.user.id,1);
      const api=router({read:protectedProcedure.query(()=>"private"),busy:publicProcedure.query(()=>{throw new Error("Queue limit reached.");})});
      const ctx=(await request()).ctx;
      await assert.rejects(api.createCaller(ctx).busy(),error=>error.code==="SERVICE_UNAVAILABLE"&&error.message===SERVICE_BUSY_MESSAGE);
      // Exercise the actual Agent route from the reported stack, not only tRPC.
      const {default:express}=await import("express");
      const {registerAgentHeartbeatRoute}=await import("./server/agentHeartbeatRoute.ts");
      const {databaseRequestErrorHandler}=await import("./server/databaseHealthRoutes.ts");
      await runtime.executeRaw('INSERT INTO hosts (id,name,ip,userId,agentToken,isOnline,lastHeartbeat) VALUES (1,?,?,1,?,1,?)',["test","192.0.2.1","isolated-agent-token",Math.floor(Date.now()/1000)]);
      const app=express(); app.use(express.json());
      // The production encrypted transport resolves this field before routing.
      app.use((req,_res,next)=>{req.agentToken=req.headers.authorization?.substring(7);next();});
      registerAgentHeartbeatRoute(app);app.use(databaseRequestErrorHandler);
      app.get("/api/busy",()=>{throw new Error("Queue limit reached.");});app.use(databaseRequestErrorHandler);
      const server=app.listen(0,"127.0.0.1");
      await new Promise(resolve=>server.once("listening",resolve));
      const base="http://127.0.0.1:"+server.address().port;
      try {
        injectedSql=/from ["\x60]?hosts["\x60]?\b/i;injected=new Error("Queue limit reached.");
        for (const endpoint of ["presence","heartbeat"]) {
          const response=await fetch(base+"/api/agent/"+endpoint,{method:"POST",headers:{authorization:"Bearer isolated-agent-token","content-type":"application/json"},body:"{}"});
          assert.equal(response.status,503,await response.text());
          assert.equal(response.headers.get("retry-after"),"5");
        }
        injected=undefined;
        const recovered=await fetch(base+"/api/agent/presence",{method:"POST",headers:{authorization:"Bearer isolated-agent-token"}});
        assert.equal(recovered.status,200,await recovered.text());
        const busyResponse=await fetch(base+"/api/busy");
        assert.equal(busyResponse.status,503);assert.equal(busyResponse.headers.get("retry-after"),"5");
        assert.equal(databaseHealth.snapshot().state,"healthy");
      } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));injected=undefined;injectedSql=/from "users"/i;}
      await sessions.revokeAuthSession(1,"a","browser");
      let result=await request();
      assert.equal(result.ctx.user,null);assert.equal(result.ctx.authFailureReason,"session_replaced");assert.equal(result.cleared,true);
      await assert.rejects(api.createCaller(result.ctx).read(),{code:"UNAUTHORIZED"});
      await runtime.executeRaw('UPDATE users SET accountEnabled=0 WHERE id=2');
      const other=jwt.sign({userId:2,sid:"b",kind:"browser"},process.env.JWT_SECRET,{expiresIn:"1h"});
      result=await request(other);
      assert.equal(result.ctx.authFailureReason,"account_disabled");assert.equal(result.cleared,true);
      result=await request("not-a-valid-jwt");
      assert.equal(result.ctx.user,null);assert.equal(result.cleared,true);
    } finally {
      if(sqlite&&prepare) sqlite.prepare=prepare;
      await runtime.closeDatabase();
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      encoding: "utf8", timeout: 25_000, windowsHide: true,
      env: { ...process.env, DATABASE_TYPE: "sqlite", SQLITE_PATH: path.join(directory, "fixture.db"),
        DATABASE_CONFIG_PATH: path.join(directory, "config.json"), JWT_SECRET: "auth-backpressure-isolated-test-secret", FORWARDX_DEV_PANEL: "0" },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    console.log(result.stdout.trim());
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
