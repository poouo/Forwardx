import * as db from "./db";
import { withKeyedTaskLock } from "./keyedTaskLock";
import {
  encodeSessionLease,
  getReplacedSessionSidForLogin,
  getSessionKindField,
  parseSessionLease,
  type SessionKind,
} from "./session";
import { createAuthSession, revokeAuthSession } from "./repositories/sessionRepository";

type CreateLoginSessionInput = {
  userId: number;
  sid: string;
  kind: SessionKind;
  expiresAt: Date;
};

export async function createLoginAuthSession(input: CreateLoginSessionInput) {
  await createAuthSession(input);

  try {
    if ((await db.getSetting("allowMultiDeviceLogin")) === "true") return;

    await withKeyedTaskLock(`auth-session-lease:${input.userId}:${input.kind}`, async () => {
      const user = await db.getUserById(input.userId);
      if (!user) throw new Error("Login user no longer exists");

      const field = getSessionKindField(input.kind);
      const previousLease = parseSessionLease(String((user as any)[field] || ""));
      const replacedSid = getReplacedSessionSidForLogin(previousLease, input.sid);

      // Publish the new winner first. Even if cleanup of the old row fails, the
      // old token can no longer reclaim an active single-device lease.
      await db.setUserSessionToken(
        input.userId,
        input.kind,
        encodeSessionLease(input.sid),
        { touchUserUpdatedAt: false },
      );

      if (replacedSid) {
        await revokeAuthSession(input.userId, replacedSid, input.kind, "replaced_by_login").catch((error) => {
          console.warn(
            `[Auth] replaced session cleanup failed userId=${input.userId} kind=${input.kind}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
    });
  } catch (error) {
    await revokeAuthSession(input.userId, input.sid, input.kind, "login_activation_failed").catch(() => undefined);
    throw error;
  }
}
