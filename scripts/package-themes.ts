import fs from "node:fs";
import { zipSync, strToU8 } from "fflate";
import { themeTemplateFiles } from "../shared/themes";
import { THEME_FIELDS } from "../shared/themeFields";

const files = themeTemplateFiles();
const archive = zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strToU8(content)])), { mtime: new Date("2026-01-01T00:00:00Z") });
fs.mkdirSync("docs/public/themes", { recursive: true });
fs.writeFileSync("docs/public/themes/forwardx-theme-starter.zip", archive);
fs.writeFileSync("docs/public/themes/fields.json", JSON.stringify({ apiVersion: 1, fields: THEME_FIELDS }, null, 2) + "\n");
console.log("Theme template: docs/public/themes/forwardx-theme-starter.zip");
