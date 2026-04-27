import { build } from "esbuild";

await build({
  entryPoints: ["server/index.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/index.js",
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
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
`,
  },
});

console.log("Server build complete: dist/index.js");
