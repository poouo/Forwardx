import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("finance separates receipts and spending, preserves currencies, scopes accounts and pages history",()=> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),"forwardx-finance-"));
  try {
    const result = spawnSync(process.execPath,["--import","tsx","--input-type=module","-e",String.raw`
      import assert from 'node:assert/strict';
      const rt=await import('./server/dbRuntime.ts');
      await rt.connectDatabase({type:'sqlite',sqlite:{path:process.env.FORWARDX_TEST_DB}});
      const schema=await import('./server/dbSchema.ts'); await schema.ensureDatabaseSchema();
      const finance=await import('./server/repositories/operationsFinanceRepository.ts');
      const {operationsDay,operationsDate}=await import('./shared/operations.ts');
      const now=Math.floor(Date.now()/1000),start=operationsDay(now),end=start+86400;
      const insert=async(table,row)=>{const keys=Object.keys(row);await rt.executeRaw('INSERT INTO '+table+' ('+keys.map(rt.quoteDbIdentifier).join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')',Object.values(row));};
      try {
        await insert('users',{id:1,username:'admin',password:'test-only',role:'admin'});await insert('users',{id:2,username:'other',password:'test-only',role:'user'});
        const order=async(id,extra={})=>insert('payment_orders',{id,userId:1,outTradeNo:'test-'+id,provider:'easypay',paymentType:'alipay',subject:'private subject',orderType:'balance',currency:'CNY',amountCents:10000,status:'completed',createdAt:start+1,paidAt:start+2,...extra});
        await order(1);
        await order(2,{orderType:'plan',amountCents:3000,createdAt:start-86400});
        await order(3,{orderType:'test',amountCents:990000});
        await order(4,{status:'pending',paidAt:null});
        await order(5,{status:'failed',paidAt:null});
        await order(6,{status:'cancelled',paidAt:null});
        await order(7,{currency:'USD',amountCents:1200});
        await order(8,{paidAt:null,amountCents:700});
        await order(9,{userId:2,amountCents:4000});
        await order(10,{paidAt:end,amountCents:8800});
        await order(11,{paidAt:start-1,amountCents:9900});
        const tx=async(id,type,amount,userId=1)=>insert('balance_transactions',{id,userId,type,amountCents:amount,balanceAfterCents:12345,createdAt:start+3,description:'private detail'});
        await tx(1,'payment',10000);await tx(2,'purchase',-2000);await tx(3,'traffic_addon_purchase',-500);await tx(4,'traffic_billing',-100);
        await tx(5,'admin_recharge',800);await tx(6,'redeem',600);await tx(7,'admin_adjust',-200);await tx(8,'affiliate_transfer',300);await tx(9,'payment',4000,2);
        await insert('traffic_billing_records',{userId:1,ruleId:1,resourceType:'host',resourceId:1,amountCents:100,createdAt:start+3});
        await insert('user_subscriptions',{id:1,userId:1,planId:1,source:'balance',status:'active',startedAt:now-1,expiresAt:now+3600,createdAt:start+1});
        await insert('user_subscriptions',{id:2,userId:1,planId:1,source:'admin',status:'active',startedAt:now-100,expiresAt:now-1,createdAt:start+1});
        await insert('user_subscriptions',{id:3,userId:2,planId:1,source:'payment',status:'active',startedAt:now-1,createdAt:start+1});
        const scoped=await finance.getOperationsFinance(start,end,1);
        assert.equal(scoped.receipts.filter(r=>r.currency==='CNY').reduce((s,r)=>s+r.amountCents,0),13700);
        assert.equal(scoped.receipts.filter(r=>r.currency==='USD').reduce((s,r)=>s+r.amountCents,0),1200);
        assert.equal(scoped.receipts.reduce((s,r)=>s+r.count,0),4);
        assert.equal(scoped.balances.find(r=>r.type==='traffic_billing').debitCents,100);
        assert.equal(scoped.balances.find(r=>r.type==='payment').creditCents,10000);
        assert.equal(scoped.balances.find(r=>r.type==='admin_adjust').debitCents,200);
        assert.equal(scoped.activeSubscriptions,1);
        assert.equal(scoped.subscriptions.reduce((s,r)=>s+r.count,0),2);
        assert.equal(scoped.orders.reduce((s,r)=>s+r.count,0),8);
        const all=await finance.getOperationsFinance(start,end);
        assert.equal(all.receipts.filter(r=>r.currency==='CNY').reduce((s,r)=>s+r.amountCents,0),17700);
        assert.equal(all.activeSubscriptions,2);
        const empty=await finance.getOperationsFinance(start,end,999);
        assert.deepEqual(empty.receipts,[]);assert.equal(empty.activeSubscriptions,0);
        const p0=await finance.getOperationsFinanceLedger(start,end,1),p1=await finance.getOperationsFinanceLedger(start,end,1,1);
        assert.equal(p0.total,15);assert.equal(p0.rows.length,10);assert.equal(p1.rows.length,5);
        const rows=[...p0.rows,...p1.rows];assert.equal(new Set(rows.map(r=>r.kind+':'+r.id)).size,15);
        assert.ok(rows.every(r=>r.userId===1));assert.ok(rows.every((r,i)=>!i || r.eventAt<=rows[i-1].eventAt));
        assert.ok(rows.some(r=>r.kind==='payment' && r.id===2));assert.ok(!rows.some(r=>r.kind==='payment' && r.id===3));
        assert.equal((await finance.getOperationsFinanceLedger(start,end,1,999)).page,1);
        const {operationsRouter}=await import('./server/routers/operations.ts');
        const caller=id=>operationsRouter.createCaller({user:{id,role:'admin'},req:{headers:{}},res:{}});
        const dates={from:operationsDate(start),to:operationsDate(start)};
        assert.equal((await caller(1).finance(dates)).activeSubscriptions,1);
        assert.equal((await caller(2).finance(dates)).receipts[0].amountCents,4000);
        assert.equal((await caller(1).finance({...dates,userId:'all'})).activeSubscriptions,2);
        assert.ok((await caller(1).financeLedger({...dates,userId:2})).rows.every(r=>r.userId===2));
        const ordinary=operationsRouter.createCaller({user:{id:2,role:'user'},req:{headers:{}},res:{}});
        await assert.rejects(ordinary.finance(dates),e=>e.code==='FORBIDDEN');
        await assert.rejects(ordinary.financeLedger(dates),e=>e.code==='FORBIDDEN');
        const before=(await rt.queryRaw('SELECT COUNT(*) n FROM balance_transactions'))[0].n;
        await (await import('./server/repositories/operationsRepository.ts')).cleanOperationsHistory();
        assert.equal((await rt.queryRaw('SELECT COUNT(*) n FROM balance_transactions'))[0].n,before);
        for(const [table,columns] of [['payment_orders',['paidAt']],['balance_transactions',['createdAt']],['user_subscriptions',['createdAt']]]) {
          assert.ok(schema.getDatabaseTableDefs().find(t=>t.name===table).indexes.some(i=>i.join()===columns.join()));
        }
      } finally {await rt.closeDatabase();}
    `],{cwd:process.cwd(),env:{...process.env,DATABASE_TYPE:"sqlite",FORWARDX_TEST_DB:path.join(directory,"test.db"),FORWARDX_LOG_DIR:path.join(directory,"logs")},encoding:"utf8",timeout:60000,windowsHide:true});
    assert.equal(result.status,0,result.stdout+result.stderr);
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
