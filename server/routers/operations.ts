import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { adminProcedure, router } from "../_core/trpc";
import { operationsRange, OPERATIONS_SOURCE_SORTS, CHINA_PROVINCES } from "../../shared/operations";
import { getOperationsOverview, getOperationsSources, getOperationsSourceDetails, getOperationsProvinceDetails } from "../repositories/operationsRepository";
import { setSetting } from "../repositories/settingsRepository";
import { resolveOperationsSourceGeo } from "../operationsSourceGeo";
import { createQueryCache } from "../queryCache";
import { getOperationsFinance, getOperationsFinanceLedger } from "../repositories/operationsFinanceRepository";
import { monitorOverview, saveMonitorSettings } from "../operationsMonitor";
import { operationsMonitorSchema } from "../../shared/operationsMonitor";

const cache = createQueryCache(30);
const dates = z.object({ from: z.string().length(10), to: z.string().length(10), userId: z.union([z.literal("self"), z.literal("all"), z.number().int().positive()]).default("self") });
function scopedUserId(input: z.infer<typeof dates>, currentUserId: number) {
  return input.userId === "all" ? undefined : input.userId === "self" ? currentUserId : input.userId;
}
function range(input: z.infer<typeof dates>) {
  try { return operationsRange(input.from, input.to); }
  catch (error) { throw new TRPCError({ code: "BAD_REQUEST", message: String((error as Error).message) }); }
}
let geoBusy = false;
let geoLastRequest = 0;
export const operationsRouter = router({
  monitor: adminProcedure.input(z.object({ page: z.number().int().min(0).max(10000).default(0) }).default({})).query(({ input }) => cache.get(`monitor:${input.page}`, { ttlMs: 5000, staleMs: 0 }, () => monitorOverview(input.page))),
  saveMonitor: adminProcedure.input(operationsMonitorSchema).mutation(async ({ input }) => { const value = await saveMonitorSettings(input); cache.clear(); return value; }),
  finance: adminProcedure.input(dates).query(({input,ctx})=> {
    const {start,end} = range(input), userId = scopedUserId(input,ctx.user.id);
    return cache.get(`finance:${start}:${end}:${userId ?? "all"}`,{ttlMs:15000,staleMs:0},()=>getOperationsFinance(start,end,userId));
  }),
  financeLedger: adminProcedure.input(dates.extend({page:z.number().int().min(0).max(10000).default(0)})).query(({input,ctx})=> {
    const {start,end} = range(input), userId = scopedUserId(input,ctx.user.id);
    return cache.get(`ledger:${start}:${end}:${userId ?? "all"}:${input.page}`,{ttlMs:15000,staleMs:0},()=>getOperationsFinanceLedger(start,end,userId,input.page));
  }),
  overview: adminProcedure.input(dates).query(({ input, ctx }) => {
    const { start, end } = range(input);
    const userId = scopedUserId(input, ctx.user.id);
    return cache.get(`overview:${start}:${end}:${userId ?? "all"}`, { ttlMs: 15000, staleMs: 0 }, () => getOperationsOverview(start, end, userId));
  }),
  sources: adminProcedure.input(dates.extend({ page: z.number().int().min(0).max(10000).default(0), search: z.string().max(64).default(""), sort: z.enum(OPERATIONS_SOURCE_SORTS).default("traffic") })).query(({ input, ctx }) => {
    const { start, end } = range(input);
    const userId = scopedUserId(input, ctx.user.id);
    return cache.get(`sources:${start}:${end}:${userId ?? "all"}:${input.page}:${input.search}:${input.sort}`, { ttlMs: 15000, staleMs: 0 }, () => getOperationsSources(start, end, input.page, input.search, userId, input.sort));
  }),
  sourceDetails: adminProcedure.input(dates.extend({ ip: z.string().ip() })).query(({ input, ctx }) => {
    const { start, end } = range(input);
    return getOperationsSourceDetails(start, end, input.ip, scopedUserId(input, ctx.user.id));
  }),
  provinceDetails: adminProcedure.input(dates.extend({ province:z.string().refine(value=>CHINA_PROVINCES.includes(value)),search:z.string().max(64).default("") })).query(({input,ctx})=> {
    const {start,end} = range(input), userId = scopedUserId(input,ctx.user.id);
    return cache.get(`province:${start}:${end}:${userId ?? "all"}:${input.province}:${input.search}`,{ttlMs:15000,staleMs:0},()=>getOperationsProvinceDetails(start,end,input.province,userId,input.search));
  }),
  setSourceCollection: adminProcedure.input(z.object({ enabled: z.boolean() })).mutation(async ({ input, ctx }) => {
    await setSetting("operationsSourceAnalytics", String(input.enabled));
    console.info(`[Operations] source collection ${input.enabled ? "enabled" : "disabled"} admin=${ctx.user.id}`);
    // Cached query keys include dates; invalidating the small dashboard cache is cheap.
    cache.clear();
    return { success: true };
  }),
  resolveSources: adminProcedure.input(dates.extend({ consent: z.literal(true), after: z.string().max(64).default("") })).mutation(async ({ input, ctx }) => {
    const { start, end } = range(input);
    const userId = scopedUserId(input, ctx.user.id);
    if (geoBusy || Date.now() - geoLastRequest < 3000) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Please wait before looking up more IPs" });
    geoBusy = true; geoLastRequest = Date.now();
    try {
      const result = await resolveOperationsSourceGeo(start,end,userId,input.after,512);
      cache.clear();
      return result;
    } finally { geoBusy = false; }
  }),
});
