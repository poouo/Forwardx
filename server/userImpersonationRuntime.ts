import { createUserImpersonationService } from "./userImpersonation";
import { ENV } from "./env";
import { getUserById, getSetting } from "./db";
import { createAuthSession, getAuthSessionIdentity } from "./repositories/sessionRepository";

export const userImpersonation = createUserImpersonationService({
  secret: ENV.cookieSecret,
  getUser: getUserById,
  getIdentity: getAuthSessionIdentity,
  createSession: createAuthSession,
  allowMultiple: async () => (await getSetting("allowMultiDeviceLogin")) === "true",
});
