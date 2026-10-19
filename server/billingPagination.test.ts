import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("billing SQL pages retain all sources, stable ordering, diagnostics and user isolation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-billing-pages-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = file => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    try {
      await runtime.connectDatabase({type:"sqlite",sqlite:{path:process.env.FORWARDX_TEST_DB}});
      await schema.ensureDatabaseSchema();
      const billing = await import(url("server/repositories/billingRepository.ts"));
      const { billingRouter } = await import(url("server/routers/billing.ts"));
      const insert = (table, row) => runtime.executeRaw(
        'INSERT INTO "' + table + '" (' + Object.keys(row).map(key => '"' + key + '"').join(',') +
        ') VALUES (' + Object.keys(row).map(() => '?').join(',') + ')', Object.values(row));
      for (const id of [1,2,3]) await insert("users", {id, username:"billing-user-"+id, password:"x", role:id===1?"admin":"user"});
      await insert("subscription_plans", {id:1,name:"Page test",priceCents:100});
      const expected = [];
      const now = Math.floor(Date.now()/1000);
      // More rows than both previous hard caps (100 balance, 200/500 ledger).
      for (let id=1; id<=620; id++) {
        const row = {id,userId:id%2+2,type:"admin_recharge",amountCents:100,balanceAfterCents:100,createdAt:now-Math.floor(id/4)};
        await insert("balance_transactions", row);
        expected.push({...row,kind:"balance"});
      }
      for (let id=1; id<=120; id++) {
        const row = {id,userId:id%2+2,outTradeNo:"PAGE-"+id,provider:"alipay",paymentType:"alipay",
          status:"failed",subject:"Order "+id,amountCents:100,tradeNo:"GATEWAY-"+id,
          failureReason:"mock safe payment error",paidAt:now,createdAt:now-Math.floor(id/4)};
        await insert("payment_orders", row);
        expected.push({...row,kind:"payment"});
      }
      for (let id=1; id<=120; id++) {
        const row = {id,userId:id%2+2,planId:1,status:id%3===0?"cancelled":"expired",source:"admin",
          createdAt:now-Math.floor(id/4),userDismissedAt:id===2?now:null,adminDismissedAt:id===4?now:null};
        await insert("user_subscriptions", row);
        expected.push({...row,kind:"subscription"});
      }
      const sorted = rows => rows.slice().sort((a,b) => b.createdAt-a.createdAt ||
        (a.kind<b.kind?-1:a.kind>b.kind?1:0) || b.id-a.id);
      const keys = rows => rows.map(row => row.kind+"-"+(row.sourceId??row.id));
      const visible = (admin, userId, cancelled=true) => sorted(expected.filter(row =>
        (userId===undefined || row.userId===userId) && (row.kind!=="subscription" ||
        (!row.adminDismissedAt && (admin || !row.userDismissedAt) && (cancelled || row.status!=="cancelled")))));
      const adminExpected = visible(true);
      const seen = [];
      for (let page=1; page<=Math.ceil(adminExpected.length/20); page++) {
        const result = await billing.listBillingLedgerPage({isAdmin:true,viewerUserId:1,page,pageSize:20});
        assert.equal(result.totalItems,adminExpected.length);
        assert.equal(result.page,page);
        assert.deepEqual(keys(result.items),keys(adminExpected.slice((page-1)*20,page*20)));
        seen.push(...keys(result.items));
      }
      assert.equal(new Set(seen).size,adminExpected.length,"no duplicated/missing entries with tied timestamps");
      const last = await billing.listBillingLedgerPage({isAdmin:true,page:9999,pageSize:20});
      assert.equal(last.page,Math.ceil(adminExpected.length/20));
      assert.deepEqual(keys(last.items),keys(adminExpected.slice((last.page-1)*20)));
      const filtered = await billing.listBillingLedgerPage({isAdmin:true,userId:2,pageSize:100});
      assert.equal(filtered.totalItems,visible(true,2).length);
      assert.deepEqual(keys(filtered.items),keys(visible(true,2).slice(0,100)));
      const payment = filtered.items.find(row=>row.kind==="payment");
      assert.equal(payment.failureReason,"mock safe payment error");
      assert.equal(payment.provider,"alipay");
      assert.equal(payment.tradeNo,"GATEWAY-"+payment.sourceId);
      assert.ok(payment.paidAt instanceof Date);

      const context = (id,role) => ({user:{id,role,username:"billing-user-"+id},req:{headers:{},socket:{}},res:{}});
      const user = billingRouter.createCaller(context(2,"user"));
      const userResult = await user.ledgerPage({userId:3,page:2,pageSize:20});
      assert.equal(userResult.totalItems,visible(false,2).length,"ignore another user ID from an ordinary caller");
      assert.deepEqual(keys(userResult.items),keys(visible(false,2).slice(20,40)));
      assert.ok(userResult.items.every(row=>row.userId===2));
      const noCancelled = await user.ledgerPage({pageSize:100,includeCancelledSubscriptions:false});
      assert.equal(noCancelled.totalItems,visible(false,2,false).length);
      assert.deepEqual(keys(noCancelled.items),keys(visible(false,2,false).slice(0,100)));
      await assert.rejects(user.listTransactionsPage({page:1}),error=>error.code==="FORBIDDEN");
      const anonymous = billingRouter.createCaller({req:{headers:{},socket:{}},res:{},user:null});
      await assert.rejects(anonymous.ledgerPage({page:1}),error=>error.code==="UNAUTHORIZED");
      const admin = billingRouter.createCaller(context(1,"admin"));
      const balances = await admin.listTransactionsPage({page:16,pageSize:20,userId:2});
      assert.equal(balances.totalItems,310);
      assert.equal(balances.items.length,10);
      const balanceExpected = visible(true,2).filter(row=>row.kind==="balance");
      assert.deepEqual(balances.items.map(row=>row.id),balanceExpected.slice(300).map(row=>row.id));
      const empty = await admin.ledgerPage({userId:1,page:99});
      assert.equal(empty.totalItems,0);
      assert.equal(empty.page,1);
      assert.deepEqual(empty.items,[]);
      assert.deepEqual(await billing.listBillingLedgerPage({userId:2,page:1}),
        {items:[],page:1,pageSize:20,totalItems:0,totalPages:1},"missing viewer never expands scope");
      assert.deepEqual(await billing.listBillingLedger({isAdmin:true},{balance:[],payment:[],subscription:[]}),[]);
      assert.deepEqual(await billing.listBalanceTransactions(undefined,20,[]),[]);
      await assert.rejects(admin.ledgerPage({pageSize:101}),error=>error.code==="BAD_REQUEST");

      // Export uses the same visibility rules, without page/legacy row caps.
      const collect = async options => {
        const rows=[];
        for await (const batch of billing.iterateBillingLedgerExport(options)) rows.push(...batch);
        return rows;
      };
      const allExport = await collect({isAdmin:true,viewerUserId:1});
      assert.deepEqual(keys(allExport),keys(adminExpected));
      assert.deepEqual(keys(await collect({isAdmin:true,viewerUserId:1,userId:2})),keys(visible(true,2)));
      assert.deepEqual(keys(await collect({viewerUserId:2,userId:3})),keys(visible(false,2)));
      assert.deepEqual(keys(await collect({viewerUserId:2,includeCancelledSubscriptions:false})),keys(visible(false,2,false)));
      assert.deepEqual(await collect({userId:2}),[]);
      const iterator = billing.iterateBillingLedgerExport({isAdmin:true,viewerUserId:1});
      const first = await iterator.next();
      assert.equal(first.value.length,500);
      await insert("balance_transactions",{id:10000,userId:2,type:"admin_recharge",amountCents:99,balanceAfterCents:99,createdAt:now-100000});
      const duringExport = [...first.value];
      for await (const batch of iterator) duringExport.push(...batch);
      assert.deepEqual(keys(duringExport),keys(adminExpected),"new backdated rows cannot move the end of a running export");

      // HTTP boundary enforces scope even when the client sends someone else's ID.
      const { createBillingExportRouter } = await import(url("server/billingExportRoutes.ts"));
      const { default: express } = await import("express");
      const { default: ExcelJS } = await import("exceljs");
      const app = express();
      app.use(createBillingExportRouter(async ({req,res})=> {
        const role=req.headers["x-test-role"];
        return {req,res,user:role?{id:role==="admin"?1:2,role,accountEnabled:role!=="disabled"}:null};
      }));
      const server = app.listen(0,"127.0.0.1");
      await new Promise(resolve=>server.once("listening",resolve));
      const base="http://127.0.0.1:"+server.address().port+"/api/billing/ledger.xlsx";
      const request = (query="",role="user") => fetch(base+query,{headers:role?{"x-test-role":role}:{}});
      const readXlsx = async response => {
        assert.equal(response.status,200);
        assert.match(response.headers.get("content-type"),/spreadsheetml.sheet/);
        assert.equal(response.headers.get("cache-control"),"no-store");
        const wb=new ExcelJS.Workbook();
        await wb.xlsx.load(Buffer.from(await response.arrayBuffer()));
        const rows=[];
        wb.worksheets[0].eachRow((row,index)=>{if(index>5) rows.push(row);});
        return rows;
      };
      try {
        assert.equal((await request("","")).status,401);
        assert.equal((await request("","disabled")).status,401);
        assert.equal((await request("?userId=invalid")).status,400);
        const userRows=await readXlsx(await request("?userId=3"));
        assert.equal(userRows.length,visible(false,2).length+1);
        assert.ok(userRows.every(row=>row.getCell(3).value==="2"));
        const adminRows=await readXlsx(await request("","admin"));
        assert.equal(adminRows.length,adminExpected.length+1);
        assert.deepEqual(new Set(adminRows.map(row=>row.getCell(3).value)),new Set(["2","3"]));
        const filteredRows=await readXlsx(await request("?userId=3","admin"));
        assert.equal(filteredRows.length,visible(true,3).length);
        assert.ok(filteredRows.every(row=>row.getCell(3).value==="3"));
        assert.equal((await readXlsx(await request("?userId=1","admin"))).length,0);
        assert.equal((await request("","admin")).status,429);
      } finally { await new Promise(resolve=>server.close(resolve)); }
    } finally { await runtime.closeDatabase(); }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: {...process.env,DATABASE_TYPE:"sqlite",FORWARDX_TEST_DB:path.join(directory,"billing.db"),FORWARDX_LOG_DIR:path.join(directory,"logs")},
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, {recursive:true,force:true});
  }
});
