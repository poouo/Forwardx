import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("rule ranking resolves legacy IDs, preserves deleted names and numeric names, and stores new names", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-ranking-names-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", String.raw`
      import assert from "node:assert/strict";
      const rt = await import("./server/dbRuntime.ts");
      await rt.connectDatabase({type:"sqlite",sqlite:{path:process.env.FORWARDX_TEST_DB}});
      await (await import("./server/dbSchema.ts")).ensureDatabaseSchema();
      const ops = await import("./server/repositories/operationsRepository.ts");
      const {getForwardRuleTrafficContextsByIds} = await import("./server/repositories/forwardRuleRepository.ts");
      const {operationsDay} = await import("./shared/operations.ts");
      try {
        const day = operationsDay(Date.now()/1000);
        await rt.executeRaw("INSERT INTO users (id,username,password,role) VALUES (1,'admin','hash','admin'),(2,'other','hash','user')");
        await rt.executeRaw("INSERT INTO hosts (id,name,ip,userId) VALUES (1,'Entry','192.0.2.1',1)");
        await rt.executeRaw("INSERT INTO forward_rules (id,hostId,name,sourcePort,targetIp,targetPort,userId) VALUES (62,1,'香港入口',10062,'192.0.2.2',80,1),(39,1,'39',10039,'192.0.2.2',80,1),(66,1,'other private name',10066,'192.0.2.2',80,2)");
        for (const [ruleId,logicalId,name] of [[62,62,'62'],[39,39,'39'],[63,63,'63'],[64,64,'Deleted service'],[65,65,''],[67,66,'67'],[68,69,'68']]) {
          await rt.executeRaw('INSERT INTO operations_traffic_daily (dayStart,ruleId,hostId,userId,logicalRuleId,resourceKey,ruleName,hostName,resourceName,bytesIn,bytesOut,connections) VALUES (?,?,1,1,?,?,?,\'Entry\',\'Entry\',10,20,1)',[day,ruleId,logicalId,'host:1',name]);
        }
        const data = await ops.getOperationsOverview(day,day+86400,1);
        const byId = new Map(data.rules.map(row => [Number(row.id),row]));
        assert.equal(byId.get(62).name,'香港入口');
        assert.equal(byId.get(39).name,'39'); // A real numeric name is not an ID placeholder.
        assert.equal(byId.get(63).name,'');
        assert.equal(byId.get(64).name,'Deleted service');
        assert.equal(byId.get(65).name,'');
        assert.equal(byId.get(66).name,''); // Do not resolve another owner's current name.
        assert.equal(byId.get(69).name,''); // Physical and logical IDs may differ.
        assert.equal(data.rules.reduce((sum,row) => sum+row.bytesIn,0),70);
        const contexts = await getForwardRuleTrafficContextsByIds([62]);
        assert.equal(contexts[0].rule.name,'香港入口');
        await ops.recordOperationsTraffic([{stat:{ruleId:62,bytesIn:1,bytesOut:2,connections:1},userId:1}],new Map([[62,contexts[0]]]),{id:1,name:'Entry'});
        const stored = await rt.queryRaw('SELECT ruleName,bytesIn FROM operations_traffic_daily WHERE ruleId=62');
        assert.equal(stored[0].ruleName,'香港入口');
        assert.equal(stored[0].bytesIn,11);
        await ops.recordOperationsTraffic([{stat:{ruleId:70,bytesIn:1,bytesOut:2,connections:1},userId:1}],new Map(),{id:1,name:'Entry'});
        assert.equal((await rt.queryRaw('SELECT ruleName FROM operations_traffic_daily WHERE ruleId=70'))[0].ruleName,'');
        const grouped = {rule:{id:71,name:'Generated child',forwardGroupRuleId:72,forwardGroupId:3},logicalRuleName:'Visible template'};
        await ops.recordOperationsTraffic([{stat:{ruleId:71,bytesIn:1,bytesOut:2,connections:1},userId:1}],new Map([[71,grouped]]),{id:1,name:'Entry'});
        assert.equal((await ops.getOperationsOverview(day,day+86400,1)).rules.find(row => row.id===72).name,'Visible template');
        await rt.executeRaw("UPDATE forward_rules SET name='Renamed service' WHERE id=62");
        assert.equal((await ops.getOperationsOverview(day,day+86400,1)).rules.find(row => row.id===62).name,'Renamed service');
        assert.equal((await rt.queryRaw('SELECT ruleName FROM operations_traffic_daily WHERE ruleId=62'))[0].ruleName,'香港入口');
      } finally { await rt.closeDatabase(); }
    `], {cwd:process.cwd(),env:{...process.env,DATABASE_TYPE:"sqlite",FORWARDX_TEST_DB:path.join(directory,"names.db"),FORWARDX_LOG_DIR:path.join(directory,"logs")},encoding:"utf8",timeout:60000,windowsHide:true});
    assert.equal(result.status,0,result.stdout+result.stderr);
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});
