import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function managementAsset(name: "agent-proxy.sh" | "install-agent.sh" | "forwardx-manage.sh") {
  // The release build copies these into dist; source development reads scripts.
  for (const directory of ["scripts", "dist/management"]) {
    try { return readFileSync(resolve(process.cwd(), directory, name), "utf8").replace(/\r\n/g, "\n"); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
  }
  throw new Error(`Missing bundled management asset: ${name}`);
}
