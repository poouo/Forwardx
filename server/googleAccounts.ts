import crypto from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { users } from "../drizzle/schema";
import { getDb, withDatabaseTransaction } from "./dbRuntime";
import { getSetting } from "./repositories/settingsRepository";
import { getUserById, registerUser } from "./repositories/userRepository";
import { getEmailConfig } from "./email";
import { ensureAllowedEmail } from "./routers/auth";
import { withKeyedTaskLock } from "./keyedTaskLock";
import { GoogleAuthError } from "./googleOAuth";

export const GOOGLE_ONLY_PASSWORD = "!google-only";
export type GoogleIdentity = { subject: string; email: string; name: string };

export async function resolveGoogleAccount(identity: GoogleIdentity, bindingUserId?: number) {
  // Local serialization avoids duplicate first-login registration; the unique
  // database subject constraint remains the final protection across processes.
  return withKeyedTaskLock("google-account-link", () => withDatabaseTransaction(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const [linked] = await db.select().from(users).where(eq(users.googleSubject, identity.subject)).limit(1);
    if (bindingUserId) {
      const user = await getUserById(bindingUserId);
      if (!user || user.accountEnabled === false) throw new GoogleAuthError("session_expired");
      if ((linked && linked.id !== bindingUserId) || (user.googleSubject && user.googleSubject !== identity.subject)) throw new GoogleAuthError("already_bound");
      await db.update(users).set({ googleSubject: identity.subject, googleEmail: identity.email, googleLinkedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, bindingUserId));
      return (await getUserById(bindingUserId))!;
    }
    if (linked) {
      if (linked.accountEnabled === false) throw new GoogleAuthError("account_disabled");
      await db.update(users).set({ googleEmail: identity.email, lastSignedIn: new Date() }).where(eq(users.id, linked.id));
      return linked;
    }
    if ((await getSetting("registrationEnabled")) === "false") throw new GoogleAuthError("registration_closed");
    try { ensureAllowedEmail(identity.email, await getEmailConfig()); } catch { throw new GoogleAuthError("email_not_allowed"); }
    // Never silently attach Google to a password account, even if its email is
    // verified. Authenticate that existing account first and explicitly bind.
    const matches = await db.select({ id: users.id }).from(users)
      .where(sql`LOWER(${users.username}) = ${identity.email} OR LOWER(${users.email}) = ${identity.email}`).limit(1);
    if (matches.length) throw new GoogleAuthError("existing_account");
    // Keep usernames compatible with the panel's existing 64-character limit.
    const username = identity.email.length <= 64 ? identity.email : `google-${crypto.randomBytes(16).toString("hex")}@forwardx.local`;
    const id = await registerUser({ username, password: crypto.randomBytes(48).toString("hex"),
      name: identity.name || identity.email.slice(0, 24), email: identity.email, emailVerified: true, emailVerifiedAt: new Date() });
    await db.update(users).set({ googleSubject: identity.subject, googleEmail: identity.email, googleLinkedAt: new Date(), password: GOOGLE_ONLY_PASSWORD }).where(eq(users.id, id));
    return (await getUserById(id))!;
  }));
}
