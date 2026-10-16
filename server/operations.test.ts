import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseSourceObservations } from "./repositories/operationsRepository";
import { lookupOperationsSourceGeo, parseSourceGeo, sourceGeoPublicAddress } from "./operationsSourceGeo";

test("bundled offline geo verifies both IP families, domestic provinces and overseas locations", async () => {
  const before = globalThis.fetch;
  globalThis.fetch = () => {throw new Error("Offline location must not use the network");};
  try {
    assert.equal((await lookupOperationsSourceGeo("113.118.113.77"))?.region,"广东");
    assert.equal((await lookupOperationsSourceGeo("240e:3b7:3272:d8d0:db09:c067:8d59:539e"))?.region,"广东");
    assert.equal((await lookupOperationsSourceGeo("8.8.8.8"))?.countryCode,"US");
    for (const ip of ["bad","10.0.0.1","127.0.0.1","192.0.2.1","::1","fc00::1","2001:db8::1","ff02::1"]) {
      assert.equal(sourceGeoPublicAddress(ip),false);
      assert.equal(await lookupOperationsSourceGeo(ip),null);
    }
    assert.equal(parseSourceGeo("unknown|0|0|0|0"),null);
    assert.equal(parseSourceGeo("中国|陕西省|西安市|电信|CN")?.region,"陕西");
  } finally {globalThis.fetch=before;}
});

