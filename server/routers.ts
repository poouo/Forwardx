import { systemRouter } from "./_core/systemRouter";
import { paymentRouter } from "./payment";
import { router } from "./_core/trpc";
import { agentTokensRouter } from "./routers/agentTokens";
import { announcementsRouter } from "./routers/announcements";
import { supportTicketsRouter } from "./routers/supportTickets";
import { affiliatesRouter } from "./routers/affiliates";
import { mcpRouter } from "./routers/mcp";
import { authRouter } from "./routers/auth";
import { googleRouter } from "./routers/google";
import { billingRouter } from "./routers/billing";
import { dashboardRouter } from "./routers/dashboard";
import { operationsRouter } from "./routers/operations";
import { forwardGroupsRouter } from "./routers/forwardGroups";
import { hostsRouter } from "./routers/hosts";
import { lookingGlassRouter } from "./routers/lookingGlass";
import { plansRouter } from "./routers/plans";
import { pluginsRouter } from "./routers/plugins";
import { rulesRouter } from "./routers/rules";
import { setupRouter } from "./routers/setup";
import { telegramRouter } from "./routers/telegram";
import { discordRouter } from "./routers/discord";
import { trafficBillingRouter } from "./routers/trafficBilling";
import { tunnelsRouter } from "./routers/tunnels";
import { usersRouter } from "./routers/users";

export const appRouter = router({
  system: systemRouter,
  setup: setupRouter,
  payment: paymentRouter,
  billing: billingRouter,
  plans: plansRouter,
  plugins: pluginsRouter,
  auth: authRouter,
  google: googleRouter,
  dashboard: dashboardRouter,
  operations: operationsRouter,
  users: usersRouter,
  hosts: hostsRouter,
  lookingGlass: lookingGlassRouter,
  rules: rulesRouter,
  forwardGroups: forwardGroupsRouter,
  tunnels: tunnelsRouter,
  telegram: telegramRouter,
  discord: discordRouter,
  trafficBilling: trafficBillingRouter,
  agentTokens: agentTokensRouter,
  announcements: announcementsRouter,
  supportTickets: supportTicketsRouter,
  affiliates: affiliatesRouter,
  mcp: mcpRouter,
});

export type AppRouter = typeof appRouter;
