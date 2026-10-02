import type { User } from "../drizzle/schema";
import { getUserById } from "./repositories/userRepository";

export async function resolveRuleOperationOwner(actor: User, requestedUserId?: number): Promise<User> {
  if (requestedUserId === undefined || requestedUserId === actor.id) return actor;
  if (actor.role !== "admin") throw new Error("无权操作其他用户的规则");
  const owner = await getUserById(requestedUserId);
  if (!owner) throw new Error("所选用户不存在");
  if (owner.accountEnabled === false) throw new Error("所选用户已被禁用");
  return owner;
}