test("local dev seed supplies 30 days of operations fixtures without network calls or production seeding", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-dev-operations-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", String.raw`
      import assert from "node:assert/strict";
      const rt = await import("./server/dbRuntime.ts");
      await rt.connectDatabase({type:"sqlite",sqlite:{path:process.env.FORWARDX_TEST_DB}});
      await (await import("./server/dbSchema.ts")).ensureDatabaseSchema();
      const { seedDevPanelData } = await import("./server/devPanel.ts");
      const ops = await import("./server/repositories/operationsRepository.ts");
      const { operationsDay } = await import("./shared/operations.ts");
      globalThis.fetch = () => { throw new Error("Dev fixtures must not use network geolocation"); };
      try {
        process.env.NODE_ENV = "production";
        process.env.FORWARDX_DEV_PANEL = "1";
        await seedDevPanelData();
        assert.equal((await rt.queryRaw('SELECT COUNT(*) n FROM users'))[0].n, 0);
        process.env.NODE_ENV = "development";
        process.env.FORWARDX_DEV_PANEL = "0";
        await seedDevPanelData();
        assert.equal((await rt.queryRaw('SELECT COUNT(*) n FROM operations_traffic_daily'))[0].n, 0);
        process.env.FORWARDX_DEV_PANEL = "1";
        await seedDevPanelData();
        const now = Math.floor(Date.now()/1000), today = operationsDay(now), start = today - 29*86400;
        const overview = await ops.getOperationsOverview(start, today+86400);
        assert.equal(overview.trend.length, 30);
        assert.ok(overview.users.length >= 3 && overview.hosts.length >= 4 && overview.resources.length >= 5);
        assert.ok(new Set(overview.trend.map(row => row.bytesOut)).size > 20);
        const sources = await ops.getOperationsSources(today, today+86400, 0, "");
        assert.equal(sources.enabled, true);
        assert.equal(sources.totals.ips, 84);
        assert.equal(sources.ips.length, 10);
        assert.equal((await ops.getOperationsSources(today,today+86400,8,"")).ips.length,4);
        const pages = await Promise.all(Array.from({length:9}, (_,page) => ops.getOperationsSources(today,today+86400,page,"")));
        const sorted = pages.flatMap(data => data.ips);
        assert.equal(new Set(sorted.map(row => row.ip)).size,84);
        const known = sorted.filter(row => row.knownSamples > 0);
        assert.ok(known.every((row,i) => !i || row.bytesIn+row.bytesOut <= known[i-1].bytesIn+known[i-1].bytesOut));
        assert.equal(sorted.at(-1).knownSamples,0);
        assert.equal(sources.provinces.length,20);
        assert.ok(new Set(sources.provinces.map(row => row.ips)).size > 2);
        assert.equal(sources.unmappedIps,4);
        assert.equal(sources.foreignCount,2);
        assert.equal(sources.unknownIps,2);
        assert.equal(sources.foreignIps.length,2);
        assert.equal(sources.statuses.length,4);
        assert.ok(sources.statuses.some(row => row.status === "limited"));
        assert.ok(sources.statuses.some(row => row.status === "unavailable"));
        assert.equal((await ops.getOperationsSourceDetails(today,today+86400,"192.0.2.1")).length,2);
        const unknown = (await ops.getOperationsSources(today,today+86400,0,"198.51.100.83")).ips[0];
        assert.equal(unknown.knownSamples,0);
        assert.ok(unknown.unknownSamples > 0);
        assert.ok(overview.events.length > 0 && overview.availability.length > 0);
        // All dashboard data and cached routes must respect the selected rule owner.
        const accounts = await rt.queryRaw('SELECT id,role FROM users ORDER BY id');
        const { operationsRouter } = await import('./server/routers/operations.ts');
        const admin = accounts.find(row => row.role === 'admin');
        const caller = operationsRouter.createCaller({user:admin,req:{headers:{}},res:{}});
        const dates = {from:(await import('./shared/operations.ts')).operationsDate(today),to:(await import('./shared/operations.ts')).operationsDate(today)};
        for (const account of accounts) {
          const scoped = await ops.getOperationsOverview(start,today+86400,account.id);
          assert.ok(scoped.users.every(row => Number(row.id) === account.id));
          const expected = (await rt.queryRaw('SELECT COALESCE(SUM(bytesIn),0) n FROM operations_traffic_daily WHERE userId=?',[account.id]))[0].n;
          assert.equal(scoped.trend.reduce((sum,row) => sum+Number(row.bytesIn),0),expected);
          const scopedSources = await ops.getOperationsSources(today,today+86400,0,'',account.id);
          const expectedSources = (await rt.queryRaw('SELECT COUNT(DISTINCT ip) n FROM operations_source_daily WHERE dayStart=? AND userId=?',[today,account.id]))[0].n;
          assert.equal(scopedSources.totals.ips,expectedSources);
          assert.equal(scopedSources.provinces.reduce((sum,row) => sum+row.ips,0)+scopedSources.unmappedIps,expectedSources);
          assert.equal(scoped.resources.reduce((sum,row) => sum+Number(row.bytesIn),0),expected);
          assert.equal((await caller.sources({...dates,userId:account.id})).totals.ips,expectedSources);
          for (const ip of scopedSources.ips.slice(0,2)) {
            const details = await caller.sourceDetails({...dates,userId:account.id,ip:ip.ip});
            const expectedBytes = (await rt.queryRaw('SELECT SUM(bytesIn) n FROM operations_source_daily WHERE dayStart=? AND userId=? AND ip=?',[today,account.id,ip.ip]))[0].n;
            assert.equal(details.reduce((sum,row) => sum+Number(row.bytesIn),0),expectedBytes);
          }
        }
        assert.equal((await caller.overview(dates)).users[0].id,admin.id);
        assert.equal((await caller.overview({...dates,userId:'all'})).users.length,overview.users.length);
        assert.equal((await caller.sources({...dates,userId:'all'})).totals.ips,84);
        assert.equal((await caller.sources(dates)).totals.ips,(await ops.getOperationsSources(today,today+86400,0,'',admin.id)).totals.ips);
        const otherAdmin = accounts.find(row => row.id !== admin.id);
        const otherCaller = operationsRouter.createCaller({user:{...otherAdmin,role:'admin'},req:{headers:{}},res:{}});
        assert.ok((await otherCaller.overview(dates)).users.every(row => row.id === otherAdmin.id));
        assert.equal((await otherCaller.sources(dates)).totals.ips,(await ops.getOperationsSources(today,today+86400,0,'',otherAdmin.id)).totals.ips);
        assert.equal((await caller.overview({...dates,userId:999999})).trend.length,0);
        assert.equal((await caller.overview({...dates,userId:999999})).current.length,0);
        assert.equal((await caller.overview({...dates,userId:999999})).events.length,0);
        assert.equal((await caller.sources({...dates,userId:999999})).statuses.length,0);
        await assert.rejects(caller.sources({...dates,sort:'unsafe'}), error => error.code === 'BAD_REQUEST');
        const ruleOrder = await ops.getOperationsSources(today,today+86400,0,'',undefined,'rules');
        assert.ok(ruleOrder.ips.every((row,i) => !i || row.rules <= ruleOrder.ips[i-1].rules));
        await rt.executeRaw('UPDATE operations_source_daily SET lastSeen=? WHERE ip=?',[now+1,'198.51.100.83']);
        assert.equal((await ops.getOperationsSources(today,today+86400,0,'',undefined,'recent')).ips[0].ip,'198.51.100.83');
        const counts = (await rt.queryRaw('SELECT COUNT(*) n FROM operations_source_daily'))[0].n;
        await seedDevPanelData();
        assert.equal((await rt.queryRaw('SELECT COUNT(*) n FROM operations_source_daily'))[0].n, counts);
      } finally { await rt.closeDatabase(); }
    `], {cwd:process.cwd(),env:{...process.env,DATABASE_TYPE:"sqlite",FORWARDX_TEST_DB:path.join(directory,"dev.db"),FORWARDX_LOG_DIR:path.join(directory,"logs")},encoding:"utf8",timeout:60000,windowsHide:true});
    assert.equal(result.status,0,result.stdout+result.stderr);
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});

test("source ingestion validates addresses, numbers, flags, bounded payload and mapped IPv4", () => {
  const row = { ruleId: 1, ip: "::ffff:8.8.8.8", bytesIn: 10, bytesOut: 20, accounting: true };
  assert.deepEqual(parseSourceObservations([row, row, { ...row, ip: "bad" }, { ...row, bytesIn: -1 }, { ...row, bytesOut: Infinity }, { ...row, accounting: "true" }]), [{ ...row, ip: "8.8.8.8", bytesIn: 20, bytesOut: 40 }]);
  assert.equal(parseSourceObservations(Array.from({ length: 1200 }, (_, i) => ({ ...row, ruleId: i + 1 }))).length, 1000);
});

test("operations history transactions, source ingress isolation, geo aggregation and retention", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-operations-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", String.raw`
      import assert from "node:assert/strict";
      const rt = await import("./server/dbRuntime.ts");
      await rt.connectDatabase({type:"sqlite",sqlite:{path:process.env.FORWARDX_TEST_DB}});
      await (await import("./server/dbSchema.ts")).ensureDatabaseSchema();
      const ops = await import("./server/repositories/operationsRepository.ts");
      const metrics = await import("./server/repositories/metricsRepository.ts");
      const settings = await import("./server/repositories/settingsRepository.ts");
      const { operationsDay } = await import("./shared/operations.ts");
      try {
        await rt.executeRaw("INSERT INTO users (id,username,password,name,role) VALUES (1,'admin','hash','Admin','admin')");
        await rt.executeRaw("INSERT INTO hosts (id,name,ip,userId) VALUES (1,'Entry','192.0.2.1',1),(2,'Exit','192.0.2.2',1)");
        const rule = {id:10,name:'Example',hostId:1,userId:1,isEnabled:true,forwardGroupRuleId:9,forwardGroupId:3};
        const tunnelRule = {id:11,name:'Tunnel',hostId:1,userId:1,isEnabled:true,tunnelId:2};
        const contexts = new Map([[10,{rule,group:{name:'Resource'}}],[11,{rule:tunnelRule,tunnel:{name:'Tunnel'}}]]);
        const host={id:1,name:'Entry'}, now=Math.floor(Date.now()/1000), start=operationsDay(now);
        const items = [{stat:{ruleId:10,bytesIn:10,bytesOut:20,connections:1},userId:1}];
        await rt.withDatabaseTransaction(async()=> {
          assert.equal(await metrics.claimAgentTrafficReport(1,'r1','p1'),true);
          await ops.recordOperationsTraffic([...items,...items],contexts,host);
        });
        assert.equal(await metrics.claimAgentTrafficReport(1,'r1','p1'),false);
        let data = await ops.getOperationsOverview(start,start+86400);
        assert.equal(data.trend[0].bytesIn,20);
        assert.equal(data.rules[0].id,9);
        assert.equal(data.resources[0].id,'group:3');
        assert.equal(data.users[0].name,'admin');
        await assert.rejects(rt.withDatabaseTransaction(async()=> {await ops.recordOperationsTraffic(items,contexts,host);throw new Error('rollback');}));
        assert.equal((await ops.getOperationsOverview(start,start+86400)).trend[0].bytesIn,20);
        globalThis.fetch=()=> {throw new Error('Source location must not call an API');};
        const sample={ruleId:10,ip:'113.118.113.77',bytesIn:7,bytesOut:9,accounting:true};
        await ops.recordOperationsSources(host,[sample],contexts,new Map(),'sampled',now);
        assert.equal((await ops.getOperationsSources(start,start+86400,0,'')).ips.length,0);
        await settings.setSetting('operationsSourceAnalytics','true');
        await ops.recordOperationsSources(host,[sample,{...sample,ruleId:11},{...sample,ruleId:999}],contexts,new Map([[2,new Set([1])]]),'sampled',now);
        // Exit host is never a source ingress, even for a known rule.
        await ops.recordOperationsSources({id:2},[sample,{...sample,ruleId:11}],contexts,new Map([[2,new Set([1])]]),'sampled',now);
        let sources=await ops.getOperationsSources(start,start+86400,0,'');
        assert.equal(sources.totals.ips,1);
        assert.equal(sources.totals.bytesIn,14);
        assert.equal(sources.ips[0].rules,2);
        assert.equal(sources.unmappedIps,0);
        // Offline source cache must not populate or change routine API cache.
        assert.equal((await rt.queryRaw('SELECT COUNT(*) n FROM ip_geo_cache'))[0].n,0);
        assert.equal((await rt.queryRaw('SELECT COUNT(*) n FROM operations_ip_geo'))[0].n,1);
        sources=await ops.getOperationsSources(start,start+86400,0,'');
        assert.equal(sources.provinces[0].name,'广东');
        assert.equal(sources.provinces[0].ips,1);
        assert.equal(sources.provinces[0].bytesIn,14);
        assert.equal((await ops.getOperationsSources(start,start+86400,0,'9.9')).ips.length,0);
        assert.equal((await ops.getOperationsSourceDetails(start,start+86400,'113.118.113.77')).length,2);
        const province=await ops.getOperationsProvinceDetails(start,start+86400,'广东',1);
        assert.equal(province.totals.ips,1);
        assert.equal(province.totals.bytesIn,14);
        assert.equal(province.ips[0].ip,'113.118.113.77');
        assert.equal(province.ips[0].city,'深圳市');
        assert.equal((await ops.getOperationsProvinceDetails(start,start+86400,'广东',2)).ips.length,0);
        assert.equal((await ops.getOperationsProvinceDetails(start,start+86400,'广东',1,'9.9')).ips.length,0);
        // Shared NAT IPs remain scoped; overseas and unknown sources are separate.
        for (const [ip,userId] of [['8.8.8.8',2],['113.118.113.77',2],['10.0.0.1',2],['240e:3b7:3272:d8d0:db09:c067:8d59:539e',2]]) {
          await rt.executeRaw('INSERT INTO operations_source_daily (dayStart,ruleId,hostId,ip,userId,logicalRuleId,bytesIn,bytesOut,knownSamples,unknownSamples,lastSeen) VALUES (?,12,1,?,?,12,100,200,1,0,?)',[start,ip,userId,now]);
        }
        const secondUser = await ops.getOperationsSources(start,start+86400,0,'',2);
        assert.equal(secondUser.foreignCount,1);
        assert.equal(secondUser.foreignIps[0].ip,'8.8.8.8');
        assert.equal(secondUser.unknownIps,1);
        assert.equal(secondUser.provinces[0].ips,2);
        assert.equal((await ops.getOperationsSourceDetails(start,start+86400,'113.118.113.77',1)).length,2);
        assert.equal((await ops.getOperationsSourceDetails(start,start+86400,'113.118.113.77',2)).length,1);
        assert.equal((await ops.getOperationsProvinceDetails(start,start+86400,'广东',2)).totals.bytesIn,200);
        assert.equal((await rt.queryRaw('SELECT COUNT(*) n FROM ip_geo_cache'))[0].n,0);
        // Delayed report keeps the sample's original calendar day.
        await ops.recordOperationsSources(host,[sample],contexts,new Map(),'sampled',start-60);
        assert.equal((await ops.getOperationsSources(start-86400,start,0,'')).totals.ips,1);
        await settings.setSetting('operationsSourceAnalytics','false');
        await ops.recordOperationsSources(host,[sample],contexts,new Map(),'sampled',now);
        assert.equal((await ops.getOperationsSources(start,start+86400,0,'',1)).totals.bytesIn,14);
        await rt.executeRaw('UPDATE operations_source_daily SET dayStart=dayStart-?',[30*86400]);
        await ops.cleanOperationsHistory();
        assert.equal((await ops.getOperationsSources(start-40*86400,start+86400,0,'')).ips.length,0);
        const { operationsRouter }=await import('./server/routers/operations.ts');
        await assert.rejects(operationsRouter.createCaller({user:{id:2,role:'user'},req:{headers:{}},res:{}}).overview({from:'2026-10-16',to:'2026-10-16'}), error=>error.code==='FORBIDDEN');
        const restricted = operationsRouter.createCaller({user:{id:2,role:'user'},req:{headers:{}},res:{}});
        const dates = {from:'2026-10-16',to:'2026-10-16',userId:'all'};
        await assert.rejects(restricted.sources(dates), error=>error.code==='FORBIDDEN');
        await assert.rejects(restricted.sourceDetails({...dates,ip:'8.8.8.8'}), error=>error.code==='FORBIDDEN');
        await assert.rejects(restricted.resolveSources({...dates,consent:true}), error=>error.code==='FORBIDDEN');
      } finally { await rt.closeDatabase(); }
    `], { cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "operations.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") }, encoding: "utf8", timeout: 60000, windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
