import fs from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

const pkg = JSON.parse(read("package.json"));
const versionsTs = read("shared/versions.ts");
const agentMain = read("agent/main.go");

const findTsConst = (name) => {
  const match = versionsTs.match(new RegExp(`export const ${name}\\s*=\\s*["']([^"']+)["']`));
  if (!match) throw new Error(`${name} not found in shared/versions.ts`);
  return match[1];
};

const appVersion = findTsConst("APP_VERSION");
const androidAppVersion = findTsConst("ANDROID_APP_VERSION");
const agentVersion = findTsConst("AGENT_VERSION");
const agentMainVersion = agentMain.match(/var Version\s*=\s*"([^"]+)"/)?.[1];

const errors = [];
if (pkg.version !== appVersion) {
  errors.push(`package.json version ${pkg.version} does not match APP_VERSION ${appVersion}`);
}
if (agentMainVersion !== agentVersion) {
  errors.push(`agent/main.go Version ${agentMainVersion || "(missing)"} does not match AGENT_VERSION ${agentVersion}`);
}
if (appVersion === agentVersion) {
  errors.push(`APP_VERSION and AGENT_VERSION are both ${appVersion}; keep panel and Agent version lines separate`);
}
if (!/^\d+\.\d+\.\d+$/.test(androidAppVersion)) {
  errors.push(`ANDROID_APP_VERSION ${androidAppVersion} must use x.y.z format`);
}
if (errors.length) {
  console.error(errors.map((line) => `- ${line}`).join("\n"));
  process.exit(1);
}

console.log(`versions ok: panel=${appVersion} android=${androidAppVersion} agent=${agentVersion}`);
