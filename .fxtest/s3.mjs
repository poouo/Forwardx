import fs from "node:fs";
import { call } from "./api.mjs";
const settings = await call("q", "system.getSettings");
const protocols = { ...settings.forwardProtocols, nginx: true, nginx_stream: true };
await call("m", "system.updateSettings", { forwardProtocols: protocols });
const hosts = await call("q", "hosts.list");
const byName = {};
for (const h of hosts) {
  console.log(`host ${h.id} ${h.name} ip=${h.ip ?? h.ipAddress ?? ""} online=${h.isOnline ?? h.online} agent=${h.agentVersion ?? ""}`);
  const m = String(h.name || "").match(/(h[123])-/); if (m) byName[m[1]] = h.id;
}
console.log("hosts", JSON.stringify(byName));
fs.writeFileSync("hosts.json", JSON.stringify(byName));
