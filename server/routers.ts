import { systemRouter } from "./_core/systemRouter";
import { paymentRouter } from "./payment";
import { router } from "./_core/trpc";
import { agentTokensRouter } from "./routers/agentTokens";
import { announcementsRouter } from "./routers/announcements";
import { authRouter } from "./routers/auth";
import { billingRouter } from "./routers/billing";
import { dashboardRouter } from "./routers/dashboard";
import { forwardGroupsRouter } from "./routers/forwardGroups";
import { hostsRouter } from "./routers/hosts";
import { lookingGlassRouter } from "./routers/lookingGlass";
import { plansRouter } from "./routers/plans";
import { rulesRouter } from "./routers/rules";
import { setupRouter } from "./routers/setup";
import { telegramRouter } from "./routers/telegram";
import { trafficBillingRouter } from "./routers/trafficBilling";
import { tunnelsRouter } from "./routers/tunnels";
import { usersRouter } from "./routers/users";

export const appRouter = router({
  system: systemRouter,
  setup: setupRouter,
  payment: paymentRouter,
  billing: billingRouter,
  plans: plansRouter,
  auth: authRouter,
  dashboard: dashboardRouter,
  users: usersRouter,
  hosts: hostsRouter,
  lookingGlass: lookingGlassRouter,
  rules: rulesRouter,
  forwardGroups: forwardGroupsRouter,
  tunnels: tunnelsRouter,
  telegram: telegramRouter,
  trafficBilling: trafficBillingRouter,
  agentTokens: agentTokensRouter,
  announcements: announcementsRouter,
});

export type AppRouter = typeof appRouter;
