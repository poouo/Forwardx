import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Router } from "express";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { agentTokens } from "../drizzle/schema";
import { getDb, withDatabaseTransaction } from "./dbRuntime";
import { createAgentToken, invalidateAgentAuthTokenCandidates } from "./repositories/tokenRepository";
import { getUserById } from "./repositories/userRepository";
import { getSetting, setSetting } from "./repositories/settingsRepository";
import { withKeyedTaskLock } from "./keyedTaskLock";
import { resolvePanelUrl } from "./agentPanelUrl";
import { getMigratedToPanelUrl } from "./panelMigrationAgentState";
import { managementAsset } from "./managementAssets";
import { pruneMapEntries, setBoundedMapValue } from "./boundedCache";

const SETTING = "agentDiscoveryConfig";
type DiscoveryConfig = { key: string; enabled: boolean; userId: number };

async function readConfig(): Promise<DiscoveryConfig | null> {
  const value = await getSetting(SETTING);
  if (!value) return null;
  const config = JSON.parse(value) as DiscoveryConfig;
  if (!/^[a-f0-9]{64}$/.test(config.key) || !Number.isInteger(config.userId)) throw new Error("Invalid discovery configuration");
  return config;
}

// Discovery keys only authorize enrollment. They never enter the Agent token
// table and cannot authenticate heartbeats, configuration pulls or reports.
export async function configureAgentDiscovery(userId: number, input: { enabled?: boolean; rotate?: boolean } = {}) {
  return withKeyedTaskLock(SETTING, async () => {
    let config = await readConfig();
    if (!config) config = { key: randomBytes(32).toString("hex"), enabled: true, userId };
    if (input.rotate) config = { ...config, key: randomBytes(32).toString("hex"), userId };
    if (input.enabled !== undefined) config.enabled = input.enabled;
    // Only an explicit enable/rotation transfers enrollment ownership.
    if (input.enabled === true) config.userId = userId;
    await setSetting(SETTING, JSON.stringify(config));
    return { enabled: config.enabled, key: config.key };
  });
}

export async function enrollDiscoveredAgent(key: string, registrationId: string, hostname: string) {
  if (!/^[a-f0-9]{64}$/.test(registrationId)) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid registration identity" });
  return withKeyedTaskLock(SETTING, async () => {
    const config = await readConfig();
    const hash = (value: string) => createHash("sha256").update(value).digest();
    if (!config?.enabled || !timingSafeEqual(hash(key), hash(config.key))) {
      throw new TRPCError({ code: "FORBIDDEN", message: "自动发现已关闭或接入密钥无效" });
    }
    const owner = await getUserById(config.userId);
    if (!owner || owner.role !== "admin" || owner.accountEnabled === false) {
      throw new TRPCError({ code: "FORBIDDEN", message: "自动发现的管理员账户不可用，请重新开启自动发现" });
    }
    const result = await withDatabaseTransaction(async () => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      // The random local registration identity survives failed installs and
      // lost responses. One identity always gets the same independent token.
      const existing = (await db.select().from(agentTokens)
        .where(eq(agentTokens.discoveryRegistrationId, registrationId)).limit(1))[0];
      if (existing) {
        if (existing.userId !== config.userId) throw new TRPCError({ code: "FORBIDDEN", message: "Registration identity belongs to another administrator" });
        return { token: existing.token };
      }
      const name = String(hostname || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
      const token = randomBytes(32).toString("hex");
      await createAgentToken({ token, userId: config.userId, discoveryRegistrationId: registrationId,
        description: name || `Agent-${registrationId.slice(0, 8)}` });
      return { token };
    });
    invalidateAgentAuthTokenCandidates();
    return result;
  });
}

export function registerAgentDiscoveryRoutes(router: Router) {
  const attempts = new Map<string, { at: number; count: number }>();
  router.get("/api/agent/discovery.sh", async (req, res, next) => {
    try {
      if (await getMigratedToPanelUrl()) { res.status(410).send("exit 1\n"); return; }
      const panel = await resolvePanelUrl(req);
      const quoted = `'${panel.replace(/'/g, "'\\''")}'`;
      res.setHeader("Cache-Control", "no-store");
      res.type("text/plain").send(`#!/bin/bash\nPANEL_URL_DEFAULT=${quoted}\n${managementAsset("agent-proxy.sh")}\n${managementAsset("agent-discovery.sh")}`);
    } catch (error) { next(error); }
  });
  router.post("/api/agent/discover", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      if (await getMigratedToPanelUrl()) { res.status(410).json({ error: "Panel migrated" }); return; }
      const now = Date.now();
      pruneMapEntries(attempts, (entry) => now - entry.at > 60_000);
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const entry = attempts.get(ip) || { at: now, count: 0 };
      entry.count++;
      setBoundedMapValue(attempts, ip, entry, 10_000);
      if (entry.count > 60) { res.setHeader("Retry-After", "60"); res.status(429).json({ error: "Too many enrollment requests" }); return; }
      const auth = String(req.headers.authorization || "");
      if (!/^Bearer [a-f0-9]{64}$/.test(auth)) { res.status(403).json({ error: "Invalid discovery key" }); return; }
      if (typeof req.body?.registrationId !== "string" || typeof req.body?.hostname !== "string" || req.body.hostname.length > 256) {
        res.status(400).json({ error: "Invalid enrollment request" }); return;
      }
      res.json(await enrollDiscoveredAgent(auth.slice(7), req.body.registrationId, req.body.hostname));
    } catch (error) {
      const status = error instanceof TRPCError ? (error.code === "BAD_REQUEST" ? 400 : 403) : 500;
      res.status(status).json({ error: error instanceof TRPCError ? error.message : "Agent enrollment failed" });
    }
  });
}
