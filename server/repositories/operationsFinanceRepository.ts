import { queryRaw } from "../dbRuntime";
import { quoteIdentifier as q } from "../dbCompat";

export const OPERATIONS_LEDGER_PAGE_SIZE = 10;
function scope(start: number, end: number, time: string, userId?: number) {
  return { where: `${time} >= ? AND ${time} < ?${userId === undefined ? "" : ` AND ${q("userId")} = ?`}`, params: userId === undefined ? [start, end] : [start, end, userId] };
}
// Receipts are orders, consumption is the balance ledger. Never add the two:
// a top-up followed by a wallet purchase is one receipt, not two revenues.
const paidTime = () => `COALESCE(${q("paidAt")}, ${q("createdAt")})`;
function paymentScope(start:number,end:number,userId?:number) {
  // Keep paidAt and createdAt indexable instead of filtering on COALESCE.
  return {where:`((${q("paidAt")} >= ? AND ${q("paidAt")} < ?) OR (${q("paidAt")} IS NULL AND ${q("createdAt")} >= ? AND ${q("createdAt")} < ?))${userId === undefined ? "" : ` AND ${q("userId")} = ?`}`,params:userId === undefined ? [start,end,start,end] : [start,end,start,end,userId]};
}
export async function getOperationsFinance(start: number, end: number, userId?: number) {
  const paid = paymentScope(start,end,userId);
  const created = scope(start,end,q("createdAt"),userId);
  const [receipts, balances, orders, subscriptions, active] = await Promise.all([
    queryRaw<any>(`SELECT ${q("currency")}, ${q("orderType")}, ${q("provider")}, ${q("paymentType")}, COUNT(*) AS ${q("count")}, SUM(${q("amountCents")}) AS ${q("amountCents")} FROM ${q("payment_orders")} WHERE ${paid.where} AND ${q("status")} IN ('paid','completed') AND ${q("orderType")} IN ('balance','plan') GROUP BY ${q("currency")}, ${q("orderType")}, ${q("provider")}, ${q("paymentType")} ORDER BY ${q("currency")}, ${q("amountCents")} DESC`,paid.params),
    queryRaw<any>(`SELECT ${q("type")}, COUNT(*) AS ${q("count")}, SUM(CASE WHEN ${q("amountCents")} > 0 THEN ${q("amountCents")} ELSE 0 END) AS ${q("creditCents")}, SUM(CASE WHEN ${q("amountCents")} < 0 THEN -${q("amountCents")} ELSE 0 END) AS ${q("debitCents")} FROM ${q("balance_transactions")} WHERE ${created.where} GROUP BY ${q("type")} ORDER BY ${q("type")}`,created.params),
    queryRaw<any>(`SELECT ${q("status")}, COUNT(*) AS ${q("count")} FROM ${q("payment_orders")} WHERE ${created.where} AND ${q("orderType")} IN ('balance','plan') GROUP BY ${q("status")}`,created.params),
    queryRaw<any>(`SELECT ${q("source")}, COUNT(*) AS ${q("count")} FROM ${q("user_subscriptions")} WHERE ${created.where} GROUP BY ${q("source")}`,created.params),
    queryRaw<any>(`SELECT COUNT(*) AS ${q("count")} FROM ${q("user_subscriptions")} WHERE ${q("status")} = 'active' AND ${q("startedAt")} <= ? AND (${q("expiresAt")} IS NULL OR ${q("expiresAt")} > ?)${userId === undefined ? "" : ` AND ${q("userId")} = ?`}`,userId === undefined ? [Math.floor(Date.now()/1000),Math.floor(Date.now()/1000)] : [Math.floor(Date.now()/1000),Math.floor(Date.now()/1000),userId]),
  ]);
  return {
    receipts: receipts.map(row=>({...row,count:Number(row.count),amountCents:Number(row.amountCents)})) as Array<{currency:string;orderType:string;provider:string;paymentType:string;count:number;amountCents:number}>,
    balances: balances.map(row=>({...row,count:Number(row.count),creditCents:Number(row.creditCents),debitCents:Number(row.debitCents)})) as Array<{type:string;count:number;creditCents:number;debitCents:number}>,
    orders: orders.map(row=>({status:String(row.status),count:Number(row.count)})),
    subscriptions: subscriptions.map(row=>({source:String(row.source),count:Number(row.count)})),
    activeSubscriptions:Number(active[0]?.count || 0),
  };
}
export type OperationsFinance = Awaited<ReturnType<typeof getOperationsFinance>>;

export async function getOperationsFinanceLedger(start: number, end: number, userId?: number, page = 0) {
  const orders = paymentScope(start,end,userId), balances = scope(start,end,q("createdAt"),userId);
  const orderFilter = `${orders.where} AND ${q("orderType")} IN ('balance','plan')`;
  const params = [...orders.params,...balances.params];
  const [counts] = await queryRaw<any>(`SELECT (SELECT COUNT(*) FROM ${q("payment_orders")} WHERE ${orderFilter}) + (SELECT COUNT(*) FROM ${q("balance_transactions")} WHERE ${balances.where}) AS ${q("count")}`,params);
  const total = Number(counts?.count || 0), lastPage = Math.max(0,Math.ceil(total/OPERATIONS_LEDGER_PAGE_SIZE)-1);
  const currentPage = Math.max(0,Math.min(lastPage,Math.trunc(page) || 0));
  const fields = ["id","userId","kind","type","status","amountCents","currency","title","eventAt"];
  const union = `SELECT ${q("id")}, ${q("userId")}, 'payment' AS ${q("kind")}, ${q("orderType")} AS ${q("type")}, ${q("status")}, ${q("amountCents")}, ${q("currency")}, ${q("subject")} AS ${q("title")}, ${paidTime()} AS ${q("eventAt")} FROM ${q("payment_orders")} WHERE ${orderFilter}
    UNION ALL SELECT ${q("id")}, ${q("userId")}, 'balance' AS ${q("kind")}, ${q("type")}, 'completed' AS ${q("status")}, ${q("amountCents")}, 'CNY' AS ${q("currency")}, ${q("description")} AS ${q("title")}, ${q("createdAt")} AS ${q("eventAt")} FROM ${q("balance_transactions")} WHERE ${balances.where}`;
  const rows = await queryRaw<any>(`SELECT ${fields.map(field=>`l.${q(field)}`).join(",")}, u.${q("username")} FROM (${union}) l LEFT JOIN ${q("users")} u ON u.${q("id")} = l.${q("userId")} ORDER BY l.${q("eventAt")} DESC, l.${q("kind")}, l.${q("id")} DESC LIMIT ${OPERATIONS_LEDGER_PAGE_SIZE} OFFSET ${currentPage*OPERATIONS_LEDGER_PAGE_SIZE}`,params);
  return {total,page:currentPage,rows:rows.map(row=>({...row,id:Number(row.id),userId:Number(row.userId),amountCents:Number(row.amountCents),eventAt:Number(row.eventAt)})) as Array<{id:number;userId:number;username:string|null;kind:string;type:string;status:string;amountCents:number;currency:string;title:string|null;eventAt:number}>};
}
