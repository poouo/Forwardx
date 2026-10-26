import crypto from "node:crypto";

export const agentScenarios = {
  "few-dense": { hosts: 10, rulesPerHost: 300, services: 5, users: 20 },
  "many-medium": { hosts: 100, rulesPerHost: 30, services: 5, users: 50 },
  "many-scale": { hosts: 300, rulesPerHost: 20, services: 5, users: 100 },
};

export function rulesForHost(hostId, count) {
  return Array.from({ length: count }, (_, index) => ({
    id: (hostId - 1) * count + index + 1, port: 10000 + index,
    targetIp: "198.51.100.10", targetPort: 443, protocol: "tcp", forwardType: "realm",
  }));
}

export function runtimeStateForRules(rules) {
  const value = { rules: rules.map(rule => ({ ...rule, ruleId: rule.id, ready: true })), tunnels: [], services: [] };
  return { value, signature: crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex") };
}

export function serviceDefinitions(count = 5) {
  return Array.from({ length: count }, (_, index) => ({
    serviceId: index + 1, method: ["tcping", "ping", "url"][index % 3],
    targetIp: "198.51.100.20", targetPort: index % 3 === 0 ? 443 : 0,
    targetUrl: "https://198.51.100.20/health", timeoutSeconds: 5, expectedStatus: 200,
    intervalSeconds: 30,
  }));
}

export function serviceResult(service, hostId, cycle, churn = false) {
  const failed = churn && (hostId + cycle + service.serviceId) % 17 === 0;
  const key = crypto.createHash("sha256").update(`${service.targetUrl}\n${service.timeoutSeconds}\n${service.expectedStatus}`).digest("hex");
  return { serviceId: service.serviceId, method: service.method, targetIp: service.targetIp,
    targetPort: service.targetPort, latencyMs: failed ? null : 10 + hostId % 40,
    isTimeout: failed, probeCount: 3, probeSuccesses: failed ? 0 : 3,
    ...(service.method === "url" ? { probeKey: `service:${service.serviceId}:url:${key}` } : {}),
  };
}

const keys = new Map();
function tokenKeys(token) {
  if (!keys.has(token)) keys.set(token, Object.fromEntries([
    ["enc", "forwardx-agent-v1"], ["mac", "forwardx-agent-mac"],
    ["auth", "forwardx-agent-auth"], ["id", "forwardx-agent-auth-id"],
  ].map(([name, salt]) => [name, crypto.createHash("sha256").update(`${token}|${salt}`).digest()])));
  return keys.get(token);
}

function macInput(iv, ct, ts) {
  const time = Buffer.alloc(8); time.writeBigInt64BE(BigInt(ts));
  return Buffer.concat([Buffer.from("v1"), iv, ct, time]);
}

/** Exact v1 encrypted envelope plus signed proof; no raw-token auth shortcut. */
export function encryptedAgentRequest(token, route, payload) {
  const key = tokenKeys(token), iv = crypto.randomBytes(16), ts = Date.now();
  const cipher = crypto.createCipheriv("aes-256-ctr", key.enc, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const envelope = { v: 1, iv: iv.toString("hex"), ct: ct.toString("hex"), ts,
    mac: crypto.createHmac("sha256", key.mac).update(macInput(iv, ct, ts)).digest("hex") };
  const body = JSON.stringify(envelope), nonce = crypto.randomBytes(16).toString("hex");
  const hash = crypto.createHash("sha256").update(body).digest("hex");
  const proof = crypto.createHmac("sha256", key.auth).update(["v1", "POST", route, String(ts), nonce, hash].join("\n")).digest("hex");
  return { body, authorization: `Bearer v1.${key.id.toString("hex").slice(0, 32)}.${ts}.${nonce}.${proof}` };
}

export function decryptedAgentResponse(token, envelope) {
  if (envelope?.v !== 1) return envelope;
  const key = tokenKeys(token), iv = Buffer.from(envelope.iv, "hex"), ct = Buffer.from(envelope.ct, "hex");
  const mac = crypto.createHmac("sha256", key.mac).update(macInput(iv, ct, envelope.ts)).digest();
  const received = Buffer.from(envelope.mac, "hex");
  if (mac.length !== received.length || !crypto.timingSafeEqual(mac, received)) throw Error("Invalid encrypted response MAC");
  const decipher = crypto.createDecipheriv("aes-256-ctr", key.enc, iv);
  return JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8"));
}
