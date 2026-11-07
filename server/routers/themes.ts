import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { zipSync, strToU8 } from "fflate";
import { adminProcedure, publicProcedure, router } from "../_core/trpc";
import { THEME_API_VERSION, THEME_ARCHIVE_FORMATS, THEME_LIMITS, THEME_PARTS, themeTemplateFiles } from "../../shared/themes";
import { downloadThemeArchive } from "../themeDownload";
import { activateTheme, installTheme, listThemes, publicThemeStyles, removeTheme } from "../repositories/themeRepository";
import { THEME_FIELDS } from "../../shared/themeFields";

const id = z.string().regex(/^[a-z][a-z0-9-]{2,63}$/);
const base = z.enum(["ink", "teal", "forest", "wisteria", "ember", "sakura"]);

export const themesRouter = router({
  list: adminProcedure.query(listThemes),
  capabilities: adminProcedure.query(() => ({ apiVersion: THEME_API_VERSION, features: ["css", "views", "host-fields", "login-copy", "shell-layout"], formats: THEME_ARCHIVE_FORMATS, limits: THEME_LIMITS, parts: THEME_PARTS, fields: THEME_FIELDS, templateLimits: { depth: 6, nodes: 128, children: 24 }, documentation: "/guide/themes" })),
  importUrl: adminProcedure.input(z.object({ url: z.string().url().max(2048), replace: z.boolean().default(false) })).mutation(async ({ input }) => {
    let archive: Buffer;
    try { archive = await downloadThemeArchive(input.url); }
    catch (cause) { throw new TRPCError({ code: "BAD_REQUEST", message: cause instanceof Error ? cause.message : "主题下载失败", cause }); }
    return installTheme(archive, input.replace);
  }),
  install: adminProcedure.input(z.object({
    archiveBase64: z.string().min(4).max(4 * Math.ceil(THEME_LIMITS.archiveBytes / 3)),
    replace: z.boolean().default(false),
  })).mutation(({ input }) => {
    const encoded = input.archiveBase64;
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    // Avoid a repeated-group regex whose stack can overflow on image-heavy archives.
    if (encoded.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(encoded.slice(0, encoded.length - padding))) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "主题压缩包 Base64 无效" });
    }
    return installTheme(Buffer.from(input.archiveBase64, "base64"), input.replace);
  }),
  activate: adminProcedure.input(z.object({ id })).mutation(({ input }) => activateTheme(input.id)),
  remove: adminProcedure.input(z.object({ id })).mutation(({ input }) => removeTheme(input.id)),
  styles: publicProcedure.input(z.object({ id, revision: z.string().regex(/^[a-f0-9]{64}$/) }))
    .query(({ input }) => publicThemeStyles(input.id, input.revision)),
  template: adminProcedure.input(z.object({ base: base.default("teal") }).default({})).query(({ input }) => {
    const files = themeTemplateFiles(input.base);
    const archive = zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
    return { filename: `forwardx-theme-${input.base}-starter.zip`, archiveBase64: Buffer.from(archive).toString("base64") };
  }),
});
