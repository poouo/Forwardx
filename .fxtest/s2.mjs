import { call } from "./api.mjs";
const out = {};
for (const name of ["h1-entry", "h2-relay", "h3-exit"]) {
  const created = await call("m", "agentTokens.create", { description: `fxtest ${name}` });
  const id = created?.id ?? created;
  const install = await call("q", "agentTokens.getInstallToken", { id: typeof id === "number" ? id : created.id });
  out[name] = install?.token ?? install;
}
console.log(JSON.stringify(out));
