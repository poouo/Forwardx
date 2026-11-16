import fs from "node:fs";
import { call } from "./api.mjs";
const H = JSON.parse(fs.readFileSync("hosts.json", "utf8"));
const TARGET = "172.30.0.20", TPORT = 9000;
const EXIT_IP = "172.30.0.13", RELAY_IP = "172.30.0.12";
const made = fs.existsSync("made.json") ? JSON.parse(fs.readFileSync("made.json", "utf8")) : { tunnels: {}, rules: [] };
const save = () => fs.writeFileSync("made.json", JSON.stringify(made, null, 1));
const log = (...a) => console.log(...a);

async function rule(name, extra) {
  if (made.rules.find((r) => r.name === name)) return;
  try {
    const res = await call("m", "rules.create", { name, protocol: "both", targetIp: TARGET, targetPort: TPORT, isEnabled: true, ...extra });
    made.rules.push({ name, id: res.id, port: res.sourcePort ?? extra.sourcePort, kind: extra.kind });
    log(`rule ok  ${name} id=${res.id} port=${res.sourcePort ?? extra.sourcePort}`);
  } catch (e) { log(`rule ERR ${name}: ${e.message.slice(0, 220)}`); }
  save();
}
async function tunnel(key, input) {
  if (made.tunnels[key]) return made.tunnels[key];
  try {
    const res = await call("m", "tunnels.create", { name: `T-${key}`, ...input });
    made.tunnels[key] = res.id ?? res; log(`tunnel ok  ${key} id=${made.tunnels[key]}`);
  } catch (e) { log(`tunnel ERR ${key}: ${e.message.slice(0, 220)}`); }
  save(); return made.tunnels[key];
}

// 1. Plain port forwarding on the entry host.
let port = 20001;
for (const ft of ["iptables", "nftables", "realm", "socat", "gost", "nginx"]) {
  delete globalThis.x;
  await rule(`P-${ft}`, { hostId: H.h1, forwardType: ft, sourcePort: port++, kind: `port/${ft}` });
}
// 2. Single-hop tunnels h1 -> h3.
const single = [
  ["fx-v1", { mode: "forwardx", forwardxVersion: "v1" }],
  ["fx-v2", { mode: "forwardx", forwardxVersion: "v2" }],
  ["fx-v3-tls", { mode: "forwardx", forwardxVersion: "v3", v3Transport: "tls", v3ServerName: "www.example.com", v3Multiplex: true }],
  ["fx-v3-ws", { mode: "forwardx", forwardxVersion: "v3", v3Transport: "ws", v3Path: "/ws", v3Host: "www.example.com", v3Multiplex: true }],
  ["fx-v3-http", { mode: "forwardx", forwardxVersion: "v3", v3Transport: "http", v3Host: "www.example.com", v3Multiplex: false }],
  ["gost-tls", { mode: "tls" }], ["gost-wss", { mode: "wss" }], ["gost-tcp", { mode: "tcp" }],
  ["gost-mtls", { mode: "mtls" }], ["gost-mwss", { mode: "mwss" }], ["gost-mtcp", { mode: "mtcp" }],
  ["nginx", { mode: "nginx_stream" }],
];
port = 21011;
for (const k of ["fx-v1","fx-v2","gost-tls","gost-wss","gost-tcp","gost-mtls","gost-mwss","gost-mtcp","nginx"]) if (made.tunnels[k]) single.splice(single.findIndex(([x]) => x === k), 1);
for (const [key, input] of single) {
  const id = await tunnel(key, { entryHostId: H.h1, exitHostId: H.h3, connectHost: EXIT_IP, ...input });
  if (id) await rule(`R-${key}`, { hostId: H.h1, tunnelId: id, forwardType: "gost", sourcePort: port, kind: `tunnel/${key}` });
  port++;
}
// 3. Multi-hop tunnels h1 -> h2 -> h3.
port = 22011;
for (const [key, input] of [["hop-fx-v1", { mode: "forwardx", forwardxVersion: "v1" }], ["hop-fx-v3", { mode: "forwardx", forwardxVersion: "v3", v3Transport: "tls", v3ServerName: "www.example.com", v3Multiplex: true }], ["hop-gost-tls", { mode: "tls" }]]) {
  const id = await tunnel(key, { entryHostId: H.h1, exitHostId: H.h3, hopHostIds: [H.h1, H.h2, H.h3], hopConnectHosts: [null, RELAY_IP, EXIT_IP], ...input });
  if (id) await rule(`R-${key}`, { hostId: H.h1, tunnelId: id, forwardType: "gost", sourcePort: port, kind: `multihop/${key}` });
  port++;
}
log(JSON.stringify(made.rules.map((r) => [r.name, r.id, r.port])));
