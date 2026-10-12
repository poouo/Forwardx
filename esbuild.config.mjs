import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

mkdirSync("dist/management", { recursive: true });
for (const name of ["agent-proxy.sh", "install-agent.sh", "forwardx-manage.sh", "install-management.sh", "install-panel-local.sh", "install-panel-docker.sh"]) {
  writeFileSync(`dist/management/${name}`, readFileSync(`scripts/${name}`, "utf8").replace(/\r\n/g, "\n"));
}

await build({
  entryPoints: {
    index: "server/index.ts",
    "migrate-legacy": "server/legacyMigrationCli.ts",
    "reset-admin-password": "server/resetAdminPasswordCli.ts",
  },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outdir: "dist",
  // Mark all node_modules as external so they're resolved at runtime
  packages: "external",
  // Also mark node built-in modules as external
  external: [],
  sourcemap: true,
  // Resolve path aliases
  alias: {
    "@shared": "./shared",
  },
  banner: {
    // Required for ESM compatibility with __dirname and require
    js: `
import { createRequire } from 'module';
import { fileURLToPath as __forwardxFileURLToPath } from 'url';
import { dirname as __forwardxDirname } from 'path';
const require = createRequire(import.meta.url);
const __filename = __forwardxFileURLToPath(import.meta.url);
const __dirname = __forwardxDirname(__filename);
`,
  },
});

console.log("Server build complete: dist/index.js, dist/migrate-legacy.js, dist/reset-admin-password.js");
