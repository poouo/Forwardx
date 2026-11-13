import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { assertIntegerForwardRulePorts } from "./repositories/forwardRuleRepository";

test("forward rule writers reject fractional and out-of-range ports", () => {
  assert.doesNotThrow(() => assertIntegerForwardRulePorts({ sourcePort: 0, targetPort: 443, gostRelayPort: null, tunnelExitPort: undefined, udpOverTcpPort: "8443" }));
  for (const data of [{ targetPort: 80.5 }, { sourcePort: 10000.25 }, { gostRelayPort: Number.NaN }, { tunnelExitPort: 65536 }, { udpOverTcpPort: -1 }, { targetPort: Number.POSITIVE_INFINITY }]) {
    assert.throws(() => assertIntegerForwardRulePorts(data), /整数/);
  }
});

test("port inputs are integers in every router schema and the install script route cannot reject", () => {
  for (const file of ["server/routers/rules.crud.ts", "server/routers/rules.ports.ts", "server/routers/tunnels.ts"]) {
    const source = fs.readFileSync(file, "utf8");
    const loose = source.split(/\r?\n/).filter((line) => /[pP]ort[A-Za-z]*: z\.number\(\)/.test(line) && !line.includes(".int()"));
    assert.deepEqual(loose, [], `${file} accepts a fractional port`);
  }
  const routes = fs.readFileSync("server/agentRoutes.ts", "utf8");
  const handler = routes.slice(routes.indexOf('agentRouter.get("/api/agent/install.sh"'), routes.indexOf('agentRouter.get("/api/agent/assets/'));
  assert.match(handler, /try \{[\s\S]+\} catch \(error\) \{[\s\S]+res\.status\(503\)/);
  assert.match(fs.readFileSync("server/index.ts", "utf8"), /process\.on\("unhandledRejection"/);
  assert.match(fs.readFileSync("server/routers/hosts.ts", "utf8"), /limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(1440\)/);
});

test("the Telegram bot answers only in private chats", () => {
  const source = fs.readFileSync("server/telegramBot.ts", "utf8");
  const handler = source.slice(source.indexOf("async function processTelegramUpdate"), source.indexOf("export async function processDiscordBotUpdate"));
  assert.match(handler, /chatType && chatType !== "private"[\s\S]+return;[\s\S]+handleMessage\(update\.message\)/, "group chats must be rejected before any command runs");
});
