import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import * as pluginRepo from "../repositories/pluginRepository";

const githubInstallSchema = z.object({
  repository: z.string().trim().url().max(512),
  branch: z.string().trim().max(128).optional(),
  manifestPath: z.string().trim().max(256).optional(),
  fallbackStoreId: z.string().trim().max(128).optional(),
});

export const pluginsRouter = router({
  capabilities: adminProcedure.query(async () => {
    return pluginRepo.getPluginDeveloperCapabilities();
  }),

  store: adminProcedure.query(async () => {
    return pluginRepo.getPluginStoreItems();
  }),

  list: adminProcedure.query(async () => {
    return pluginRepo.listPlugins();
  }),

  assets: adminProcedure
    .input(z.object({ pluginId: z.string().trim().min(1).max(128) }))
    .query(async ({ input }) => {
      return pluginRepo.listPluginAssets(input.pluginId);
    }),

  installFromStore: adminProcedure
    .input(z.object({ id: z.string().trim().min(1).max(128) }))
    .mutation(async ({ input }) => {
      const item = (await pluginRepo.getPluginStoreItems()).find((candidate) => candidate.id === input.id);
      if (!item) throw new Error("插件商店中没有找到该插件");
      return pluginRepo.installPluginFromStoreItem(item);
    }),

  installFromGithub: adminProcedure
    .input(githubInstallSchema)
    .mutation(async ({ input }) => {
      return pluginRepo.installPluginFromGithub(input);
    }),

  installFromUpload: adminProcedure
    .input(z.object({
      content: z.string().min(1).max(8 * 1024 * 1024),
      fileName: z.string().trim().max(240).optional(),
      encoding: z.enum(["text", "base64"]).optional(),
    }))
    .mutation(async ({ input }) => {
      if (input.encoding === "base64") {
        return pluginRepo.installPluginFromPackage({
          content: Buffer.from(input.content, "base64"),
          fileName: input.fileName || "plugin-package",
          sourceType: "upload",
        });
      }
      return pluginRepo.installPluginFromUpload(input.content);
    }),

  setEnabled: adminProcedure
    .input(z.object({ pluginId: z.string().trim().min(1).max(128), enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      return pluginRepo.setPluginEnabled(input.pluginId, input.enabled);
    }),

  uninstall: adminProcedure
    .input(z.object({ pluginId: z.string().trim().min(1).max(128) }))
    .mutation(async ({ input }) => {
      await pluginRepo.uninstallPlugin(input.pluginId);
      return { ok: true };
    }),

  checkUpdate: adminProcedure
    .input(z.object({ pluginId: z.string().trim().min(1).max(128) }))
    .mutation(async ({ input }) => {
      return pluginRepo.checkPluginUpdate(input.pluginId);
    }),

  updateFromGithub: adminProcedure
    .input(z.object({ pluginId: z.string().trim().min(1).max(128) }))
    .mutation(async ({ input }) => {
      return pluginRepo.updatePluginFromGithub(input.pluginId);
    }),

  saveSetting: adminProcedure
    .input(z.object({
      pluginId: z.string().trim().min(1).max(128),
      key: z.string().trim().min(1).max(128),
      value: z.unknown(),
    }))
    .mutation(async ({ input }) => {
      return pluginRepo.savePluginSetting(input.pluginId, input.key, input.value);
    }),

  runAction: adminProcedure
    .input(z.object({
      pluginId: z.string().trim().min(1).max(128),
      actionId: z.string().trim().min(1).max(128),
      input: z.record(z.unknown()).optional(),
    }))
    .mutation(async ({ input }) => {
      return pluginRepo.runPluginAction(input.pluginId, input.actionId, input.input);
    }),

  agentActionStatus: adminProcedure
    .input(z.object({
      pluginId: z.string().trim().min(1).max(128),
      groupId: z.string().uuid(),
    }))
    .query(async ({ input }) => {
      return pluginRepo.getPluginAgentActionStatus(input.pluginId, input.groupId);
    }),

  usage: adminProcedure
    .input(z.object({
      pluginId: z.string().trim().min(1).max(128),
      usageViewId: z.string().trim().min(1).max(128).optional(),
    }))
    .query(async ({ input }) => {
      return pluginRepo.getPluginUsage(input.pluginId, input.usageViewId);
    }),

  saveUsage: adminProcedure
    .input(z.object({
      pluginId: z.string().trim().min(1).max(128),
      usageViewId: z.string().trim().min(1).max(128).optional(),
      enabled: z.boolean(),
      hostIds: z.array(z.number().int().positive()).max(512),
      assetPaths: z.array(z.string().trim().min(1).max(240)).max(96),
      operation: z.string().trim().max(80).optional(),
      fieldValues: z.record(z.unknown()).optional(),
      note: z.string().max(500).optional(),
    }))
    .mutation(async ({ input }) => {
      return pluginRepo.savePluginUsage(input.pluginId, input.usageViewId, {
        enabled: input.enabled,
        hostIds: input.hostIds,
        assetPaths: input.assetPaths,
        mode: "sync-files",
        operation: input.operation,
        fieldValues: input.fieldValues,
        note: input.note,
      });
    }),

  extensionPoints: adminProcedure.query(async () => {
    return pluginRepo.getEnabledPluginExtensionPoints();
  }),
});
