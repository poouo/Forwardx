import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("batched subscription hydration and scoped permissions preserve live entitlement semantics", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-db-read-"));
  process.env.DATABASE_TYPE = "sqlite";
  process.env.SQLITE_PATH = path.join(directory, "fixture.db");
  process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
  process.env.JWT_SECRET = "isolated-database-read-test-not-a-real-secret";
  const runtime = await import("./dbRuntime");
  const billing = await import("./repositories/billingRepository");
  const permissions = await import("./repositories/permissionRepository");
  const settings = await import("./repositories/settingsRepository");
  try {
    await runtime.connectDatabase();
    await (await import("./dbSchema")).ensureDatabaseSchema();
    const now = Math.floor(Date.now() / 1000);
    await runtime.withSqliteExclusive(sqlite => sqlite.exec(`
      INSERT INTO users (id,username,password,role) VALUES (1,'admin','x','admin'),(2,'a','x','user'),(3,'b','x','user');
      INSERT INTO hosts (id,name,ip,userId) VALUES (1,'plan','192.0.2.1',1),(2,'snapshot','192.0.2.2',1),(3,'other-user','192.0.2.3',3),(4,'manual','192.0.2.4',1);
      INSERT INTO subscription_plans (id,name,priceCents) VALUES (1,'current plan',100);
      INSERT INTO subscription_plan_hosts (planId,hostId) VALUES (1,1);
      INSERT INTO subscription_plan_tunnels (planId,tunnelId) VALUES (1,11);
      INSERT INTO subscription_plan_forward_groups (planId,forwardGroupId) VALUES (1,21);
      INSERT INTO subscription_plan_traffic_addons (id,planId,trafficBytes,priceCents,isActive,sortOrder) VALUES (1,1,100,10,1,2),(2,1,200,20,0,1);
      INSERT INTO user_subscriptions (id,userId,planId,planSnapshot,status,expiresAt) VALUES
        (1,2,1,'{"name":"snapshot","hostIds":[2],"tunnelIds":[12],"forwardGroupIds":[22]}','active',${now+1000}),
        (2,2,1,NULL,'active',NULL),(3,2,1,'malformed','active',${now+1000}),
        (4,2,1,NULL,'active',1),(5,2,1,NULL,'cancelled',${now+1000}),
        (6,3,1,'{"hostIds":[3]}','active',${now+1000});
      INSERT INTO user_traffic_addons (id,userId,subscriptionId,planId,trafficBytes,source,status,expiresAt) VALUES
        (1,2,1,1,1000,'user','active',NULL),(2,2,1,1,2000,'admin','active',${now+1000}),
        (3,2,1,1,4000,'user','active',1),(4,2,1,1,8000,'admin','expired',NULL),
        (5,2,4,1,16000,'user','active',NULL),(6,2,5,1,32000,'user','active',NULL),
        (7,3,6,1,64000,'user','active',NULL);
      INSERT INTO user_host_permissions (userId,hostId) VALUES (2,4);
      INSERT INTO host_groups (id,name,userId) VALUES (1,'populated',1),(2,'empty',1);
      INSERT INTO host_group_members (groupId,hostId) VALUES (1,1),(1,4);
      INSERT INTO forward_rules (id,hostId,userId,name,forwardType,sourcePort,targetIp,targetPort) VALUES (1,1,2,'a rule','iptables',12000,'198.51.100.1',443);
      INSERT INTO traffic_stats (ruleId,hostId,bytesIn,bytesOut,connections,recordedAt) VALUES (1,1,7,11,2,${now});
      INSERT INTO forward_rule_traffic_counters (ruleId,hostId,userId,bytesIn,bytesOut,connections) VALUES (1,1,2,70,110,20);
    `));
    const sqlite = runtime.requireSqlite();
    const originalPrepare = sqlite.prepare;
    let sql: string[] = [];
    sqlite.prepare = function(this: typeof sqlite, ...args: Parameters<typeof originalPrepare>) { sql.push(String(args[0])); return originalPrepare.apply(this, args); } as typeof originalPrepare;
    try {
      const subscriptions = await billing.getActiveUserSubscriptions(2);
      assert.equal(subscriptions.length, 3);
      assert.equal(sql.length, 6, "one base read, one add-on aggregation, three legacy resource reads and one plan add-on read");
      const snapshot = subscriptions.find((row: any) => row.id === 1)!;
      assert.equal(snapshot.planName, "snapshot");
      assert.deepEqual(snapshot.hostIds, [2]);
      assert.deepEqual([snapshot.activeTrafficAddonBytes,snapshot.purchasedTrafficAddonBytes,snapshot.grantedTrafficAddonBytes], [3000,1000,2000]);
      for (const legacy of subscriptions.filter((row:any) => row.id !== 1)) {
        assert.deepEqual(legacy.hostIds,[1]); assert.deepEqual(legacy.tunnelIds,[11]); assert.deepEqual(legacy.forwardGroupIds,[21]);
        assert.equal(legacy.activeTrafficAddonBytes,0);
      }
      assert.deepEqual(subscriptions.map((row:any)=>row.trafficAddons.map((addon:any)=>addon.id)),[[1],[1],[1]]);
      subscriptions[0].trafficAddons[0].priceCents = 999;
      assert.equal(subscriptions[1].trafficAddons[0].priceCents, 10, "subscriptions must not share mutable add-on objects");
      sql = [];
      assert.deepEqual((await permissions.getUserAllowedHosts(2)).map((host:any)=>host.id).sort(),[1,2,4]);
      assert.ok(sql.every(query => !query.includes('user_traffic_addons') && !query.includes('subscription_plan_traffic_addons')), "authorization must not fetch prices or purchased traffic");
      assert.ok(sql.some(query => /from "hosts" where "hosts"\."id" in/i.test(query)), "authorized hosts must be filtered by SQL, not an all-host scan");
      assert.deepEqual((await billing.getActiveUserSubscriptionResourceIds(2,"tunnelIds")).sort(),[11,12]);
      assert.deepEqual((await billing.getActiveUserSubscriptionResourceIds(2,"forwardGroupIds")).sort(),[21,22]);
      await runtime.executeRaw("UPDATE user_subscriptions SET status='cancelled' WHERE id IN (1,2,3)");
      assert.deepEqual(await billing.getActiveUserSubscriptionResourceIds(2,"hostIds"),[]);
      assert.deepEqual((await permissions.getUserAllowedHosts(2)).map((host:any)=>host.id),[4]);

      await settings.getAllSettings();
      sql=[];
      await settings.setSettings(Object.fromEntries(Array.from({length:450},(_,i)=>[`batch.${i}`,i===3?null:String(i)])));
      assert.equal(sql.length,3,"450 settings use three bounded statements, not 450 round trips");
      const all = await settings.getAllSettings();
      assert.equal(all['batch.449'],'449'); assert.equal(all['batch.3'],null);
      sql=[];
      assert.deepEqual(await settings.getSettings(['batch.1','batch.3','missing','batch.1']),{'batch.1':'1','batch.3':null,missing:null});
      assert.equal(sql.length,1);
      await settings.setSetting('batch.1','updated');
      assert.equal((await settings.getSettings(['batch.1']))['batch.1'],'updated',"batch reads must remain live");
      assert.equal((await settings.getAllSettings())['batch.1'],'updated');
      sql=[]; await settings.setSettings({}); await settings.getSettings([]); assert.equal(sql.length,0);
      const groups = await import("./repositories/hostGroupRepository");
      sql=[];
      assert.deepEqual(await groups.getHostGroupCounts(), { 1: 2, 2: 0 });
      assert.equal(sql.length,1); assert.match(sql[0],/COUNT\(/);

      const { appRouter } = await import("./routers");
      const caller = appRouter.createCaller({user:{id:2,role:"user"} as any,req:{headers:{}} as any,res:{} as any,authSession:null,authFailureReason:null});
      sql=[];
      const summary = await caller.rules.listSummary({});
      assert.equal(summary.totalItems,1);
      assert.deepEqual(summary.totalTraffic,{bytesIn:70,bytesOut:110,connections:20});
      assert.deepEqual(summary.dailyTraffic,{bytesIn:7,bytesOut:11,connections:2});
      assert.ok(sql.every(query => !/from ["`]?(tcping_stats|tunnel_latency_stats|forward_group_latency_stats)/i.test(query)), "traffic summary must not query latency history");

      const instrumented = sqlite.prepare;
      sqlite.prepare = function(this: typeof sqlite, ...args: Parameters<typeof originalPrepare>) {
        if (String(args[0]).includes('"geoCountryCode"')) throw new Error("forced old-schema projection failure");
        return instrumented.apply(this,args);
      } as typeof originalPrepare;
      const hostRepository = await import("./repositories/hostRepository");
      sql=[];
      assert.deepEqual((await hostRepository.getHostOptions(2,[4])).map((row:any)=>row.id),[4]);
      assert.ok(sql.some(query=>/SELECT \* FROM "hosts" WHERE/.test(query)), "compatibility path must also filter tenants inside SQL");
    } finally { sqlite.prepare = originalPrepare; }
  } finally { await runtime.closeDatabase(); fs.rmSync(directory,{recursive:true,force:true}); }
});
