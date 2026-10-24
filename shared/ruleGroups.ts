import { z } from "zod";

export const ruleGroupNameSchema = z.string().trim().min(1).max(64);
const ruleMembershipIdsSchema = z.array(z.number().int().positive()).max(500).default([]).transform(ids => [...new Set(ids)]);
export const personalRuleGroupSaveSchema = z.object({
  id: z.number().int().positive().optional(),
  name: ruleGroupNameSchema,
  addRuleIds: ruleMembershipIdsSchema,
  removeRuleIds: ruleMembershipIdsSchema,
}).refine(input => input.addRuleIds.length + input.removeRuleIds.length <= 500, "每次最多调整 500 条规则")
  .refine(input => !input.addRuleIds.some(id => input.removeRuleIds.includes(id)), "同一规则不能同时加入和移出分组");
export const personalRuleGroupIdsSchema = z.array(z.number().int().positive()).max(100).transform(ids => [...new Set(ids)]);
export const personalRuleGroupChangeFilterSchema = z.object({
  mode: z.enum(["add", "remove"]),
  groupIds: personalRuleGroupIdsSchema,
});
export type PersonalRuleGroupChangeFilter = z.infer<typeof personalRuleGroupChangeFilterSchema>;
export const ruleGroupFilterSchema = z.number().int().min(0).nullable().optional();
export function matchesPersonalRuleGroup(groupIds: readonly number[] | undefined, filter: number | null): boolean {
  if (filter === null) return true;
  if (filter === 0) return !groupIds?.length;
  return !!groupIds?.includes(filter);
}
export const MAX_PERSONAL_RULE_GROUPS = 100;
export type PersonalRuleGroup = { id: number; name: string; sortOrder: number; count: number };
