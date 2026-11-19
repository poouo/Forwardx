import crypto from "crypto";
import { normalizeForwardRuleProtocol } from "@shared/forwardTypes";

type GostAuth = {
  username: string;
  password: string;
};

type GostComponent = {
  type: "forward" | "relay";
  auth?: GostAuth;
  metadata?: Record<string, unknown>;
};

function relayComponent(username: string, passwordSeed: string): GostComponent {
  return {
    type: "relay",
    auth: {
      username,
      password: crypto.createHash("sha256").update(passwordSeed).digest("hex"),
    },
    metadata: { nodelay: true },
  };
}

export function planGostTunnelHopRelay(input: {
  tunnelId: number;
  secretSeed: string;
}): GostComponent {
  const tunnelId = Math.max(0, Math.trunc(Number(input.tunnelId) || 0));
  return relayComponent(
    `fwx-hop-${tunnelId}`,
    `forwardx-gost-hop-relay:v1|${String(input.secretSeed || "")}|${tunnelId}`,
  );
}

export type GostTunnelRuleProtocolPlan = {
  protocol: "tcp" | "udp" | "both";
  entryNeedsTarget: boolean;
  chainConnector: GostComponent;
  exitHandler: GostComponent;
  exitTargetDialType: "tcp" | "udp" | null;
};

// The exit is a tunnel resource, not a rule resource. Keep its credentials
// stable as rules are added/removed so the shared listener need not restart.
// These credentials stay in managed Agent configs, never in user rule data.
export function planGostTunnelExitRelay(input: {
  tunnelId: number;
  secretSeed: string;
}): GostComponent {
  const tunnelId = Math.max(0, Math.trunc(Number(input.tunnelId) || 0));
  return relayComponent(
    `fwx-exit-${tunnelId}`,
    `forwardx-gost-exit-relay:v1|${String(input.secretSeed || "")}|${tunnelId}`,
  );
}

export function planGostTunnelRuleProtocol(input: {
  protocol: unknown;
  tunnelId: number;
  ruleId: number;
  secretSeed: string;
}): GostTunnelRuleProtocolPlan {
  const protocol = normalizeForwardRuleProtocol(input.protocol, "tcp");
  const tunnelId = Math.max(0, Math.trunc(Number(input.tunnelId) || 0));
  const component = planGostTunnelExitRelay({ tunnelId, secretSeed: input.secretSeed });

  return {
    protocol,
    entryNeedsTarget: true,
    chainConnector: component,
    exitHandler: component,
    exitTargetDialType: null,
  };
}
