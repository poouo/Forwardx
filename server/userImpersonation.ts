import { createHmac, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { TRPCError } from "@trpc/server";
import type { User } from "../drizzle/schema";
import type { SessionKind } from "./session";
import { getSessionKindField, isSessionLeaseOwnedByAnother, parseSessionLease } from "./session";
import { IMPERSONATION_PREFIX, IMPERSONATION_TTL_SECONDS, IMPERSONATION_EXPIRED } from "../shared/userImpersonation";

export type ImpersonationGrant = {
  actorId: number; grantSid: string; expiresAt: number;
  parentSid: string; parentKind: SessionKind; credentialProof: string;
};
export type Impersonation = ImpersonationGrant & { actorName: string };
type ParentSession = { sid: string | null; kind: SessionKind };
type Dependencies = {
  secret: string;
  getUser: (id: number) => Promise<User | undefined>;
  getIdentity: (id: number, sid: string, kind: SessionKind) => Promise<{ user: User; session: unknown } | undefined>;
  createSession: (input: { userId: number; sid: string; kind: SessionKind; expiresAt: Date }) => Promise<unknown>;
  allowMultiple: () => Promise<boolean>;
  now?: () => number;
};
const jwtOptions = { algorithms: ["HS256"] as jwt.Algorithm[], issuer: "forwardx:admin-entry", audience: "forwardx:user-backend" };
function invalid(): never { throw new TRPCError({ code: "UNAUTHORIZED", message: IMPERSONATION_EXPIRED }); }
function credentialProof(secret: string, actor: User, target: User) {
  return createHmac("sha256", secret).update(JSON.stringify(["user-impersonation-v1", actor.id, actor.password, target.id, target.password])).digest();
}
function validUsers(actor: User, target: User) {
  return actor.role === "admin" && actor.accountEnabled !== false && target.role === "user" && target.accountEnabled !== false && actor.id !== target.id;
}

/** Separate, revocable capability. Never creates or claims a target user's login/lease. */
export function createUserImpersonationService(deps: Dependencies) {
  const now = deps.now || Date.now;
  const key = createHmac("sha256", deps.secret).update("user-impersonation-signing-v1").digest();
  // For trusted in-process queues only: retain verified grant metadata, not a
  // reusable Bearer token, and recheck authorization before every queued write.
  async function resume(targetId: number, grant: ImpersonationGrant): Promise<{ user: User; impersonation: Impersonation }> {
    if (!Number.isFinite(grant.expiresAt) || grant.expiresAt <= now()) invalid();
    const [parent, activeGrant, target] = await Promise.all([
      deps.getIdentity(grant.actorId, grant.parentSid, grant.parentKind),
      deps.getIdentity(grant.actorId, grant.grantSid, "browser"), deps.getUser(targetId),
    ]);
    if (!parent?.session || !activeGrant?.session || !target || !validUsers(parent.user, target)) invalid();
    if (grant.credentialProof !== credentialProof(deps.secret, parent.user, target).toString("hex")) invalid();
    if (isSessionLeaseOwnedByAnother(parseSessionLease(parent.user[getSessionKindField(grant.parentKind)]), grant.parentSid, now()) &&
      !(await deps.allowMultiple())) invalid();
    return { user: target, impersonation: { ...grant, actorName: parent.user.username || parent.user.name || "" } };
  }
  return {
    resume,
    async issue(actor: User, session: ParentSession | null, targetId: number) {
      if (!session?.sid || actor.role !== "admin" || actor.accountEnabled === false) {
        throw new TRPCError({ code: "FORBIDDEN", message: "仅已登录的管理员可以进入用户后台" });
      }
      const [parent, target] = await Promise.all([deps.getIdentity(actor.id, session.sid, session.kind), deps.getUser(targetId)]);
      if (!parent?.session || !target || !validUsers(parent.user, target)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "仅支持进入已启用的普通用户后台" });
      }
      const grantSid = `impersonation:${randomUUID()}`;
      const expiresAt = (Math.floor(now() / 1000) + IMPERSONATION_TTL_SECONDS) * 1000;
      await deps.createSession({ userId: actor.id, sid: grantSid, kind: "browser", expiresAt: new Date(expiresAt) });
      const token = IMPERSONATION_PREFIX + jwt.sign({
        actorId: actor.id, targetId: target.id, parentSid: session.sid, parentKind: session.kind, grantSid,
        credentialProof: credentialProof(deps.secret, parent.user, target).toString("hex"),
        iat: Math.floor(now() / 1000), exp: expiresAt / 1000,
      }, key, { algorithm: "HS256", issuer: jwtOptions.issuer, audience: jwtOptions.audience });
      console.info(`[UserEntry] started adminId=${actor.id} targetId=${target.id}`);
      return { token, expiresAt };
    },
    async resolve(token: string): Promise<{ user: User; impersonation: Impersonation }> {
      if (!token.startsWith(IMPERSONATION_PREFIX) || token.length > 4096) invalid();
      const raw = token.slice(IMPERSONATION_PREFIX.length);
      let payload: jwt.JwtPayload;
      try {
        // Authenticate before any DB lookup; arbitrary public Bearers must not
        // consume the shared authentication database work budget.
        const decoded = jwt.verify(raw, key, { ...jwtOptions, clockTimestamp: Math.floor(now() / 1000) });
        if (!decoded || typeof decoded === "string") invalid();
        payload = decoded;
      } catch { invalid(); }
      const { actorId, targetId, parentSid, parentKind, grantSid } = payload;
      if (!Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat) ||
        payload.exp! <= payload.iat! || payload.exp! - payload.iat! > IMPERSONATION_TTL_SECONDS ||
        !Number.isSafeInteger(actorId) || actorId <= 0 || !Number.isSafeInteger(targetId) || targetId <= 0 ||
        typeof parentSid !== "string" || !parentSid || parentSid.length > 128 ||
        !["browser", "mobile", "telegram"].includes(parentKind) ||
        typeof grantSid !== "string" || !/^impersonation:[\da-f-]{36}$/.test(grantSid)) invalid();
      return resume(targetId, { actorId, parentSid, parentKind, grantSid,
        expiresAt: Number(payload.exp) * 1000, credentialProof: String(payload.credentialProof || "") });
    },
  };
}
