import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { personalRuleGroupIdsSchema, personalRuleGroupSaveSchema } from "../../shared/ruleGroups";
import { deletePersonalRuleGroup, getPersonalRuleGroups, moveRulesToPersonalGroups, reorderPersonalRuleGroups, savePersonalRuleGroup } from "../repositories/ruleGroupRepository";

// Never accept an owner ID from the client, including from administrators.
export const personalRuleGroupsRouter = router({
  personalGroups: protectedProcedure.query(({ ctx }) => getPersonalRuleGroups(ctx.user.id)),
  savePersonalGroup: protectedProcedure.input(personalRuleGroupSaveSchema)
    .mutation(({ ctx, input }) => savePersonalRuleGroup(ctx.user.id, input.name, input.id, input)),
  deletePersonalGroup: protectedProcedure.input(z.object({ id: z.number().int().positive() }))
    .mutation(({ ctx, input }) => deletePersonalRuleGroup(ctx.user.id, input.id)),
  reorderPersonalGroups: protectedProcedure.input(z.object({ ids: z.array(z.number().int().positive()).max(100) }))
    .mutation(({ ctx, input }) => reorderPersonalRuleGroups(ctx.user.id, input.ids)),
  moveToPersonalGroups: protectedProcedure.input(z.object({ ids: z.array(z.number().int().positive()).min(1).max(500), groupIds: personalRuleGroupIdsSchema, mode: z.enum(["replace", "add", "remove"]).default("replace") }))
    .mutation(({ ctx, input }) => moveRulesToPersonalGroups(ctx.user.id, input.ids, input.groupIds, input.mode)),
});
